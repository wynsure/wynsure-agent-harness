import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { resolve } from "path"
import { pathToFileURL } from "node:url"
import { z } from "zod"
import {
    type Blueprint,
    type ResourceObject,
    type ToolGuide,
    type ToolName,
    type GuardrailDecl,
    type HookEntry,
    type HookTrigger,
} from "../../blueprint/blueprint.ts"
import {
    type ObjectManifest,
    type ObjectMeta,
    type ObjectLoadContext,
    scheme,
    ObjectMetaSchema,
} from "../../blueprint/object-meta.ts"
import type { AgentContext } from "../../runtime/context.ts"
import type { ActivityId } from "../../state/activity.ts"
import { AGENT_API_VERSION } from "../../blueprint/api-version.ts"
import { logger } from "../../system/logger.ts"

import {
    type InterWorkerChannel,
    type DenoPermissionsObject,
    detectRuntime,
    WorkerChannel,
    denoPermissionsObject,
    isRemoteEntrypoint,
} from "./channel.ts"
import { jsonSchemaObjectToZod } from "./schema.ts"

export const McpDenoWorkerSpecSchema = z
    .object({
        entrypoint: z.string().min(1),
        allow: z.array(z.string()).default([]),
        env: z.array(z.string()).default([]),
        handshakeTimeoutMs: z.number().int().positive().default(15000),
    })
    .passthrough()

export type McpDenoWorkerSpec = z.infer<typeof McpDenoWorkerSpecSchema>

/**
 * McpDenoWorkerStatus — observed connection state after `fromManifest`. Populated
 * by the system as the worker connects and lists tools; never present in the
 * input manifest. `workerId` is a stable per-worker identifier; there is no
 * `pid` (the worker is not a subprocess from the harness' point of view).
 */
export interface McpDenoWorkerStatus {
    connected: boolean
    workerId?: string
    toolCount: number
}

export const McpDenoWorkerManifestSchema = z
    .object({
        apiVersion: z.literal(AGENT_API_VERSION),
        kind: z.literal("McpDenoWorker"),
        metadata: ObjectMetaSchema,
        spec: McpDenoWorkerSpecSchema,
    })
    .passthrough()

export type McpDenoWorkerManifest = z.infer<typeof McpDenoWorkerManifestSchema>

export class McpDenoWorkerObject implements ResourceObject {
    readonly apiVersion = AGENT_API_VERSION
    readonly kind = "McpDenoWorker" as const
    readonly metadata: ObjectMeta
    readonly name: string
    readonly spec: McpDenoWorkerSpec
    status: McpDenoWorkerStatus = { connected: false, toolCount: 0 }
    private client: Client | null = null
    private channel: InterWorkerChannel | null = null
    private toolsCache: ToolGuide[] = []
    private readonly fallbackCwd: string

    constructor(metadata: ObjectMeta, spec: McpDenoWorkerSpec, fallbackCwd: string) {
        this.metadata = metadata
        this.name = metadata.name
        this.spec = spec
        this.fallbackCwd = fallbackCwd
    }

    /** Lazily connect to the worker and refresh the tool cache. */
    private async ensureConnected(): Promise<Client> {
        if (this.client) return this.client

        // Runtime firewall: at factory time we already refused non-Deno
        // parents; this assertion belt-and-braces `ensureConnected` if the
        // object is constructed by other means (e.g. unit tests).
        if (detectRuntime() !== "deno") {
            throw new Error(
                `McpDenoWorker "${this.name}" requires a Deno parent runtime. ` +
                "Run the harness via `deno run`.",
            )
        }

        const specifier = resolveWorkerSpecifier(this.spec.entrypoint, this.fallbackCwd)
        const permissions = denoPermissionsObject(this.spec.allow, this.spec.env)

        this.channel = new WorkerChannel({
            specifier,
            permissions,
            handshakeTimeoutMs: this.spec.handshakeTimeoutMs ?? 15000,
            channelId: `${this.name}#deno-worker`,
        })

        this.client = new Client(
            { name: `agent-harness-${this.name}`, version: "1.0.0" },
            { capabilities: {} },
        )

        await this.client.connect(this.channel)
        await this.refreshTools()
        this.status = {
            connected: true,
            workerId: this.channel.channelId,
            toolCount: this.toolsCache.length,
        }
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
        manifest: McpDenoWorkerManifest,
        ctx: ObjectLoadContext,
    ): Promise<McpDenoWorkerObject> {
        // Fail-fast firewall: refuse to construct under a non-Deno parent.
        // The error points at this resource so the load log is actionable.
        if (detectRuntime() !== "deno") {
            throw new Error(
                `McpDenoWorker "${manifest.metadata.name}" requires a Deno parent runtime. ` +
                "Run the harness via `deno run`; there is no fallback transport in v1.",
            )
        }
        const obj = new McpDenoWorkerObject(manifest.metadata, manifest.spec, ctx.cwd)
        // Eagerly connect at load time — same contract as McpStdio. A missing
        // entrypoint, a bad specifier, or a missing handshake surfaces here
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
            logger.warn({ tool: name, err: (err as Error).message }, "McpDenoWorker.callTool failed")
        }

        context.deliver(deliveryId, result, isError)
        return undefined
    }

    async close(): Promise<void> {
        try {
            if (this.client) await this.client.close?.()
        } catch {}
        try {
            if (this.channel) await this.channel.close()
        } catch {}
        this.client = null
        this.channel = null
        this.status = { connected: false, toolCount: 0 }
    }
}

/**
 * Resolve the worker specifier for `new Worker`. Deno's Web Worker API accepts
 * either an absolute `file:` URL or a module specifier (file URL/`npm:`/`jsr:`/
 * `http(s):`). Relative filesystem paths must be turned into a `file:` URL.
 * `node:url` is available on both Node and Deno (Deno's Node-compat exposes
 * it natively), so a static import is safe here.
 */
function resolveWorkerSpecifier(entrypoint: string, fallbackCwd: string): string {
    if (isRemoteEntrypoint(entrypoint)) return entrypoint
    const abs = resolve(fallbackCwd, entrypoint)
    return pathToFileURL(abs).href
}

scheme.register({
    apiVersion: AGENT_API_VERSION,
    kind: "McpDenoWorker",
    manifestSchema: McpDenoWorkerManifestSchema,
    factory: McpDenoWorkerObject.fromManifest,
    metadata: {
        role: "Source d'outils MCP dans un worker Deno isolé, via Worker API (canal postMessage).",
        surface: "Permanent (connexion persistante au load) — Deno parent requis",
        example: `apiVersion: agent/v1
kind: McpDenoWorker
metadata:
  name: mailer
  labels: { provider: mailer }
spec:
  entrypoint: ./mailer/mod.ts
  allow: ["net=127.0.0.1", "write=./outbox"]
  env: ["SMTP_HOST", "SMTP_PORT", "MAIL_FROM"]`,
        notes: [
            "Refuse de fonctionner hors d'un parent Deno : pas de fallback transport en v1.",
            "Connexion établie au load (fail-fast si le worker ne s'annonce pas).",
            "Tools publiés préfixés : `<name>__<tool>`.",
            "Environnement worker vide par défaut ; seul `spec.env` autorise la lecture (allowlist restrictive).",
        ],
        fieldDocs: {
            "spec.entrypoint": "Module Deno chargé via `new Worker` (chemin relatif au blueprint, absolu, ou URL distante http(s)/file/npm/jsr).",
            "spec.allow": "Permissions Deno (`net=127.0.0.1`, `write=./outbox`). Bare (`env`) ou `<cap>=<value>`.",
            "spec.env": "Allowlist des variables d'environnement lisibles (Deno `permissions.env`). Vide par défaut → env interdit.",
            "spec.handshakeTimeoutMs": "Délai max d'attente du signal `MCP-READY` du worker (défaut 15000).",
        },
    },
})