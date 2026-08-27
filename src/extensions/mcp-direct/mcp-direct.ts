import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import { resolve } from "path"
import { pathToFileURL } from "node:url"
import { z } from "zod"
import type {
   ResourceObject,
} from "../../runtime/resource.ts"
import type {
   ToolGuide,
   ToolName,
} from "../../runtime/tool.ts"
import type {
   GuardrailDecl,
   HookEntry,
   HookTrigger,
} from "../../blueprint/blueprint-schema.ts"
import {
   type ObjectManifest,
   type ObjectMeta,
   ObjectMetaSchema,
} from "../../blueprint/object-meta.ts"
import { type ObjectLoadContext, scheme } from "../../runtime/scheme.ts"
import type { AgentContext } from "../../runtime/context.ts"
import type { ActivityId } from "../../state/activity.ts"
import { AGENT_API_VERSION } from "../../blueprint/api-version.ts"
import { logger } from "../../system/logger.ts"
import { jsonSchemaObjectToZod } from "../mcp-deno-worker/schema.ts"

export const McpDirectSpecSchema = z
   .object({
      entry: z.string().min(1),
      export: z.string().min(1).default("default"),
   })
   .passthrough()

export type McpDirectSpec = z.infer<typeof McpDirectSpecSchema>

/**
 * McpDirectStatus — observed in-process link state. Populated by the system as
 * the module is imported and tools are listed; never present in the input
 * manifest.
 */
export interface McpDirectStatus {
   connected: boolean
   toolCount?: number
}

export const McpDirectManifestSchema = z
   .object({
      apiVersion: z.literal(AGENT_API_VERSION),
      kind: z.literal("McpDirect"),
      metadata: ObjectMetaSchema,
      spec: McpDirectSpecSchema,
   })
   .passthrough()

export type McpDirectManifest = z.infer<typeof McpDirectManifestSchema>

/**
 * Structural contract for the imported entry: satisfied by both `McpServer`
 * and the low-level `Server` of the MCP SDK, so the entry can export either.
 */
interface InProcessMcpServer {
   connect(transport: Transport): Promise<void>
   close(): Promise<void>
}

interface McpDirectFactoryContext {
   readonly sessionId: string
}

function isMcpServerLike(candidate: unknown): candidate is InProcessMcpServer {
   return (
      !!candidate &&
      typeof candidate === "object" &&
      typeof (candidate as any).connect === "function" &&
      typeof (candidate as any).close === "function"
   )
}

/**
 * Resolve `spec.entry` into a dynamic-import specifier. Filesystem paths
 * (relative or absolute) are anchored on the load cwd and turned into `file:`
 * URLs — Node's ESM loader rejects bare Windows paths. Anything else
 * (`file:`/`http(s):` URLs, bare package specifiers) is forwarded verbatim so
 * Node resolution applies.
 */
function resolveEntrySpecifier(entry: string, fallbackCwd: string): string {
   const isUrl = /^(file:|https?:)/.test(entry)
   const isAbsoluteFsPath =
      entry.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(entry)
   if (isUrl || (!entry.startsWith(".") && !isAbsoluteFsPath)) return entry
   return pathToFileURL(resolve(fallbackCwd, entry)).href
}

export class McpDirectObject implements ResourceObject {
   readonly apiVersion = AGENT_API_VERSION
   readonly kind = "McpDirect" as const
   readonly metadata: ObjectMeta
   readonly name: string
   readonly spec: McpDirectSpec
   status: McpDirectStatus = { connected: false }
   private client: Client | null = null
   private server: InProcessMcpServer | null = null
   private transport: InMemoryTransport | null = null
   private toolsCache: ToolGuide[] = []
   private readonly cwd: string
   private readonly factoryContext: McpDirectFactoryContext

   constructor(
      metadata: ObjectMeta,
      spec: McpDirectSpec,
      fallbackCwd: string,
      factoryContext: McpDirectFactoryContext,
   ) {
      this.metadata = metadata
      this.name = metadata.name
      this.spec = spec
      this.cwd = fallbackCwd
      this.factoryContext = factoryContext
   }

   get entry(): string {
      return this.spec.entry
   }

   /** Lazily import the entry, link it in-process, and refresh the tool cache. */
   private async ensureConnected(): Promise<Client> {
      if (this.client) return this.client

      const specifier = resolveEntrySpecifier(this.spec.entry, this.cwd)
      let mod: any
      try {
         mod = await import(specifier)
      } catch (err) {
         throw new Error(
            `McpDirect "${this.name}": failed to import entry "${this.spec.entry}"` +
               ` (resolved: ${specifier}): ${err instanceof Error ? err.message : String(err)}`,
         )
      }

      const exportName = this.spec.export ?? "default"
      const exported = mod?.[exportName]
      if (exported === undefined) {
         throw new Error(
            `McpDirect "${this.name}": entry "${this.spec.entry}" has no export named "${exportName}".`,
         )
      }

      // A function export is treated as a factory returning the server: the
      // ESM module cache is per-process, so a factory is the only way two
      // McpDirect resources (or a reload) can each get a fresh, unconnected
      // instance from the same entry.
      const server = typeof exported === "function" ? await exported(this.factoryContext) : exported
      if (!isMcpServerLike(server)) {
         throw new Error(
            `McpDirect "${this.name}": export "${exportName}" of "${this.spec.entry}" is not an MCP server instance` +
               ` (expected an McpServer or a factory returning one).`,
         )
      }

      // Linked in-memory pair: client and server exchange JSON-RPC messages by
      // reference within this process — no subprocess, socket, or wire
      // serialization. This is as close to "direct" as the SDK contract allows.
      // Both sides must connect CONCURRENTLY: the Client sends its
      // `initialize` request inside connect(), which lands in the server
      // transport's pre-start queue — awaiting the client first would
      // deadlock until the request timeout.
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

      this.client = new Client(
         { name: `agent-harness-${this.name}`, version: "1.0.0" },
         { capabilities: {} },
      )

      await Promise.all([
         this.client.connect(clientTransport),
         server.connect(serverTransport),
      ])
      this.server = server
      this.transport = clientTransport

      await this.refreshTools()
      this.status = { connected: true, toolCount: this.toolsCache.length }
      return this.client
   }

   private async refreshTools(): Promise<void> {
      if (!this.client) return
      const result = await this.client.listTools()
      this.toolsCache = result.tools.map((tool) => {
         const inputSchema = (tool as any).inputSchema ?? {
            type: "object",
            properties: {},
         }
         return {
            name: `${this.name}__${tool.name}`,
            intent: tool.description ?? "",
            input: jsonSchemaObjectToZod(inputSchema),
         } as ToolGuide
      })
   }

   getTools(): ToolGuide[] {
      return this.toolsCache
   }

   getHooks(_trigger: HookTrigger): HookEntry[] {
      return []
   }

   getGuardrails(): GuardrailDecl[] {
      return []
   }

   toManifest(): ObjectManifest {
      return {
         apiVersion: this.apiVersion,
         kind: this.kind,
         metadata: this.metadata,
         spec: this.spec,
      }
   }

   static async fromManifest(
      manifest: McpDirectManifest,
      ctx: ObjectLoadContext,
   ): Promise<McpDirectObject> {
      const factoryContext: McpDirectFactoryContext = {
         get sessionId() {
            return ctx.session.sessionId
         },
      }
      const obj = new McpDirectObject(manifest.metadata, manifest.spec, ctx.cwd, factoryContext)
       // Eagerly link at session instantiation — same contract as McpStdio: a
       // missing entry, a bad export, or a broken module surfaces here
       // (pointing at this resource), not later when a tool call first runs.
      await obj["ensureConnected"]()
      return obj
   }

   async applyTool(
      toolName: ToolName,
      params: Record<string, any>,
      context: AgentContext,
      deliveryId?: ActivityId,
   ): Promise<string | undefined> {
      const client = await this.ensureConnected()

      const name = toolName.startsWith(`${this.name}__`)
         ? toolName.slice(this.name.length + 2)
         : toolName

      let result: any
      let isError = false
      try {
         const raw = await client.callTool({
            name,
            arguments: params,
         })
         isError = (raw as any).isError === true
         const content = (raw as any).content
         if (Array.isArray(content)) {
            const texts = content
               .filter((c: any) => c.type === "text")
               .map((c: any) => c.text)
            result = texts.length > 0 ? texts.join("\n") : content
         } else {
            result = content ?? raw
         }
      } catch (err) {
         isError = true
         result = { error: err instanceof Error ? err.message : String(err) }
         logger.warn(
            { tool: name, err: (err as Error).message },
            "McpDirect.callTool failed",
         )
      }

      context.deliver(deliveryId, result, isError)
      return undefined
   }

   async close(): Promise<void> {
      try {
         if (this.client) await this.client.close?.()
      } catch {}
      try {
         if (this.transport) await this.transport.close()
      } catch {}
      try {
         if (this.server) await this.server.close()
      } catch {}
      this.client = null
      this.transport = null
      this.server = null
      this.toolsCache = []
      this.status = { connected: false }
   }
}

scheme.register({
   apiVersion: AGENT_API_VERSION,
   kind: "McpDirect",
   manifestSchema: McpDirectManifestSchema,
   factory: McpDirectObject.fromManifest,
   metadata: {
      role: "Source d'outils MCP in-process : import dynamique d'un point d'entrée TypeScript qui expose l'instance du serveur, sans sous-processus ni transport réseau.",
       surface: "Permanent (lien in-process établi à l'instanciation de session)",
      example: `apiVersion: agent/v1
kind: McpDirect
metadata:
  name: wynsure_insurance
  labels: { app: subscription }
spec:
  entry: packages/my-mcp-server/src/server.ts
  export: default`,
      notes: [
         "L'entry doit exposer un serveur MCP non connecté (instance ou factory) : `McpServer`/`Server` du SDK, export par défaut ou nommé via `spec.export`.",
         "Un export fonction est appelé comme factory (`() => McpServer`) — requis pour charger deux fois la même entry (cache module ESM).",
         "Communication via paire InMemoryTransport : messages échangés par référence dans le process, zéro spawn/socket/sérialisation wire.",
         "Le chargement du TypeScript dépend du loader du process hôte (Node avec type stripping, tsx, Vite SSR dev…).",
         "Tools publiés préfixés : `<name>__<tool>`.",
      ],
      fieldDocs: {
         "spec.entry": "Point d'entrée du module serveur : chemin (relatif au cwd du blueprint ou absolu), URL `file:`/`http(s):`, ou specifier de package.",
         "spec.export": "Nom de l'export portant le serveur ou sa factory (défaut : `default`).",
      },
   },
})
