/**
 * InteractSurface — upsertable living kinds (`plan`, `announce`).
 *
 * These are fire-and-forget (never pinned, never delegated to user-board) but
 * upsertable: the resource keeps ONE living item per kind and replaces it in
 * place on every call, so the user follows a single evolving indicator. The
 * tests assert the three invariants: non-blocking (loop continues, no
 * activity), single living item (replace in place), and the append→replace
 * event sequence.
 */
import { describe, it, assert, eq } from "./runner.ts"
import {
   buildSession,
   registerStandardEnvironments,
   waitForSettled,
   CaptureEnvironment,
} from "./harness.ts"
import {
   InteractSurfaceObject,
   getInteractions,
   type InteractionItemEvent,
   type PlanItem,
   type AnnounceItem,
} from "../src/extensions/interact-surface/index.ts"
import { createToolUse, createAgentMessage } from "../src/state/fragment.ts"
import type { ActivityStartFragment } from "../src/state/fragment.ts"

describe("InteractSurface — upsertable living kinds", () => {
   it("interact__plan replaces the live plan in place (stable seq, non-blocking)", async () => {
      const events: InteractionItemEvent[] = []
      const { session } = await buildSession({
         turns: [
            [createToolUse("u1", "interact__plan", {
               title: "Build feature",
               steps: [{ label: "design" }, { label: "implement" }, { label: "test" }],
            })],
            [createToolUse("u2", "interact__plan", {
               title: "Build feature",
               steps: [
                  { label: "design", status: "done" },
                  { label: "implement", status: "active" },
                  { label: "test" },
               ],
            })],
            [createAgentMessage("shipped")],
         ],
         resources: [new InteractSurfaceObject({ name: "user" }, {})],
      })
      registerStandardEnvironments(session, new CaptureEnvironment())
      session.events.on("interaction", (e: { event: InteractionItemEvent }) => events.push(e.event))

      const settled = waitForSettled(session)
      await session.execute()
      const outcome = await settled

      // Non-blocking: the loop ran to completion across all three turns.
      eq(outcome, "prompt", "fire-and-forget plan never blocks the loop")
      const start = session.context.thread.fragments.find(
         (f): f is ActivityStartFragment => f.kind === "ActivityStart",
      )
      assert(!start, "no activity created for a fire-and-forget plan")

      // Single living item: the second call replaced the first in place.
      const plans = getInteractions(session).filter((it) => it.kind === "plan")
      eq(plans.length, 1, "exactly one living plan (second call replaced the first)")
      const plan = plans[0] as PlanItem
      eq(plan.steps.length, 3, "three steps")
      eq(plan.steps[0].status, "done", "step 1 advanced to done")
      eq(plan.steps[1].status, "active", "step 2 is active")
      eq(plan.steps[2].status, "pending", "step 3 still pending (defaulted)")

      // Event sequence: first sight → append, second call → replace.
      const planAppends = events.filter((e) => e.op === "append" && e.item.kind === "plan")
      const planReplaces = events.filter((e) => e.op === "replace" && e.item.kind === "plan")
      eq(planAppends.length, 1, "first plan emitted as append")
      eq(planReplaces.length, 1, "second plan emitted as replace")
      eq(planAppends[0].item.seq, planReplaces[0].item.seq, "seq stable across replace")
   })

   it("interact__announce replaces the live focus (one living item)", async () => {
      const { session } = await buildSession({
         turns: [
            [createToolUse("u1", "interact__announce", { action: "searching" })],
            [createToolUse("u2", "interact__announce", { action: "writing report", detail: "draft" })],
            [createAgentMessage("done")],
         ],
         resources: [new InteractSurfaceObject({ name: "user" }, {})],
      })
      registerStandardEnvironments(session, new CaptureEnvironment())

      const settled = waitForSettled(session)
      await session.execute()
      const outcome = await settled
      eq(outcome, "prompt", "fire-and-forget announce never blocks the loop")

      const announces = getInteractions(session).filter((it) => it.kind === "announce")
      eq(announces.length, 1, "exactly one living announce (replaced, not stacked)")
      const a = announces[0] as AnnounceItem
      eq(a.action, "writing report", "replaced with the second action")
      eq(a.detail, "draft", "detail carried through the replace")
   })
})
