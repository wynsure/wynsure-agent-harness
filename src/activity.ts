/**
 * Activity model: a delegated unit of execution handed off to an external
 * environment. See docs/activities.spec.md.
 *
 * A tool returns an ActivitySpec from applyTool to delegate; the AgentContext
 * materializes it into an Activity (allocating the id), emits an ActivityStart
 * fragment, and routes it to the environment registered under its name.
 *
 * The `parentActivityId` is one of the context's two roots — `modelActivityId`
 * when the activity answers an LLM tool call, `harnessActivityId` when it is
 * opened by a hook / guardrail. The origin is therefore read
 * from the parent, not from a dedicated field.
 */

export type ActivityStatus = "pending" | "running" | "completed" | "failed"

/**
 * Description returned by a tool that chooses to delegate instead of producing
 * a direct ToolResult. The AgentContext turns this into a full Activity.
 */
export interface ActivitySpec {
   /** Name of the environment that will take the activity in charge. */
   environment: string
   /** Tool/kind name that triggered the activity. */
   kind: string
   /** Tool arguments forwarded to the environment. */
   arguments?: Record<string, any>
   /** Environment-specific payload (e.g. a UserInteraction for "user-board"). */
   payload?: any
}

/**
 * A materialized delegated activity. Carries the full identity needed for
 * routing, audit, and completion-driven loop resumption. The `parentActivityId`
 * disambiguates the origin (model vs harness) without needing a dedicated
 * `origin` field.
 */
export interface Activity {
   activityId: string
   parentActivityId: string
   /** Owning context — used by the session to resume the right runLoop. */
   contextId: string
   environment: string
   kind: string
   arguments: Record<string, any>
   payload?: any
   /** Link back to the triggering ToolUse (single unified fragment). */
   toolUseId?: string
   status: ActivityStatus
}

/**
 * Channel handed to an environment when an activity is assigned to it. Bound to
 * a specific activityId so the environment does not manage ids itself.
 *
 * The host can also drive completion directly through the session's public
 * resolve/fail methods (used by HTTP servers where the response arrives out of
 * band).
 */
export interface ActivityDelivery {
   /** Push an intermediate progress feedback (audit + host notification). */
   progress(feedback: any, progress?: number): void
   /** Terminate the activity as completed with a final result. */
   complete(result: any): void
   /** Terminate the activity as failed with an error value. */
   fail(error: any): void
}

/**
 * External system capable of taking activities in charge. Implementations are
 * provided by the host (CLI, HTTP server) and registered by name on the
 * AgentSession. "user-board" is the standard environment for user interactions.
 */
export interface ActivityEnvironment {
   readonly name: string
   /** Take ownership of an activity and drive its delivery over time. */
   assign(activity: Activity, delivery: ActivityDelivery): void
   /** Optionally cancel an in-flight activity. */
   cancel?(activityId: string): void
}

/** Standard environment name for user-facing interactions. */
export const USER_BOARD_ENVIRONMENT = "user-board"

/**
 * Distinguish an ActivitySpec (delegation) from a ToolResult (direct execution)
 * in the union returned by applyTool. An ActivitySpec is the only object shape
 * carrying an `environment` field.
 */
export function isActivitySpec(value: unknown): value is ActivitySpec {
   return (
      value !== null &&
      typeof value === "object" &&
      "environment" in (value as any)
   )
}

/**
 * Standard "user-board" environment: a passive acceptor. It takes activities in
 * charge without driving them — the host resolves each out of band through
 * AgentSession.resolveActivity / failActivity (TUI, HTTP endpoint, …). Hosts
 * that want to drive interactions directly (e.g. push to a live channel) may
 * register a custom environment under the same name.
 */
export class UserBoardEnvironment implements ActivityEnvironment {
   readonly name = USER_BOARD_ENVIRONMENT
   assign(_activity: Activity, _delivery: ActivityDelivery): void {
      // No-op: the host resolves out of band. The ActivityStart fragment and
      // the activity_resolved event let the host track pending interactions.
   }
}
