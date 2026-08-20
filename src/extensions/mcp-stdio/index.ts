// McpStdio extension — publishes a `<name>__<tool>` surface driven by an MCP
// stdio transport. Connection is established eagerly at session instantiation.
import "./mcp-stdio.ts"

export {
   McpStdioObject,
   McpStdioSpecSchema,
   McpStdioManifestSchema,
} from "./mcp-stdio.ts"
export type {
   McpStdioSpec,
   McpStdioStatus,
   McpStdioManifest,
} from "./mcp-stdio.ts"
