/**
 * Activity model. Every tool invocation gets an activity — a serializable cell
 * in the owning context's /activities leaf (see docs/architecture.spec.md). A tool that can settle immediately delivers the
 * activity synchronously; one that cannot delegates it to an environment. Either
 * way the activity's termination is synchronous data mutation: the cell goes
 * terminal and the effects (ToolFeedback, completion, interact flip) derive
 * from the data. There is no in-memory await graph and no promise-based resume;
 * the host re-calls execute() to continue after a resolution.
 *
 * All activities share one id space. A `deliveryId` passed to a tool is the
 * activity id the host/env resolves — the former delivery/child split is
 * collapsed into one record.
 */

export type ActivityStatus = "pending" | "running" | "completed" | "failed"

/**
 * The single activity-id space. Every activity — a delivery, a child, a future
 * kind — shares it, which is what makes the completion gate and the termination
 * notifications a pure flow of ids. A `deliveryId` and a child id are both an
 * `ActivityId`.
 */
export type ActivityId = string

/** Id of a `ToolUse` fragment (the link a delivery's `ToolFeedback` answers). */
export type ToolUseId = string

/** Name under which an environment is registered on the session. */
export type EnvironmentName = string

/**
 * A unit of the system identified solely by its `activityId`. The activity is a
 * single record: when delegated, it carries the routing fields
 * (`environment`/`tool`/`arguments`/`payload`); when settled inline, those stay
 * unset. The former delivery/child pair is collapsed into this one record — the
 * id the host/env resolves is the same id the tool received.
 */
export interface Activity {
   activityId: ActivityId
   parentActivityId: ActivityId
   status: ActivityStatus
   /** Environment the child is routed to (children only). */
   environment?: EnvironmentName
   /** Tool name that triggered the child (was `kind`, renamed to free `kind` for the cell discriminator). */
   tool?: string
   /** Tool arguments forwarded to the environment. */
   arguments?: Record<string, any>
   /** Free-form payload (opaque to the harness; may carry a contextId as data). */
   payload?: any
}

/** Description of a child activity to create via `AgentContext.delegateActivity`. */
export interface ActivityChildSpec {
   /** Name of the environment that will take the child in charge. */
   environment: EnvironmentName
   /** Tool name that triggered the child (was `kind`). */
   tool: string
   /** Tool arguments forwarded to the environment. */
   arguments?: Record<string, any>
   /** Environment-specific payload (opaque to the harness). */
   payload?: any
}

/**
 * Channel handed to an environment when a child activity is routed to it.
 * Bound to a specific activityId so the environment does not manage ids
 * itself. The host can also drive completion directly through the session's
 * public resolve/fail methods (used by HTTP servers where the response arrives
 * out of band).
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
 * External system capable of taking child activities in charge. Implementations
 * are provided by the host (CLI, HTTP server) and registered by name on the
 * AgentSession. The host decides which environments exist — the harness ships
 * none and stays agnostic to their nature. The canonical passive acceptor for
 * user-facing interactions (`UserBoardEnvironment`) ships with the
 * InteractSurface extension, not with the core.
 */
export interface ActivityEnvironment {
   readonly name: EnvironmentName
   /** Take ownership of a child activity and drive its delivery over time. */
   assign(activity: Activity, delivery: ActivityDelivery): void
   /** Optionally cancel an in-flight activity. */
   cancel?(activityId: ActivityId): void
}
