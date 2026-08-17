// McpDirect extension — publishes a `<name>__<tool>` surface driven by an MCP
// server instance living in the harness process itself: the blueprint names a
// TypeScript entry point, the resource imports it dynamically, grabs the
// exported server (instance or factory), and links it to its Client through a
// paired in-memory transport — no subprocess, no socket, no wire format.
export {
   McpDirectObject,
   McpDirectSpecSchema,
   McpDirectManifestSchema,
} from "./mcp-direct.ts"
export type {
   McpDirectSpec,
   McpDirectStatus,
   McpDirectManifest,
} from "./mcp-direct.ts"
