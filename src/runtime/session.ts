import { EventEmitter } from "events"
import { type Blueprint, type ResourceObject } from "../blueprint/blueprint.ts"
import { AgentContext } from "./context.ts"
import { AgentObject } from "../blueprint/resources/agent.ts"
import { type Fragment } from "../state/fragment.ts"
import { type TokenUsage } from "./thread.ts"
import { Tree, joinLeafPath, SESSION_SCOPE_PATH, type TreeSnapshot } from "../state/tree.ts"
import { type Cell, type Leaf, type StateCell } from "../state/leaf.ts"
import {
   type ActivityEnvironment,
   type ActivityId,
   type EnvironmentName,
} from "../state/activity.ts"
import { type SteerOptions, SteeringBusyError } from "./steering.ts"

function timecode(): string {
   const d = new Date()
   const pad = (n: number) => String(n).padStart(2, "0")
   return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

export interface LogEntry {
   timestamp: number
   level: "debug" | "info" | "warn" | "error"
   fragmentType: string
   source?: string
   preview: string
}

/** Per-context identity attached to every session event. */
export interface ContextRef {
   contextId: ContextId
   parentId: ContextId | null
   agentName: string
}

/** Stable identifier of a context (root or subagent) within a session. */
export type ContextId = string

/** Stable identifier of a session (roots all activity ids and events). */
export type SessionId = string

/** Serializable form of a session: identity + the whole Tree. */
export interface SessionSnapshot {
   sessionId: SessionId
   agentName: string
   tree: TreeSnapshot
}

export type SessionEvent =
    | { type: "fragment"; fragment: Fragment }
    | { type: "thinking" }
    | { type: "toolstart"; toolName: string; id: string }
    | { type: "toolend"; toolName: string; id: string; isError?: boolean }
    | { type: "prompt" }
    | { type: "error"; error: Error }
    | { type: "usage"; usage: TokenUsage }
    | { type: "posture"; postureName: string | null }
    | { type: "log"; entry: LogEntry }
    | { type: "awaiting_activities"; pending: ActivityId[] }
    | { type: "activity_resolved"; activityId: ActivityId; status: "completed" | "failed"; result?: any }
    | { type: "terminated" }

/**
 * AgentSession owns the event emitter, the agent identity, the environment
 * registry, and the contexts. Activities live as DATA — cells in each context's
 * /activities leaf — so the session's only activity-side role is to route host
 * resolution (`resolveActivity`/`failActivity`) to the owning context, which
 * settles it synchronously. There is no in-memory activity store, no await
 * graph, no watcher map, and no promise-based resume: the host re-calls
 * `execute()` to continue after a resolution. All execution is delegated to the
 * AgentContext.
 */
export class AgentSession {
   readonly blueprint: Blueprint
   readonly context: AgentContext
    readonly events = new EventEmitter()
    readonly agentName: string
    readonly sessionId: SessionId
   /** One Tree per session; the serializable unit for snapshot/restore. */
   readonly tree: Tree = new Tree()
    private idCounter = 0
   private readonly contexts = new Map<string, AgentContext>()
   private readonly environments = new Map<EnvironmentName, ActivityEnvironment>()

   constructor(
      blueprint: Blueprint,
      agentName?: string,
   ) {
      this.blueprint = blueprint
      const name = agentName ?? pickDefaultAgent(blueprint)
      const resource = blueprint.getResource(name)
      if (!resource) {
         throw new Error(`Agent resource not found: "${name}".`)
      }
      if (!(resource instanceof AgentObject)) {
         throw new Error(`Resource "${name}" is not an agent.`)
      }
       this.agentName = name
       this.sessionId = `${this.agentName}-${timecode()}`
       this.context = new AgentContext(this, { agent: resource })
       // Bind every resource to the live session AFTER the root context exists:
       // extensions use this seam to subscribe to fragment/activity events and
       // acquire their own leaves on the tree. The core itself does not
       // hard-wire any user-facing projection — extensions own theirs.
       for (const res of blueprint.resources) {
          res.bindToSession?.(this)
       }
    }

   /** Allocate a session-unique identifier with the given label prefix. */
   allocId(prefix: string): string {
      return `${this.agentName}-${prefix}-${this.idCounter++}`
   }

   registerContext(ctx: AgentContext): void {
      this.contexts.set(ctx.contextId, ctx)
   }

   getContext(contextId: string): AgentContext | undefined {
      return this.contexts.get(contextId)
   }

   listContexts(): AgentContext[] {
      return [...this.contexts.values()]
   }

   // ── State-Tree façade (session scope) ──────────────────────────────

   /**
    * Session-scoped state accessors, rooted at the reserved `/.session` path.
    * Resources that carry session-level (cross-context) state read/write here;
    * a state cell's `kind` is the resource `metadata.name`. See
    * docs/state-tree.spec.md.
    */
   getState(rc: ResourceObject): StateCell | undefined {
      return this.sessionStateLeaf().get(rc.name)
   }

   setState(rc: ResourceObject, value: StateCell): void {
      value.kind = rc.name
      this.sessionStateLeaf().upsert(value)
   }

   findLeaf<C extends Cell>(sub: string): Leaf<C> | undefined {
      return this.tree.findLeaf<C>(joinLeafPath(SESSION_SCOPE_PATH, sub))
   }

   acquireLeaf<C extends Cell>(sub: string): Leaf<C> {
      return this.tree.acquireLeaf<C>(joinLeafPath(SESSION_SCOPE_PATH, sub))
   }

   deleteLeaf(sub: string): void {
      this.tree.deleteLeaf(joinLeafPath(SESSION_SCOPE_PATH, sub))
   }

   private sessionStateLeaf(): Leaf<StateCell> {
      return this.tree.acquireLeaf<StateCell>(joinLeafPath(SESSION_SCOPE_PATH, "state"))
   }

   // ── Serialization / restoration ────────────────────────────────────

   /**
    * Snapshot the whole session as plain JSON: the agent identity plus the
    * Tree (every leaf — threads, per-scope state, interact, custom sub-leaves).
    * The blueprint itself is NOT serialized (it is reloaded by the host from
    * its path); transient handles (MCP clients, model caches) reconnect lazily.
    * See docs/state-tree.spec.md.
    */
   serialize(): SessionSnapshot {
      return {
         sessionId: this.sessionId,
         agentName: this.agentName,
         tree: this.tree.snapshot(),
      }
   }

   /**
    * Rebuild a session from a snapshot against a freshly-loaded blueprint.
    * Constructs the session (re-instantiating resources, which reconnect
    * eagerly — e.g. MCP), then restores the Tree into the live leaves and
    * offers each resource its state cell via `restoreState` (no-op for
    * Pattern A resources whose state already lives in the leaf).
    */
   static async restore(
      snapshot: SessionSnapshot,
      blueprint: Blueprint,
   ): Promise<AgentSession> {
      const session = new AgentSession(blueprint, snapshot.agentName)
      // Preserve the original identity (the constructor minted a fresh id).
      ;(session as { sessionId: string }).sessionId = snapshot.sessionId
      session.tree.restore(snapshot.tree)
      for (const r of session.blueprint.resources) {
         await r.restoreState?.(session.getState(r), "session")
         await r.restoreState?.(session.context.getState(r), "context")
      }
      return session
   }

   // ── Environments ──────────────────────────────────────────────────

   /** Register an environment by name. Replaces any existing one. */
   registerEnvironment(env: ActivityEnvironment): void {
      this.environments.set(env.name, env)
   }

   getEnvironment(name: string): ActivityEnvironment | undefined {
      return this.environments.get(name)
   }

   // ── Activity lifecycle ────────────────────────────────────────────
   //
   // Activities live as CELLS in each context's /activities leaf — data, part
   // of the Tree, serializable for free. The session only routes host resolution
   // to the owning context. There is no in-memory activity store, no await
   // graph, no watcher map, and NO promise-based resume: the host re-calls
   // execute() to continue after a resolution.

   /** Resolve an activity as completed with a final result (host-driven). */
   resolveActivity(activityId: ActivityId, result: any): void {
      this.routeSettle(activityId, result, false)
   }

   /** Terminate an activity as failed with an error value (host-driven). */
   failActivity(activityId: ActivityId, error: any): void {
      this.routeSettle(activityId, error, true)
   }

   /** Route a terminal settlement to the owning context (no-op if unknown). */
   private routeSettle(activityId: ActivityId, payload: any, isError: boolean): void {
      for (const ctx of this.contexts.values()) {
         if (ctx.ownsActivity(activityId)) {
            ctx.settleActivity(activityId, payload, isError)
            return
         }
      }
   }

      // ── Execution ─────────────────────────────────────────────────────

     async execute(userMessage?: string): Promise<void> {
        await this.context.run(userMessage)
     }

     /**
      * Inject a host steering into a context's thread (root by default, or the
      * context identified by opts.contextId). Steering is generic per context —
      * a sub-agent can be steered like the root. Setup is synchronous; the loop
      * runs fire-and-forget. Throws SteeringBusyError (→ HTTP 409) when the loop
      * is busy and the injection cannot apply, or when contextId is unknown.
      * See docs/studio.spec.md § "Steering".
      */
     steer(text: string, opts?: SteerOptions): void {
        const target = opts?.contextId
           ? this.getContext(opts.contextId)
           : this.context
        if (!target) {
           throw new SteeringBusyError(`unknown contextId: ${opts?.contextId}`)
        }
        target.steer(text, opts)
     }

    on(event: "fragment", listener: (e: ContextRef & { fragment: Fragment }) => void): this
    on(event: "thinking", listener: (e: ContextRef) => void): this
    on(event: "toolstart", listener: (e: ContextRef & { toolName: string; id: string }) => void): this
    on(event: "toolend", listener: (e: ContextRef & { toolName: string; id: string; isError?: boolean }) => void): this
    on(event: "prompt", listener: (e: ContextRef) => void): this
    on(event: "error", listener: (e: ContextRef & { error: Error }) => void): this
    on(event: "usage", listener: (e: ContextRef & { usage: TokenUsage }) => void): this
    on(event: "posture", listener: (e: ContextRef & { postureName: string | null }) => void): this
    on(event: "log", listener: (e: ContextRef & { entry: LogEntry }) => void): this
    on(event: "awaiting_activities", listener: (e: ContextRef & { pending: ActivityId[] }) => void): this
    on(event: "activity_resolved", listener: (e: ContextRef & { activityId: ActivityId; status: "completed" | "failed"; result?: any }) => void): this
    on(event: "terminated", listener: (e: ContextRef) => void): this
    on(event: string, listener: (...args: any[]) => void): this {
       this.events.on(event, listener)
       return this
    }

   off(event: string, listener: (...args: any[]) => void): this {
      this.events.off(event, listener)
      return this
   }
}

/**
 * Resolves the agent resource to bind a session to when no agent name is
 * passed. A blueprint holds no "primary" agent — it is just a collection of
 * resources — so we default to the single agent resource, and require an
 * explicit name when several are declared.
 */
function pickDefaultAgent(blueprint: Blueprint): string {
   const agents = blueprint.resources.filter(
      (r): r is AgentObject => r instanceof AgentObject,
   )
   if (agents.length === 0) {
      throw new Error(
         "No agent resource in blueprint. Pass an agent name to AgentSession.",
      )
   }
   if (agents.length > 1) {
      throw new Error(
         `Multiple agent resources (${agents
            .map((a) => a.name)
            .join(", ")}); pass an explicit agent name to AgentSession.`,
      )
   }
   return agents[0].name
}
