/**
 * Public surface of @kanop.ai/agent-blueprint-harness.
 *
 * The package is a single barrel: every internal module re-exports here so
 * consumers (the CLI package, host integrations, tests) import from one path.
 *
 * Layout (internal, not part of the contract):
 * - blueprint*    — YAML manifests, tooling/hooks/guardrails schemas, Blueprint class
 * - session       — AgentSession, the host-facing event emitter
 * - context       — AgentContext, the per-context run loop (advanced usage)
 * - fragment      — Fragment types + factories (the audit/event stream)
 * - activity      — Activity delegation model + UserBoardEnvironment
 * - thread        — IThreadCompletionService contract + AgentThread
 * - steering      — Host-injected steering primitives
 * - interact      — Builtin interact__* tools + UserInteraction shape
 * - instruction   — Instruction template model (frontmatter, $ref resolution)
 * - object-meta   — Object manifest envelope + label selectors
 * - resources/    — Resource objects (Agent, Posture, Skill, Preset, Memory, McpStdio)
 * - builtin       — harness/* preset catalogue + builtin tool registry
 * - memory        — MemoryStore (per-context key/value)
 * - scripting     — Template rendering + condition evaluation
 * - logger        — Pino logger + crash handlers
 * - providers/    — Completion service implementations (OpenAI)
 */

export * from "./api-version.ts"
export * from "./blueprint-schema.ts"
export * from "./blueprint.ts"
export * from "./object-meta.ts"
export * from "./service.ts"
export * from "./instruction.ts"
export * from "./builtin.ts"
export * from "./fragment.ts"
export * from "./activity.ts"
export * from "./thread.ts"
export * from "./interact.ts"
export * from "./steering.ts"
export * from "./memory.ts"
export * from "./scripting.ts"
export * from "./session.ts"
export * from "./context.ts"
export * from "./logger.ts"
export * from "./resources/index.ts"

export * from "./providers/openai.ts"
