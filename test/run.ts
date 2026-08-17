/**
 * Test entrypoint. Importing the *.test.ts modules registers their suites via
 * the describe/it side-effects; runAll() then executes them sequentially.
 *
 * Usage: npm test
 */
import "./activity.test"
import "./interact-upsert.test"
import "./resources.test"
import "./steering.test"
import "./hooks-guardrails.test"
import "./state-tree.test"
import "./mcp-deno-worker.test"
import "./mcp-server.test"
import "./mcp-direct.test"
import { runAll } from "./runner.ts"

runAll().catch((err) => {
   console.error(err)
   process.exit(1)
})
