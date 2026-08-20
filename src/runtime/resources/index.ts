// Side-effect imports: each core resource module registers itself into the
// shared `scheme` (runtime/scheme.ts) at import time. Pluggable resources
// (InteractSurface, McpStdio, Memory, the OpenAI-compatible model kinds) live
// under `src/extensions/` and are loaded by `src/extensions/index.ts`. The
// harness entry barrel (`src/index.ts`) imports both, so a host that imports
// the package gets every kind registered; a host that imports only the core
// gets a runnable harness with just the base resources.
import "./agent.ts"
import "./posture.ts"
import "./preset.ts"
import "./skill.ts"

export type { AgentManifest, AgentSpec, AgentStatus } from "./agent.ts"
export type { PostureManifest, PostureSpec, PostureStatus } from "./posture.ts"
export type { PresetManifest, PresetSpec } from "./preset.ts"
export type { SkillManifest, SkillSpec, SkillStatus } from "./skill.ts"

export { AgentObject } from "./agent.ts"
export { PostureObject } from "./posture.ts"
export { PresetObject } from "./preset.ts"
export { SkillObject } from "./skill.ts"
