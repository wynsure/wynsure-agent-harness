/**
 * InteractSurface extension — state layer.
 *
 * Co-located with the resource (`./interact-surface.ts`) and the interact
 * item kinds (`./items.ts`). Holds everything the extension owns:
 *
 *  - `USER_BOARD_ENVIRONMENT` + `UserBoardEnvironment` — the canonical
 *    passive acceptor the host registers under the `"user-board"` name so
 *    this extension's pinned activities can be resolved out of band;
 *  - The `InteractionItem` protocol (generic `presentation` / `user_input`
 *    core kinds + the open extension point) and the `InteractionStream` leaf
 *    that holds them at `${contextPath}/interact`;
 *  - The `InteractionProjector` seam used by the resource's `bindToSession`
 *    subscription to map fragments to items.
 *
 * None of this is generic. The harness core has no concept of "user-facing
 * projection": it just emits `fragment` and `activity_resolved` events. This
 * extension listens, projects, maintains its leaves, and emits its own
 * `interaction` events for the host UI. Delete InteractSurface and the
 * runtime stays compilable; the host UI simply loses the interact surface.
 */
import type {
   Activity,
   ActivityDelivery,
   ActivityEnvironment,
   EnvironmentName,
} from "../../state/activity.ts"
import { Leaf } from "../../state/leaf.ts"
import type { Tree } from "../../state/tree.ts"

// ── User-board environment (canonical passive acceptor) ─────────────────────

/** Standard environment name for user-facing interactions. */
export const USER_BOARD_ENVIRONMENT: EnvironmentName = "user-board"

/**
 * The "user-board" environment: a passive acceptor. It takes activities in
 * charge without driving them — the host resolves each out of band through
 * `AgentSession.resolveActivity` / `failActivity` (TUI input slot, HTTP
 * `/respond` endpoint). Hosts that want to drive interactions directly (e.g.
 * push to a live channel) may register a custom environment under the same
 * name.
 */
export class UserBoardEnvironment implements ActivityEnvironment {
   readonly name = USER_BOARD_ENVIRONMENT
   assign(_activity: Activity, _delivery: ActivityDelivery): void {
      // No-op: the host resolves out of band. The `ActivityStart` fragment and
      // the `activity_resolved` event let the host track pinned interactions.
   }
}

// ── Item protocol ───────────────────────────────────────────────────────────

/** Severity of a notification / alert. */
export type NotifyLevel = "info" | "warn" | "error"

/** Lifecycle of a pinned item's backing activity. `pending` while the agent awaits the user. */
export type RequestStatus = "pending" | "resolved" | "failed"

/**
 * Common shape for every interaction item. The activity-binding fields
 * (`activityId`, `status`, `result`, `priority`) are OPTIONAL: an item
 * carries them iff its kind backed the response with an activity. Such an
 * item is **pinned** while `status === "pending"` — the only mutable state on
 * an item, and the only routing key the runtime uses (by `activityId`) to
 * flip it on resolution. Whether a kind binds an activity is a per-kind
 * choice declared in the registry (`InteractionItemEntry.pinned`), never a
 * property of the type. The item never carries the tool name — that lives on
 * the registry entry; the kind is enough.
 */
export interface InteractionItemBase {
   /** Monotonic sequence number, allocated at append. Immutable on update. */
   seq: number
   /** Originating context (root for presentation, the binding context for pinned items). */
   contextId: string
   /** Parent context id (null for the root context). */
   parentId: string | null
   agentName: string
   /**
    * Backing activity id, present iff the kind delegated (declared
    * `pinned: true`). Used as the routing key on resolution. Absent for
    * fire-and-forget items (e.g. `notify`).
    */
   activityId?: string
   /** Present iff the item is activity-backed. `pending` while pinned. */
   status?: RequestStatus
   /** Final result filled at resolution (only on activity-backed items). */
   result?: any
   /** Optional host-side ordering hint (higher = shown first). Default 0. */
   priority?: number
}

/** A one-way agent message shown to the user. */
export interface PresentationItem extends InteractionItemBase {
   kind: "presentation"
   content: string
}

/** Echo of a proactive user input (steering as: user). */
export interface UserInputItem extends InteractionItemBase {
   kind: "user_input"
   text: string
}

/** Core kinds produced directly by the harness (no extension required). */
export type CoreInteractionItem = PresentationItem | UserInputItem

/**
 * Open extension point: any item beyond the core kinds conforms to this. The
 * `kind` is an opaque string from the core's perspective; the originating
 * extension narrows it via its own typed unions (host UI code imports both).
 * Extension variants carry additional fields locally — the core only sees the
 * base shape and dispatches by `kind`.
 */
export interface InteractionItemExtension extends InteractionItemBase {
   kind: string
}

/**
 * The full InteractionItem: core kinds OR any extension item. An extension
 * item must satisfy `InteractionItemExtension` (i.e. carry the base fields +
 * a `kind`); its specific shape is owned by the extension.
 */
export type InteractionItem = CoreInteractionItem | InteractionItemExtension

/**
 * Draft form (no `seq` — allocated at append). The index signature lets
 * extensions carry their own kind-specific fields through the core seam
 * without each variant needing a core-side declaration; the runtime treats
 * drafts uniformly via `InteractionStream.append`.
 */
export interface InteractionItemDraft {
   kind: string
   contextId: string
   parentId: string | null
   agentName: string
   [extraFields: string]: unknown
}

/** Polymorphic mutation carried on the "interaction" event channel. */
export type InteractionItemEvent =
   | { op: "append"; item: InteractionItem }
   | { op: "replace"; item: InteractionItem }
   | { op: "update"; activityId: string; status: RequestStatus; result?: any }

// ── Projection base (used internally by the resource's bindToSession) ────────

/** Host-side base fields handed to a resource's projection logic. */
export interface InteractionProjectionBase {
   contextId: string
   parentId: string | null
   agentName: string
}

// ── Draft factories (core kinds) ─────────────────────────────────────────────

export function createPresentation(opts: {
   contextId: string
   parentId: string | null
   agentName: string
   content: string
}): InteractionItemDraft {
   return {
      kind: "presentation",
      contextId: opts.contextId,
      parentId: opts.parentId,
      agentName: opts.agentName,
      content: opts.content,
   }
}

/**
 * The user-interaction projection: a `Leaf<InteractionItem>` specialized with
 * sequence numbering and in-place mutation of pinned items. `appendDraft`
 * allocates the `seq`; `updatePinned` rewrites a pinned item when its backing
 * activity resolves (status + result). The `seq` and rank of an item never
 * change.
 */
export class InteractionStream extends Leaf<InteractionItem> {
   private seqCounter = 0
   /**
    * Index of activity-backed items by their `activityId`, so `updatePinned`
    * can route a resolution to the right cell. Populated at append for every
    * draft that carries a `status` (i.e. a pinned kind's item).
    */
   private readonly pinnedIndex = new Map<string, number>()

   constructor(path = "/", tree?: Tree) {
      super(path, tree)
   }

   /** Domain alias for the Leaf's `cells`. */
   get items(): InteractionItem[] {
      return this.cells
   }

   /**
    * Append a draft (no `seq`): allocate the sequence number, store the item,
    * and index it when it is activity-backed (so `updatePinned` can route by
    * `activityId` on resolution). Distinct from the base `append` (which
    * expects a fully-formed cell) to keep the variance clean across
    * Leaf<InteractionItem> ↔ Leaf<Cell> at the Tree factory seam.
    */
    appendDraft(draft: InteractionItemDraft): InteractionItem {
       const item = { ...draft, seq: this.seqCounter++ } as InteractionItem
       super.append(item)
       if (typeof item.status === "string" && typeof item.activityId === "string") {
          this.pinnedIndex.set(item.activityId, this.length - 1)
       }
       return item
    }

    /**
     * Upsert the live item for `kind`: replace the existing item of that kind
     * in place (preserving its `seq`), or append it on first sight. Upsertable
     * kinds (declared `upsert: true` in the registry) keep exactly ONE living
     * item per kind — re-calling the tool updates it rather than stacking
     * snapshots. Routing is by `seq` on the host side, which is why it is kept
     * stable across replaces. Scans backward so the lookup needs no index to
     * rebuild on `restore` (there is at most one item per upsertable kind).
     * Returns the item and whether it replaced an existing one (false on first
     * sight) so the caller emits `append` vs `replace`.
     */
    upsertLive(kind: string, draft: InteractionItemDraft): {
       item: InteractionItem
       replaced: boolean
    } {
       for (let i = this.cells.length - 1; i >= 0; i--) {
          if (this.cells[i].kind === kind) {
             const item = { ...draft, seq: this.cells[i].seq } as InteractionItem
             this.set(i, item)
             return { item, replaced: true }
          }
       }
       const item = { ...draft, seq: this.seqCounter++ } as InteractionItem
       super.append(item)
       return { item, replaced: false }
    }

   /**
    * Rewrite the pinned item bound to `activityId` with the terminal status
    * (and optional result) emitted on resolution. No-op when no pinned item
    * is bound to that id (e.g. a non-interact activity resolving).
    */
   updatePinned(
      activityId: string,
      status: RequestStatus,
      result?: any,
   ): boolean {
      const idx = this.pinnedIndex.get(activityId)
      if (idx === undefined) return false
      const current = this.cells[idx]
      if (!current || current.status == null) return false
      this.set(idx, {
         ...current,
         status,
         result: result !== undefined ? result : current.result,
      } as InteractionItem)
      return true
   }

   /** Items still pinned (activity-backed, awaiting resolution), oldest first. */
   pendingItems(): InteractionItem[] {
      const out: InteractionItem[] = []
      for (const it of this.cells) {
         if (it.status === "pending") out.push(it)
      }
      return out
   }

   /**
    * Restore cells wholesale, then rebuild the pinned index so `updatePinned`
    * keeps working after a snapshot restore (the index is normally populated
    * by `append`, which `restore` bypasses).
    */
   restore(cells: readonly InteractionItem[]): void {
      super.restore(cells)
      // Resume seq allocation after the last restored item so subsequent
      // appends don't collide with restored items.
      this.seqCounter = cells.length
      this.pinnedIndex.clear()
      const items = this.cells
      for (let i = 0; i < items.length; i++) {
         const it = items[i]
         if (typeof it.status === "string" && typeof it.activityId === "string") {
            this.pinnedIndex.set(it.activityId, i)
         }
      }
   }
}
