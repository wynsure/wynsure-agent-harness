// McpServer extension — publishes a `<name>__<tool>` surface driven by an MCP
// client over a remote HTTP transport (Streamable HTTP with SSE fallback).
// Connection is established eagerly at load, mirroring McpStdio / McpDenoWorker.
// Auth: `none` | `apiKey` (bearer) | `oauth` (client_credentials). Connection
// fields support `{{env.*}}` templates resolved against the process env.
import "./mcp-server.ts"

export {
    McpServerObject,
    McpServerSpecSchema,
    McpServerManifestSchema,
    AuthSchema as McpServerAuthSchema,
} from "./mcp-server.ts"
export type {
    McpServerSpec,
    McpServerStatus,
    McpServerManifest,
    McpServerAuth,
} from "./mcp-server.ts"
export {
    ClientCredentialsOAuthProvider,
    type ClientCredentialsOptions,
} from "./oauth-provider.ts"
