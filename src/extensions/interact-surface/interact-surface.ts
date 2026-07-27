/**
 * InteractSurface — extension resource that publishes the `interact__*` tool
 * surface and OWNS the user-facing conversation projection.
 *
 * Declared explicitly in a blueprint:
 *
 *   apiVersion: agent/v1
 *   kind: InteractSurface
 *   metadata:
 *     name: user
 *   spec: {}
 *
 * then referenced from an agent/posture/skill tooling via `tools: "user/*"`.
 *
 * The runtime emits only generic `fragment` and `activity_resolved` events.
 * This extension:
 *  - creates the InteractionItem for every `interact__*` call directly in
 *    `applyTool` — the SAME path for every kind. Whether the item ends up
 *    pinned (backs its response with a `user-board` activity) or fire-and-
 *    forget is decided by the kind's `pinned` flag in the registry, never by
 *    branching on the tool name. `notify` and `prompt` go through identical
 *    code; only their tool implementation and registered item shape differ;
 *  - subscribes (via `bindToSession`) for the one projection that is NOT a
 *    tool call: a root `AgentMessage` → presentation;
 *  - emits its own `interaction` events for real-time host push (append at
 *    item creation in `applyTool` + presentation in `bindToSession`, update
 *    on resolution);
 *  - delegates the post-resolution reaction to the kind's `reply` hook: the
 *    resource hands it the originating context and the result, and the entry
 *    emits whatever it wants (e.g. `prompt` emits a `UserMessage` so the
 *    user's free-form text becomes a real conversation turn). The resource
 *    never branches on the kind name and never inspects what `reply` did.
 *
 * The item shapes, tool registry and payload builders live in `./items.ts`.
 * The item protocol, the InteractionStream leaf and the `USER_BOARD_ENVIRONMENT`
 * constant + `UserBoardEnvironment` acceptor live in `./state.ts`. None of it
 * is in the harness core: deleting this extension leaves a compilable runtime
 * that simply has no user-facing surface.
 */
import { z } from "zod"
import {
   type ResourceObject,
   type ToolGuide,
   type ToolName,
   type GuardrailDecl,
   type HookEntry,
   type HookTrigger,
} from "../../blueprint/blueprint.ts"
import {
   type ObjectManifest,
   type ObjectMeta,
   type ObjectLoadContext,
   scheme,
   ObjectMetaSchema,
} from "../../blueprint/object-meta.ts"
import { AGENT_API_VERSION } from "../../blueprint/api-version.ts"
import type { AgentContext } from "../../runtime/context.ts"
import type { AgentSession } from "../../runtime/session.ts"
import { type ActivityId } from "../../state/activity.ts"
import type { AnyFragment } from "../../state/fragment.ts"
import { joinLeafPath } from "../../state/tree.ts"
import {
   type InteractionItem,
   type InteractionItemDraft,
   type InteractionProjectionBase,
   type InteractionStream,
   type InteractionItemEvent,
   type RequestStatus,
   InteractionStream as InteractionStreamCtor,
   USER_BOARD_ENVIRONMENT,
   createPresentation,
} from "./state.ts"
import {
   getInteractTools,
   buildInteractionPayload,
   createInteractionItemDraft,
   interactionItemEntryByTool,
} from "./items.ts"

// ── Resource object ───────────────────────────────────────────────────────────

export const InteractSurfaceSpecSchema = z.object({}).passthrough()
export type InteractSurfaceSpec = z.infer<typeof InteractSurfaceSpecSchema>

export const InteractSurfaceManifestSchema = z
   .object({
      apiVersion: z.literal(AGENT_API_VERSION),
      kind: z.literal("InteractSurface"),
      metadata: ObjectMetaSchema,
      spec: InteractSurfaceSpecSchema,
   })
   .passthrough()

export type InteractSurfaceManifest = z.infer<typeof InteractSurfaceManifestSchema>

/**
 * The InteractSurface resource. Publishes the interact__* tools (derived from
 * the registry in ./items.ts) and owns the user-facing projection: items are
 * created in `applyTool` (one path for every kind), a root `AgentMessage` is
 * projected to a presentation in `bindToSession`, and resolutions flip the
 * matching pinned item.
 */
export class InteractSurfaceObject implements ResourceObject {
   readonly apiVersion = AGENT_API_VERSION
   readonly kind = "InteractSurface" as const
   readonly metadata: ObjectMeta
   readonly name: string
   readonly spec: InteractSurfaceSpec

   constructor(metadata: ObjectMeta, spec: InteractSurfaceSpec) {
      this.metadata = metadata
      this.name = metadata.name
      this.spec = spec
   }

   getTools(): ToolGuide[] {
      return [...getInteractTools()]
   }

   getHooks(_trigger: HookTrigger): HookEntry[] {
      return []
   }

   getGuardrails(): GuardrailDecl[] {
      return []
   }

   toManifest(): ObjectManifest {
      return {
         apiVersion: this.apiVersion,
         kind: this.kind,
         metadata: this.metadata,
         spec: this.spec,
      }
   }

   static async fromManifest(
      manifest: InteractSurfaceManifest,
      _ctx: ObjectLoadContext,
   ): Promise<InteractSurfaceObject> {
      return new InteractSurfaceObject(manifest.metadata, manifest.spec)
   }

/**
    * One path for every interact kind. Build the payload, append the item
    * to the context's `/interact` leaf and emit the `interaction` append
    * event. Then, if the kind declares `pinned`, delegate the response to the
    * `user-board` environment (the item is already indexed as pending); else
    * deliver immediately (fire-and-forget). No branching on the kind.
    */
   async applyTool(
      toolName: ToolName,
      params: Record<string, any>,
      context: AgentContext,
      deliveryId?: ActivityId,
   ): Promise<string | undefined> {
      const entry = interactionItemEntryByTool(toolName)
      if (!entry) return undefined

      const payload = buildInteractionPayload(toolName, params)
      const stream = this.acquireStream(context)

      // Pinned kinds bind the item to the activity the harness just allocated
      // (the deliveryId). Non-pinned kinds carry no binding — terminal at append.
      const binding = entry.pinned && deliveryId !== undefined
         ? { activityId: deliveryId }
         : undefined
      const draft = createInteractionItemDraft(
         payload,
         {
            contextId: context.contextId,
            parentId: context.parentId,
            agentName: context.agentName,
         },
         binding,
      )
      const item = stream.appendDraft(draft)
      this.emitInteraction(context, { op: "append", item })

      if (entry.pinned) {
         // Delegates the response to the user-board environment (the kind's
         // `reply` hook, if any, runs when the activity resolves — see
         // `bindToSession`).
         context.delegateActivity(
            {
               environment: USER_BOARD_ENVIRONMENT,
               tool: toolName,
               arguments: params,
               payload,
            },
            deliveryId,
         )
         return deliveryId
      }

      // Fire-and-forget: settle immediately so the loop continues.
      context.deliver(deliveryId, { delivered: true })
      return undefined
   }

   // ── Session binding: project presentation + flip pinned items on resolution ──

/**
    * Subscribe to the session's `fragment` and `activity_resolved` events.
    * Interact items are created in `applyTool` (not here) — the only fragment
    * projection left is a root `AgentMessage` → presentation. On resolution,
    * flip the matching pinned item and call the kind's `reply` hook (which
    * is free to emit whatever fragments it wants on the context). The harness
    * core calls this once per resource after the root context is constructed;
    * the subscription lives for the lifetime of the session.
    */
   bindToSession(session: AgentSession): void {
      // Pre-create the /interact leaf for the root context as a typed
      // InteractionStream so a snapshot restore finds the typed leaf (with
      // its pinned index + seq counter) rather than a plain `Leaf`. Sub-
      // contexts (subagents) create their own lazily on first item append.
      this.acquireStream(session.context)

      session.on("fragment", (e) => {
         const ctx = session.getContext(e.contextId)
         if (!ctx) return
         const draft = this.projectFragment(e.fragment, ctx)
         if (!draft) return
         const stream = this.acquireStream(ctx)
         const item = stream.appendDraft(draft)
         this.emitInteraction(ctx, { op: "append", item })
      })

      session.on("activity_resolved", (e) => {
         const ctx = session.getContext(e.contextId)
         if (!ctx) return
         const reqStatus: RequestStatus = e.status === "completed" ? "resolved" : "failed"
         // Flip the matching pinned item (no-op when this activity isn't a
         // pinned interact one — the leaf lookup misses).
         const stream = this.findStream(ctx)
         if (stream?.updatePinned(e.activityId, reqStatus, e.result)) {
            this.emitInteraction(ctx, {
               op: "update",
               activityId: e.activityId,
               status: reqStatus,
               result: e.result,
            })
         }
         // Post-resolution hook: hand the originating context and the result to
         // the kind's entry; the entry is free to emit whatever fragments it
         // wants (e.g. `prompt` emits a `UserMessage`). The resource never
         // inspects what `reply` did — no kind name branched on here.
         if (e.status === "completed") {
            const cell = ctx.activities.get(e.activityId)
            const entry = cell?.tool ? interactionItemEntryByTool(cell.tool) : undefined
            entry?.reply?.(ctx, e.result)
         }
      })
   }

   // ── Projection (internal: the only non-tool projection left) ──────────────

/**
    * Map a fragment to a user-facing InteractionItem draft. Only one case
    * remains: a root `AgentMessage` → presentation (subagents don't project
    * to chat). Every interact item is created in `applyTool` instead.
    * Returns `undefined` for any other fragment.
    */
   private projectFragment(
      fragment: AnyFragment,
      ctx: AgentContext,
   ): InteractionItemDraft | undefined {
      if (ctx.parentId === null && fragment.kind === "AgentMessage") {
         const base: InteractionProjectionBase = {
            contextId: ctx.contextId,
            parentId: ctx.parentId,
            agentName: ctx.agentName,
         }
         return createPresentation({
            ...base,
            content: fragment.content,
         })
      }
      return undefined
   }

   // ── Per-context /interact leaves on the session tree ─────────────────────
   //
   // The harness core treats every leaf as a generic `Leaf<Cell>`; this
   // extension specialises the leaf at `${scopePath}/interact` to its own
   // `InteractionStream` (which adds seq allocation + pinned index) by
   // passing a custom factory to `tree.acquireLeaf`. The path is a convention
   // between this extension and host UIs — the runtime does not hardcode it.

   private acquireStream(ctx: AgentContext): InteractionStream {
      return ctx.tree.acquireLeaf<InteractionItem>(
         joinLeafPath(ctx.scopePath, "interact"),
         (p, t) => new InteractionStreamCtor(p, t),
      ) as InteractionStream
   }

   private findStream(ctx: AgentContext): InteractionStream | undefined {
      return ctx.tree.findLeaf<InteractionItem>(
         joinLeafPath(ctx.scopePath, "interact"),
      ) as InteractionStream | undefined
   }

   /** Emit an `interaction` mutation on the session's extension event channel. */
   private emitInteraction(
      ctx: AgentContext,
      event: InteractionItemEvent,
   ): void {
      ctx.session.events.emit("interaction", {
         contextId: ctx.contextId,
         parentId: ctx.parentId,
         agentName: ctx.agentName,
         event,
      })
   }
}

/**
 * Register the InteractSurface kind into the shared scheme. The extensions
 * barrel imports this module as a side effect, so the kind is in the scheme
 * as soon as the host entry point imports the barrel.
 */
scheme.register({
   apiVersion: AGENT_API_VERSION,
   kind: "InteractSurface",
   manifestSchema: InteractSurfaceManifestSchema,
   factory: InteractSurfaceObject.fromManifest,
   metadata: {
      role: "Surface d'outils interact__* ; chaque kind décide via `pinned` s'il backe sa réponse par une activité user-board.",
      surface: "Permanent (sélectionné via `tools: \"<name>/*\"`)",
      example: `apiVersion: agent/v1
kind: InteractSurface
metadata:
  name: user
spec: {}`,
      notes: [
         "Publie les six tools interact__* (ask/confirm/todo/alert/notify/prompt).",
         "Chaque entrée du registre déclare `pinned` : true → délègue à `user-board` (item pinned jusqu'à résolution) ; false → livré immédiatement (fire-and-forget, jamais pinned).",
         "Aucun branchement par nom de kind : notify et prompt passent par le même chemin dans applyTool.",
         "La réaction post-résolution (ex. `prompt` émet un `UserMessage`) est portée par le hook `reply` de chaque entrée du registre, jamais par le runtime.",
         "Aucun effet tant qu'aucune entrée `toolset` ne la sélectionne.",
      ],
   },
})
