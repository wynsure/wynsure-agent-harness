import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { z, type ZodTypeAny } from "zod"
import {
   type Blueprint,
   type ResourceObject,
   type ToolGuide,
   type ToolOutcome,
   type GuardrailDecl,
   type HookEntry,
   type HookTrigger,
} from "../blueprint.ts"
import {
   type ObjectManifest,
   type ObjectMeta,
   type ObjectLoadContext,
   scheme,
   ObjectMetaSchema,
} from "../object-meta.ts"
import type { AgentContext } from "../context.ts"
import { AGENT_API_VERSION } from "./agent.ts"

export const McpStdioSpecSchema = z
   .object({
      command: z.string(),
      args: z.array(z.string()).default([]),
      cwd: z.string().optional(),
   })
   .passthrough()

export type McpStdioSpec = z.infer<typeof McpStdioSpecSchema>

/**
 * McpStdioStatus — observed connection state. Populated by the system as the
 * transport connects and lists tools; never present in the input manifest.
 */
export interface McpStdioStatus {
   connected: boolean
   toolCount?: number
}

export const McpStdioManifestSchema = z
   .object({
      apiVersion: z.literal(AGENT_API_VERSION),
      kind: z.literal("McpStdio"),
      metadata: ObjectMetaSchema,
      spec: McpStdioSpecSchema,
   })
   .passthrough()

export type McpStdioManifest = z.infer<typeof McpStdioManifestSchema>

function jsonSchemaPropToZod(prop: any): ZodTypeAny {
   if (!prop || typeof prop !== "object") return z.any()
   switch (prop.type) {
      case "string":
         return z.string()
      case "number":
      case "integer":
         return z.number()
      case "boolean":
         return z.boolean()
      case "array":
         return z.array(jsonSchemaPropToZod(prop.items))
      default:
         return z.any()
   }
}

function jsonSchemaPropertiesToZodShape(
   properties: Record<string, any> | undefined,
): Record<string, ZodTypeAny> {
   const shape: Record<string, ZodTypeAny> = {}
   if (!properties) return shape
   for (const [key, val] of Object.entries(properties)) {
      shape[key] = jsonSchemaPropToZod(val)
   }
   return shape
}

export class McpStdioObject implements ResourceObject {
   readonly apiVersion = AGENT_API_VERSION
   readonly kind = "McpStdio" as const
   readonly metadata: ObjectMeta
   readonly name: string
   readonly spec: McpStdioSpec
   status: McpStdioStatus = { connected: false }
   private client: Client | null = null
   private transport: StdioClientTransport | null = null
   private toolsCache: ToolGuide[] = []
   private readonly cwd: string

   constructor(metadata: ObjectMeta, spec: McpStdioSpec, fallbackCwd: string) {
      this.metadata = metadata
      this.name = metadata.name
      this.spec = spec
      this.cwd = spec.cwd ?? fallbackCwd
   }

   get command(): string {
      return this.spec.command
   }

   get args(): string[] {
      return this.spec.args ?? []
   }

   /** Lazily connect to the stdio transport and refresh the tool cache. */
   private async ensureConnected(): Promise<Client> {
      if (this.client) return this.client

      this.transport = new StdioClientTransport({
         command: this.spec.command,
         args: this.spec.args ?? [],
         cwd: this.cwd,
         stderr: "pipe",
      })

      this.client = new Client(
         { name: `agent-harness-${this.name}`, version: "1.0.0" },
         { capabilities: {} },
      )

      await this.client.connect(this.transport)

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
            input: z.object(
               jsonSchemaPropertiesToZodShape(inputSchema.properties),
            ),
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
      manifest: McpStdioManifest,
      ctx: ObjectLoadContext,
   ): Promise<McpStdioObject> {
      const obj = new McpStdioObject(manifest.metadata, manifest.spec, ctx.cwd)
      // Eagerly connect at load time (preserves existing behavior): the tool
      // surface is part of the blueprint's collectible tools and must be ready
      // before the first completion call.
      await obj["ensureConnected"]()
      return obj
   }

   async applyTool(
      id: string,
      params: Record<string, any>,
      _context: AgentContext,
      _toolUseId?: string,
   ): Promise<ToolOutcome | undefined> {
      const client = await this.ensureConnected()

      const toolName = id.startsWith(`${this.name}__`)
         ? id.slice(this.name.length + 2)
         : id

      const result = await client.callTool({
         name: toolName,
         arguments: params,
      })

      const isError = (result as any).isError === true

      let resultContent: any
      const content = (result as any).content
      if (Array.isArray(content)) {
         const texts = content
            .filter((c: any) => c.type === "text")
            .map((c: any) => c.text)
         resultContent = texts.length > 0 ? texts.join("\n") : content
      } else {
         resultContent = content ?? result
      }

      return { result: resultContent, isError }
   }

   async close(): Promise<void> {
      if (this.transport) {
         await this.transport.close()
         this.transport = null
      }
      this.client = null
      this.status = { connected: false }
   }
}

scheme.register({
   apiVersion: AGENT_API_VERSION,
   kind: "McpStdio",
   manifestSchema: McpStdioManifestSchema,
   factory: McpStdioObject.fromManifest,
   metadata: {
      role: "Source d'outils MCP via transport stdio ; connexion persistante.",
      surface: "Permanent (connexion persistante)",
      example: `apiVersion: agent/v1
kind: McpStdio
metadata:
  name: recipe_db
  labels: { app: recipes }
spec:
  command: npx
  args: ["-y", "@example/recipe-mcp-server"]
  cwd: .`,
      notes: [
         "Connexion établie au load (fail-fast si le daemon ne répond pas).",
         "Tools publiés préfixés : `<name>__<tool>`.",
      ],
      fieldDocs: {
         "spec.command": "Commande exécutée pour le transport stdio.",
         "spec.args": "Arguments passés à la commande.",
         "spec.cwd": "Répertoire de travail du sous-processus.",
      },
   },
})
