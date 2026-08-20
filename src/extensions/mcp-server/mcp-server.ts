import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"
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
import { renderTemplate } from "../../blueprint/scripting.ts"
import type { AgentContext } from "../../runtime/context.ts"
import type { ActivityId } from "../../state/activity.ts"
import { AGENT_API_VERSION } from "../../blueprint/api-version.ts"
import { logger } from "../../system/logger.ts"
import { jsonSchemaObjectToZod } from "../mcp-deno-worker/schema.ts"
import { ClientCredentialsOAuthProvider } from "./oauth-provider.ts"

/**
 * `McpServerSpec.auth` — discriminated union on `type`. `none` is the default
 * (anonymous server). `apiKey` sends a static header on every request
 * (`Authorization: Bearer` by default, override with `headerName`).
 * `oauth` runs the OAuth 2.0 `client_credentials` grant against `tokenEndpoint`
 * at connection time and lets the SDK refresh it on `UnauthorizedError`.
 *
 * Every string field that carries a credential or an endpoint is a
 * `{{expr}}` template resolved at connection time against a scope that
 * exposes `env` (the process environment). The raw templates stay in the
 * stored spec so `toManifest()` never leaks resolved secrets.
 */
const NoneAuthSchema = z.object({ type: z.literal("none") }).passthrough()

const ApiKeyAuthSchema = z
    .object({
        type: z.literal("apiKey"),
        token: z.string().min(1),
        headerName: z.string().min(1).optional(),
    })
    .passthrough()

const OAuthAuthSchema = z
    .object({
        type: z.literal("oauth"),
        clientId: z.string().min(1),
        clientSecret: z.string().min(1),
        tokenEndpoint: z.string().min(1),
        scope: z.string().optional(),
    })
    .passthrough()

export const AuthSchema = z
    .discriminatedUnion("type", [NoneAuthSchema, ApiKeyAuthSchema, OAuthAuthSchema])
    .default({ type: "none" })

export type McpServerAuth = z.infer<typeof AuthSchema>

export const McpServerSpecSchema = z
    .object({
        endpoint: z.string().min(1),
        auth: AuthSchema,
    })
    .passthrough()

export type McpServerSpec = z.infer<typeof McpServerSpecSchema>

/**
 * `McpServerStatus` — observed connection state. Populated by the system as
 * the transport connects and lists tools; never present in the input manifest.
 * `transport` reports which wire protocol won (useful since streamable HTTP
 * silently falls back to SSE on legacy servers).
 */
export interface McpServerStatus {
    connected: boolean
    transport?: "streamableHttp" | "sse"
    toolCount?: number
}

export const McpServerManifestSchema = z
    .object({
        apiVersion: z.literal(AGENT_API_VERSION),
        kind: z.literal("McpServer"),
        metadata: ObjectMetaSchema,
        spec: McpServerSpecSchema,
    })
    .passthrough()

export type McpServerManifest = z.infer<typeof McpServerManifestSchema>

/**
 * Read the process environment as a plain string map. `process.env` values
 * are `string | undefined`; the templating scope accepts that, but narrowing
 * here keeps the type honest and avoids leaking non-string entries.
 */
function readEnvScope(): Record<string, string | undefined> {
    return typeof process !== "undefined" && process.env ? { ...process.env } : {}
}

/**
 * Resolve `{{expr}}` placeholders in a connection field against the env scope.
 * Strings without `{{` skip the parser entirely (the common case).
 */
function renderConnField(value: string, env: Record<string, string | undefined>): string {
    if (!value.includes("{{")) return value
    return renderTemplate(value, { env })
}

export class McpServerObject implements ResourceObject {
    readonly apiVersion = AGENT_API_VERSION
    readonly kind = "McpServer" as const
    readonly metadata: ObjectMeta
    readonly name: string
    readonly spec: McpServerSpec
    status: McpServerStatus = { connected: false }
    private client: Client | null = null
    private transport: StreamableHTTPClientTransport | SSEClientTransport | null = null
    private toolsCache: ToolGuide[] = []

    constructor(metadata: ObjectMeta, spec: McpServerSpec) {
        this.metadata = metadata
        this.name = metadata.name
        this.spec = spec
    }

    /**
     * Lazily connect to the remote MCP server and refresh the tool cache.
     * Tries Streamable HTTP first; on connection failure, retries with the
     * deprecated SSE transport so legacy servers keep working without a
     * blueprint change.
     */
    private async ensureConnected(): Promise<Client> {
        if (this.client) return this.client

        const env = readEnvScope()
        const endpoint = renderConnField(this.spec.endpoint, env)
        const url = new URL(endpoint)

        try {
            await this.connectStreamableHttp(url, env)
            this.status.transport = "streamableHttp"
        } catch (streamableErr) {
            logger.debug(
                { name: this.name, err: (streamableErr as Error).message },
                "McpServer: streamable HTTP failed, falling back to SSE",
            )
            await this.connectSse(url, env)
            this.status.transport = "sse"
        }

        await this.refreshTools()
        this.status = {
            connected: true,
            transport: this.status.transport,
            toolCount: this.toolsCache.length,
        }
        return this.client
    }

    private async connectStreamableHttp(url: URL, env: Record<string, string | undefined>): Promise<void> {
        const transport = new StreamableHTTPClientTransport(url, this.buildTransportOptions(env))
        const client = new Client(
            { name: `agent-harness-${this.name}`, version: "1.0.0" },
            { capabilities: {} },
        )
        try {
            await client.connect(transport)
        } catch (err) {
            try { await transport.close() } catch {}
            throw err
        }
        this.transport = transport
        this.client = client
    }

    private async connectSse(url: URL, env: Record<string, string | undefined>): Promise<void> {
        const transport = new SSEClientTransport(url, this.buildTransportOptions(env))
        const client = new Client(
            { name: `agent-harness-${this.name}`, version: "1.0.0" },
            { capabilities: {} },
        )
        try {
            await client.connect(transport)
        } catch (err) {
            try { await transport.close() } catch {}
            throw err
        }
        this.transport = transport
        this.client = client
    }

    /**
     * Translate the resolved `auth` into MCP SDK transport options. For
     * `apiKey`, a static `Authorization: Bearer ...` header is attached via
     * `requestInit`. For `oauth`, a `ClientCredentialsOAuthProvider` is
     * supplied; the SDK runs the grant at `start()`.
     */
    private buildTransportOptions(env: Record<string, string | undefined>):
        | { requestInit?: RequestInit; authProvider?: ClientCredentialsOAuthProvider } {
        const auth = this.spec.auth
        if (auth.type === "none") return {}
        if (auth.type === "apiKey") {
            const token = renderConnField(auth.token, env)
            const headerName = auth.headerName
                ? renderConnField(auth.headerName, env)
                : undefined
            const headers: Record<string, string> = headerName
                ? { [headerName]: token }
                : { Authorization: `Bearer ${token}` }
            return { requestInit: { headers } }
        }
        const provider = new ClientCredentialsOAuthProvider({
            clientId: renderConnField(auth.clientId, env),
            clientSecret: renderConnField(auth.clientSecret, env),
            tokenEndpoint: renderConnField(auth.tokenEndpoint, env),
            ...(auth.scope ? { scope: renderConnField(auth.scope, env) } : {}),
        })
        return { authProvider: provider }
    }

    private async refreshTools(): Promise<void> {
        if (!this.client) return
        const result = await this.client.listTools()
        this.toolsCache = result.tools.map((tool) => {
            const inputSchema = (tool as any).inputSchema ?? { type: "object", properties: {} }
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
        // Returns the spec with raw `{{env.*}}` templates intact — resolved
        // secrets never leave the live object.
        return {
            apiVersion: this.apiVersion,
            kind: this.kind,
            metadata: this.metadata,
            spec: this.spec,
        }
    }

    static async fromManifest(
        manifest: McpServerManifest,
        _ctx: ObjectLoadContext,
    ): Promise<McpServerObject> {
        const obj = new McpServerObject(manifest.metadata, manifest.spec)
        // Eagerly connect at session instantiation — same contract as
        // McpStdio and McpDenoWorker. Bad endpoint, missing credentials or a
        // server that speaks neither transport surfaces here, not on the
        // first tool call.
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
            const raw = await client.callTool({ name, arguments: params })
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
            logger.warn({ tool: name, err: (err as Error).message }, "McpServer.callTool failed")
        }

        context.deliver(deliveryId, result, isError)
        return undefined
    }

    async close(): Promise<void> {
        try {
            if (this.client) await (this.client as any).close?.()
        } catch {}
        try {
            if (this.transport) await this.transport.close()
        } catch {}
        this.client = null
        this.transport = null
        this.status = { connected: false }
    }
}

scheme.register({
    apiVersion: AGENT_API_VERSION,
    kind: "McpServer",
    manifestSchema: McpServerManifestSchema,
    factory: McpServerObject.fromManifest,
    metadata: {
        role: "Source d'outils MCP exposés par un serveur distant (Streamable HTTP, fallback SSE).",
        surface: "Permanent (connexion persistante, une par session)",
        example: `apiVersion: agent/v1
kind: McpServer
metadata:
  name: crm
  labels: { app: sales }
spec:
  endpoint: https://mcp.example.com/mcp
  auth:
    type: apiKey
    token: "{{env.CRM_API_KEY}}"`,
        notes: [
            "Connexion établie à l'instanciation de session (fail-fast si le serveur ne répond pas) ; une connexion par session.",
            "Tente Streamable HTTP puis retombe sur SSE automatiquement ; `status.transport` indique lequel a réussi.",
            "Auth `none` (défaut), `apiKey` ( bearer `Authorization: Bearer <token>`) ou `oauth` (`client_credentials`).",
            "Chaque champ de connexion (`endpoint`, `auth.token`, `auth.clientId`, `auth.clientSecret`, `auth.tokenEndpoint`, `auth.scope`) est un template `{{env.VAR}}` résolu à l'instanciation de session ; le spec stocké garde les templates intacts.",
            "Tools publiés préfixés : `<name>__<tool>`.",
        ],
        fieldDocs: {
            "spec.endpoint": "URL du endpoint MCP du serveur distant. Template `{{env.*}}` supporté.",
            "spec.auth": "Authentification : `none` (défaut), `apiKey` ou `oauth` (discriminé sur `type`).",
            "spec.auth.type": "Discriminant d'authentification (`none` | `apiKey` | `oauth`).",
            "spec.auth.token": "Token envoyé dans le header (bearer par défaut, ou brut si `headerName` est défini). Template `{{env.*}}` supporté.",
            "spec.auth.headerName": "Nom du header HTTP (défaut `Authorization` avec préfixe `Bearer`). Utile pour APIM (`Ocp-Apim-Subscription-Key`). Template `{{env.*}}` supporté.",
            "spec.auth.clientId": "Identifiant client OAuth (grant `client_credentials`). Template `{{env.*}}` supporté.",
            "spec.auth.clientSecret": "Secret client OAuth. Template `{{env.*}}` supporté.",
            "spec.auth.tokenEndpoint": "URL du endpoint de token OAuth. Template `{{env.*}}` supporté.",
            "spec.auth.scope": "Scope OAuth optionnel (chaîne séparée par espaces). Template `{{env.*}}` supporté.",
        },
    },
})
