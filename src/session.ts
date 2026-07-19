import { EventEmitter } from "events"
import { type Blueprint } from "./blueprint.ts"
import { AgentContext } from "./context.ts"
import { AgentObject } from "./resources/index.ts"
import { type Fragment } from "./fragment.ts"
import { type TokenUsage } from "./thread.ts"
import {
   type Activity,
   type ActivityDelivery,
   type ActivityEnvironment,
} from "./activity.ts"
import { type SteerOptions } from "./steering.ts"

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
   contextId: string
   parentId: string | null
   agentName: string
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
   | { type: "awaiting_activities"; pending: string[] }
   | { type: "activity_resolved"; activityId: string; status: "completed" | "failed" }
   | { type: "terminated" }

/**
 * AgentSession is the thin surface that aggregates environments and routes
 * activity feedback. It owns the event emitter and the agent identity, and
 * delegates all execution to its AgentContext. Activity feedback coming from
 * external environments (or pushed directly by the host for "user-board") is
 * routed back to the owning context, which drives loop resumption.
 */
export class AgentSession {
   readonly blueprint: Blueprint
   readonly context: AgentContext
   readonly events = new EventEmitter()
   readonly agentName: string
   readonly sessionId: string
   private idCounter = 0
   private readonly contexts = new Map<string, AgentContext>()
   private readonly environments = new Map<string, ActivityEnvironment>()
   /** activityId → owning contextId, to route feedback back to the runLoop. */
   private readonly activityContexts = new Map<string, string>()

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

   // ── Environments ──────────────────────────────────────────────────

   /** Register an environment by name. Replaces any existing one. */
   registerEnvironment(env: ActivityEnvironment): void {
      this.environments.set(env.name, env)
   }

   getEnvironment(name: string): ActivityEnvironment | undefined {
      return this.environments.get(name)
   }

   // ── Activity routing ──────────────────────────────────────────────

   /**
    * Take ownership of an activity: record its owning context, build a delivery
    * bound to its id, and hand both to the registered environment. If no
    * environment is registered for the activity's name, it fails immediately.
    * Called by AgentContext after it has emitted the ActivityStart fragment.
    */
   assignActivity(activity: Activity): void {
      this.activityContexts.set(activity.activityId, activity.contextId)
      const delivery = this.createDelivery(activity.activityId)
      const env = this.environments.get(activity.environment)
      if (!env) {
         delivery.fail({ error: `environment not registered: ${activity.environment}` })
         return
      }
      env.assign(activity, delivery)
   }

   /** Drop the routing entry once an activity has terminated. */
   forgetActivity(activityId: string): void {
      this.activityContexts.delete(activityId)
   }

   private route(activityId: string): AgentContext | undefined {
      const ctxId = this.activityContexts.get(activityId)
      return ctxId ? this.contexts.get(ctxId) : undefined
   }

   // ── Feedback delivery (host + environments) ───────────────────────

   /** Push an intermediate progress feedback for an in-flight activity. */
   deliverProgress(activityId: string, feedback: any, progress?: number): void {
      this.route(activityId)?.deliverActivityProgress(activityId, feedback, progress)
   }

   /** Terminate an activity as completed with a final result. */
   resolveActivity(activityId: string, result: any): void {
      this.route(activityId)?.deliverActivityComplete(activityId, "completed", result)
   }

   /** Terminate an activity as failed with an error value. */
   failActivity(activityId: string, error: any): void {
      this.route(activityId)?.deliverActivityComplete(activityId, "failed", error)
   }

   /** Build a delivery bound to an activity id (used internally + by host helpers). */
   createDelivery(activityId: string): ActivityDelivery {
      return {
         progress: (feedback, progress) => this.deliverProgress(activityId, feedback, progress),
         complete: (result) => this.resolveActivity(activityId, result),
         fail: (error) => this.failActivity(activityId, error),
      }
   }

   // ── Execution ─────────────────────────────────────────────────────

   async execute(userMessage?: string): Promise<void> {
      await this.context.run(userMessage)
   }

   /**
    * Inject a host steering into the root context's thread. Setup is
    * synchronous (validation + emit + loop kick); the loop runs
    * fire-and-forget. Throws SteeringBusyError (→ HTTP 409) when the loop is
    * busy and the injection cannot apply. See docs/serve.spec.md § "Steering".
    */
   steer(text: string, opts?: SteerOptions): void {
      this.context.steer(text, opts)
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
   on(event: "awaiting_activities", listener: (e: ContextRef & { pending: string[] }) => void): this
   on(event: "activity_resolved", listener: (e: ContextRef & { activityId: string; status: "completed" | "failed" }) => void): this
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
