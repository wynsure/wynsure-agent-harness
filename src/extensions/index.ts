// Side-effect imports: each pluggable resource registers itself into the
// shared `scheme` (object-meta.ts) at import time. Importing this barrel from
// a host entry point wires every extension; the harness core (state/blueprint/
// runtime + the base resources Agent/Posture/Skill/Preset) does NOT import
// this module, so deleting `extensions/` leaves the core compilable and
// runnable with its base resource set.
//
// The `export *` calls also re-export the public types/values of every
// extension so consumers that import the harness package see them through the
// single package barrel (`src/index.ts`).
export * from "./interact-surface/index.ts"
export * from "./mcp-stdio/index.ts"
export * from "./mcp-direct/index.ts"
export * from "./mcp-deno-worker/index.ts"
export * from "./mcp-server/index.ts"
export * from "./memory/index.ts"
export * from "./openai-completion/index.ts"
