import type { AgentManifest } from "./agent.ts"
import type { McpStdioManifest } from "./mcp-stdio.ts"
import type { MemoryManifest } from "./memory.ts"
import type { PostureManifest } from "./posture.ts"
import type { PresetManifest } from "./preset.ts"
import type { SkillManifest } from "./skill.ts"

/**
 * Union of every concrete manifest type known to the agent/v1 scheme. Used by
 * introspection tools (e.g. `check`) to narrow a parsed manifest by kind.
 */
export type KnownManifest =
   | AgentManifest
   | McpStdioManifest
   | MemoryManifest
   | PostureManifest
   | PresetManifest
   | SkillManifest
