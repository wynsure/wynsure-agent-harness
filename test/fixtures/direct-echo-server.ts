/**
 * Fixture for the McpDirect tests: a minimal MCP server exposed the way the
 * resource contract expects — a default-exported factory returning a fresh,
 * unconnected `McpServer`. Lives outside the test file because McpDynamic
 * resolves `spec.entry` through Node's ESM loader, not through the test
 * runner's in-memory module graph.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"

export function createEchoServer(): McpServer {
   const server = new McpServer({ name: "direct-echo", version: "1.0.0" })

   server.registerTool(
      "echo",
      {
         description: "Echo the message back",
         inputSchema: { message: z.string() },
      },
      async ({ message }) => ({
         content: [{ type: "text" as const, text: `echo: ${message}` }],
      }),
   )

   return server
}

export default createEchoServer
