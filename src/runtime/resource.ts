import type {
   GuardrailDecl,
   HookEntry,
   HookTrigger,
   ToolingEntry,
} from "../blueprint/blueprint-schema.ts"
import type { InstructionTemplate } from "../blueprint/instruction.ts"
import type { ObjectMeta } from "../blueprint/object-meta.ts"
import type { ServiceContract } from "../blueprint/service.ts"
import type { ActivityId } from "../state/activity.ts"
import type { StateCell } from "../state/leaf.ts"
import type { AgentContext } from "./context.ts"
import type { AgentSession } from "./session.ts"
import type { ToolGuide, ToolName } from "./tool.ts"

export interface AgentBehavior {
   persona?: InstructionTemplate
   guidelines?: InstructionTemplate[]
   skills?: InstructionTemplate[]
   tools?: ToolGuide[]
   maxToolRounds?: number
   /** Posture to auto-activate when an agent instance starts. Agent-only. */
   posture?: string
   /**
    * Guardrail declarations contributed by the agent (base behavior) and the
    * active posture (overlay). Each decl carries its local `name`; the
    * fully-qualified `guardrails:<owner>:<local>` audit name is built by the
    * context that owns the resource.
    */
   guardrails?: GuardrailDecl[]
}

/**
 * Read-only view of a `preset` object used by consumers (agent/posture/skill)
 * to merge its instruction/tooling/hooks at load time. Declared here (not on
 * ResourceObject) so the generic loader stays decoupled from concrete object
 * types and avoids an import cycle. See docs/resources.md.
 */
export interface PresetView {
   readonly kind: "Preset"
   getTemplate(): InstructionTemplate | null
   getTooling(): ToolingEntry[]
   getHooks(trigger: HookTrigger): HookEntry[]
   /** Guardrail declarations the preset mutualises for its consumers. */
   getGuardrails(): GuardrailDecl[]
}

/**
 * ResourceObject — the live contract every instantiated resource implements.
 * The manifest is the serializable form (see blueprint/object-meta.ts); the
 * object is the typed per-session instance produced by `fromManifest`.
 * `metadata.name` is the stable identifier; `name` is exposed as a shortcut
 * for the many call sites that look up resources by name.
 *
 * Objects that need their peers or the shared declarations reach them through
 * the session they were instantiated for (received via the factory's load
 * context and stored per kind): `session.getResource`, `session.blueprint`.
 * The session itself points at the blueprint — objects never hold the
 * blueprint directly.
 */
export interface ResourceObject {
   readonly apiVersion: string
   readonly kind: string
   readonly metadata: ObjectMeta
   /** Shortcut for `metadata.name`. */
   readonly name: string
   getTools(): ToolGuide[]
   getHooks(trigger: HookTrigger): HookEntry[]
   /**
    * Resolve a typed capability provided by this resource, or `undefined` when
    * the resource does not provide it. Lets a consumer obtain a service (e.g.
    * the thread completion service) from a resource by contract, without
     * coupling to the concrete kind. See docs/architecture.spec.md §
     * "ServiceContract".
    */
   getService?<T>(contract: ServiceContract<T>): T | undefined
   /**
    * Typed discriminator: returns this resource as a `PresetView` when it is a
    * preset, else `undefined`. Used to collect presets without coupling to the
    * concrete class (and without string-kind comparisons). Optional; only
    * Preset implements it.
    */
   asPreset?(): PresetView
   /**
    * Guardrail declarations owned by this resource. Most resources return [];
    * only Agent / Posture / Skill / Preset carry guardrails (and Preset
    * folds them into consumers via `extends`). The resource's `name` is used
    * as the namespace prefix when building the audit identity.
    */
   getGuardrails(): GuardrailDecl[]
   applyTool(
      toolName: ToolName,
      params: Record<string, any>,
      context: AgentContext,
      deliveryId?: ActivityId,
   ): Promise<string | undefined>
   /** Release runtime resources (transports, connections). Optional. */
   close?(): Promise<void> | void
   /**
    * Project persistable instance state into a state cell (Pattern B). A
    * stateless resource whose state already lives in the leaf via
    * `Context.setState` (Pattern A) returns null. The cell's `kind` is set to
     * the resource name by the caller. See docs/architecture.spec.md.
    */
   captureState?(scope: "session" | "context"): StateCell | null | undefined
   /**
    * Rehydrate persistable state and rebuild transient handles (Pattern B).
    * Called at restore, after the state leaf is in place; the cell (or
    * undefined) is the resource's own. Transient handles (sockets, caches)
    * reconnect/recompute lazily. Pattern A resources may no-op.
    */
   restoreState?(cell: StateCell | undefined, scope: "session" | "context"): Promise<void> | void
   /**
    * Bind this resource to its live session: subscribe to events, acquire
    * per-context leaves, register cleanup. Called once per resource after the
    * root context is constructed (so the session, its tree and its events are
    * ready). Optional; most resources don't need it. This is the seam that lets
    * extensions own user-facing projection (e.g. InteractSurface) without the
    * runtime hard-wiring any of it.
    */
   bindToSession?(session: AgentSession): void
   /** Serialize back to the on-disk/wire form. */
   toManifest(): import("../blueprint/object-meta.ts").ObjectManifest
}
