/**
 * InteractSurface extension — UI helpers.
 *
 * This module is the API a host UI (CLI/TUI, webapp, test harness) consumes
 * to read the user-facing conversation projection maintained by the
 * InteractSurface resource and to drive resolution of pinned items. It is
 * deliberately kept separate from `./interact-surface.ts` (the resource) and
 * `./state.ts` (the leaf shape) so responsibility is split:
 *
 *  - resource (`interact-surface.ts`): publishes the `interact__*` tools,
 *    creates items in `applyTool` (one path per kind), binds to the session,
 *    projects a root `AgentMessage` to a presentation, runs the kind's `reply`
 *    hook on resolution;
 *  - state (`state.ts`): the leaf class, the environment constant + acceptor,
 *    the item protocol;
 *  - api (this file): read the leaf, drive resolution, inspect pinned
 *    interactions.
 *
 * The harness core stays unaware of all of this — these helpers operate on
 * the generic session/context APIs and the leaf path convention
 * (`${scopePath}/interact`) shared by the resource and host UIs.
 */
import type { AgentSession } from "../../runtime/session.ts"
import type { ActivityId } from "../../state/activity.ts"
import type {
   InteractionItem,
   InteractionStream,
} from "./state.ts"

/**
 * Acquire the `/interact` leaf for a context. Returns `undefined` when no
 * InteractSurface is registered on the blueprint or no items have been
 * projected yet for the given context. The root context is the default.
 */
export function getInteractStream(
   session: AgentSession,
   contextId?: string,
): InteractionStream | undefined {
   const ctx = contextId ? session.getContext(contextId) : session.context
   if (!ctx) return undefined
   return ctx.findLeaf<InteractionItem>("interact") as InteractionStream | undefined
}

/**
 * All items currently held by the `/interact` leaf for a context (oldest
 * first). Empty array when no InteractSurface is registered or no projection
 * has happened yet.
 */
export function getInteractions(
   session: AgentSession,
   contextId?: string,
): InteractionItem[] {
   return getInteractStream(session, contextId)?.items ?? []
}

/**
 * Items still pinned (activity-backed, awaiting a user response), oldest
 * first. These are the items the host UI typically docks at the foot for
 * input. Returns an empty array when nothing is pinned.
 */
export function pinnedInteractions(
   session: AgentSession,
   contextId?: string,
): InteractionItem[] {
   return getInteractStream(session, contextId)?.pendingItems() ?? []
}

/**
 * Resolve a pinned interaction by its activity id with a final result. The
 * activity id is the one carried by the pinned item (`activityId`) —
 * typically obtained from `pinnedInteractions` or `getInteractions`. Routes
 * to the owning context's settlement flow (which flips the item status,
 * emits `activity_resolved`, and runs the kind's `reply` hook — e.g.
 * `prompt` turns the resolved text into a `UserMessage`). No-op when the
 * activity id is unknown.
 */
export function resolveInteraction(
   session: AgentSession,
   activityId: ActivityId,
   result: unknown,
): void {
   session.resolveActivity(activityId, result)
}

/**
 * Terminate a pinned interaction as failed with an error value. Same routing
 * as `resolveInteraction`; the item flips to `failed` and the activity emits
 * `activity_resolved` with `status: "failed"`.
 */
export function failInteraction(
   session: AgentSession,
   activityId: ActivityId,
   error: unknown,
): void {
   session.failActivity(activityId, error)
}
