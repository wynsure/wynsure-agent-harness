/**
 * Public surface of @kanop.ai/agent-blueprint-harness.
 *
 * The package is a single barrel: every internal module re-exports here so
 * consumers (the CLI package, host integrations, tests) import from one path.
 *
 * Layout (internal, not part of the contract) — three layers plus
 * cross-cutting infra, mirroring the architecture in docs/concepts.md:
 *
 * - state/      — the Tree/Leaf/Cell foundation + its cell/leaf variants:
 *                 leaf, tree, activity (cell in /activities), fragment
 *                 (cell in /thread), interact (Leaf<InteractionItem>).
 * - blueprint/  — the declarative layer: api-version, object-meta, service
 *                 (typed capability key), scripting, instruction,
 *                 blueprint-schema, blueprint, and resources/ (Agent, Posture,
 *                 Skill, Preset, Memory, McpStdio, InteractSurface, and the
 *                 model kinds whose model-base.ts also hosts the shared
 *                 OpenAI-compatible Chat Completions engine).
 * - runtime/    — the live execution layer: thread (AgentThread +
 *                 IThreadCompletionService), steering, context (the per-context
 *                 run loop), session (the host-facing emitter).
 * - system/     — logger (Pino + crash handlers).
 *
 * The harness ships the InteractSurface resource and the user-board
 * environment (the interact__* surface). Every other tool surface and every
 * other activity environment is declared by the blueprint or registered by the
 * host. Presentation of fragments to a user is a host responsibility (see
 * docs/studio.spec.md § "Projection de conversation").
 */

export * from "./blueprint/api-version.ts"
export * from "./blueprint/blueprint-schema.ts"
export * from "./blueprint/blueprint.ts"
export * from "./blueprint/object-meta.ts"
export * from "./blueprint/service.ts"
export * from "./blueprint/instruction.ts"
export * from "./state/fragment.ts"
export * from "./state/activity.ts"
export * from "./state/leaf.ts"
export * from "./state/tree.ts"
export * from "./runtime/thread.ts"
export * from "./runtime/steering.ts"
export * from "./blueprint/scripting.ts"
export * from "./runtime/session.ts"
export * from "./runtime/context.ts"
export * from "./system/logger.ts"
// Core resources (Agent/Posture/Skill/Preset) — register their kinds as a
// side effect of the package import.
export * from "./blueprint/resources/index.ts"
// Pluggable resources — register their kinds (InteractSurface, McpStdio,
// Memory, OpenAI-compatible models) as a side effect. The harness core does
// NOT depend on this barrel; deleting `extensions/` keeps the core compilable
// (the host then gets a harness with only the base resources).
export * from "./extensions/index.ts"
