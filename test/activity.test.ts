/**
 * Runtime scenarios for the Activity execution model. These script the LLM via
 * ScriptedCompletionService and drive delegated activities through capture
 * environments, asserting on the resulting thread and loop resumption.
 */
import { describe, it, assert, eq } from "./runner.ts"
import {
   ScriptedCompletionService,
   TestWorkerObject,
   DirectEchoObject,
   UserAskerObject,
   CaptureEnvironment,
   buildSession,
   registerStandardEnvironments,
   waitForSettled,
   threadTypes,
} from "./harness.ts"
import { AgentSession } from "../src/runtime/session.ts"
import { InteractSurfaceObject } from "../src/extensions/interact-surface/index.ts"
import {
   createToolUse,
   createAgentMessage,
   type ActivityStartFragment,
} from "../src/state/fragment.ts"

/** Find the first activity id for a given environment on the root thread. */
function findActivityId(session: AgentSession, environment: string): string | undefined {
   const start = session.context.thread.fragments.find(
      (f): f is ActivityStartFragment =>
         f.kind === "ActivityStart" && f.environment === environment,
   )
   return start?.activityId
}

describe("Activity execution", () => {
   it("direct tool returns ToolResult and emits ToolFeedback immediately", async () => {
      const { session, completion } = await buildSession({
         turns: [
            [createToolUse("u1", "echo__say", { message: "hi" })],
            [createAgentMessage("done")],
         ],
         resources: [new DirectEchoObject()],
      })

      const settled = waitForSettled(session)
      await session.execute()
      const outcome = await settled

      eq(outcome, "prompt", "should settle on prompt")
      const types = threadTypes(session)
      assert(types.includes("ToolUse"), "ToolUse present")
      assert(types.includes("ToolFeedback"), "ToolFeedback present (direct)")
      assert(!types.includes("ActivityStart"), "no activity created for direct tool")
      assert(types.includes("AgentMessage"), "AgentMessage present")
      eq(completion.callCount, 2, "two completion turns")
   })

   it("delegated tool creates an Activity, resolved feedback resumes the loop", async () => {
      const { session, completion } = await buildSession({
         turns: [
            [createToolUse("u1", "test-worker__delegate_task", { task: "x" })],
            [createAgentMessage("done")],
         ],
         resources: [new TestWorkerObject()],
      })
      const worker = new CaptureEnvironment()
      registerStandardEnvironments(session, worker)

      const settled = waitForSettled(session)
      await session.execute()

      // After execute() the loop has suspended on the in-flight activity.
      eq(worker.assigned.size, 1, "one activity captured")
      const typesAfterExecute = threadTypes(session)
      assert(typesAfterExecute.includes("ActivityStart"), "ActivityStart emitted")
      assert(!typesAfterExecute.includes("ToolFeedback"), "no feedback yet (deferred)")

       const [activityId] = [...worker.assigned.keys()]
       worker.resolve(activityId, { ok: true })
       void session.execute()

       const outcome = await settled
      eq(outcome, "prompt", "should settle on prompt after resolution")

      const types = threadTypes(session)
      const startIdx = types.indexOf("ActivityStart")
      const completeIdx = types.indexOf("ActivityComplete")
      const fbIdx = types.indexOf("ToolFeedback")
      assert(startIdx >= 0 && completeIdx > startIdx, "ActivityComplete after ActivityStart")
      assert(fbIdx > completeIdx, "ToolFeedback after ActivityComplete")
      assert(types.includes("AgentMessage"), "loop resumed to produce AgentMessage")
      eq(completion.callCount, 2, "loop resumed exactly once after resolution")
   })

   it("batch: multiple delegated tools resume only after all resolve", async () => {
      const { session } = await buildSession({
         turns: [
            [
               createToolUse("u1", "test-worker__delegate_task", { task: "a" }),
               createToolUse("u2", "test-worker__delegate_task", { task: "b" }),
            ],
            [createAgentMessage("merged")],
         ],
         resources: [new TestWorkerObject()],
      })
      const worker = new CaptureEnvironment()
      registerStandardEnvironments(session, worker)

      const settled = waitForSettled(session)
      await session.execute()
      eq(worker.assigned.size, 2, "two activities captured")

      // Resolving the first must NOT resume the loop yet.
      const ids = [...worker.assigned.keys()]
      worker.resolve(ids[0], "a")
      const stillWaiting = await Promise.race([
         settled.then(() => false),
         delay(150).then(() => true),
      ])
      assert(stillWaiting, "loop must not resume while an activity is pending")

       worker.resolve(ids[1], "b")
       void session.execute()
       const outcome = await settled
      eq(outcome, "prompt", "settles after the second resolution")

      const types = threadTypes(session)
      eq(types.filter((t) => t === "ActivityStart").length, 2, "two ActivityStart")
      eq(types.filter((t) => t === "ActivityComplete").length, 2, "two ActivityComplete")
      eq(types.filter((t) => t === "ToolFeedback").length, 2, "two ToolFeedback")
   })

   it("progress: intermediate feedback emits ActivityProgress fragments", async () => {
      const { session } = await buildSession({
         turns: [
            [createToolUse("u1", "test-worker__delegate_task", { task: "x" })],
            [createAgentMessage("done")],
         ],
         resources: [new TestWorkerObject()],
      })
      const worker = new CaptureEnvironment()
      registerStandardEnvironments(session, worker)

      const settled = waitForSettled(session)
      await session.execute()
      const [activityId] = [...worker.assigned.keys()]

       worker.progress(activityId, { step: 1 }, 50)
       worker.progress(activityId, { step: 2 }, 90)
       worker.resolve(activityId, "ok")
       void session.execute()

       await settled
      const types = threadTypes(session)
      eq(types.filter((t) => t === "ActivityProgress").length, 2, "two progress fragments")
   })

    it("user-board interaction: a delegating tool delegates and is resolved out of band", async () => {
       const { session } = await buildSession({
          turns: [
             [createToolUse("u1", "interact__ask", { question: "name?" })],
             [createAgentMessage("thanks")],
          ],
          resources: [new UserAskerObject()],
       })
       const userBoard = registerStandardEnvironments(session, new CaptureEnvironment())

       const settled = waitForSettled(session)
       await session.execute()

       const activityId = findActivityId(session, "user-board")
       assert(typeof activityId === "string", "a user-board activity was created")

       const start = session.context.thread.fragments.find(
          (f): f is ActivityStartFragment => f.kind === "ActivityStart",
       )!
       eq(start.environment, "user-board", "user-board environment")
       eq(start.parentActivityId, session.context.modelActivityId, "parent is the model root (LLM call)")
       assert(!!start.payload && start.payload.kind === "ask", "payload is the ask interaction")

        // The host resolves the activity out of band (HTTP /respond, TUI input…).
        userBoard.resolve(activityId, "Alice")
        void session.execute()
        const outcome = await settled
       eq(outcome, "prompt", "settles after the user answers")

       const types = threadTypes(session)
       assert(types.includes("ToolFeedback"), "user answer wrapped as ToolFeedback")
    })

    it("activity_resolved carries the child id the host/projector correlate on", async () => {
       // Regression: activity_resolved must carry the CHILD activity id (the one
       // ActivityStart emits and the host resolves), not the internal delivery
       // id — otherwise the host-side Interaction card never updates.
       const { session } = await buildSession({
          turns: [
             [createToolUse("u1", "interact__ask", { question: "name?" })],
             [createAgentMessage("thanks")],
          ],
          resources: [new UserAskerObject()],
       })
       const userBoard = registerStandardEnvironments(session, new CaptureEnvironment())

       let resolvedId: string | undefined
       session.on("activity_resolved", (e) => {
          resolvedId = e.activityId
       })

       const settled = waitForSettled(session)
       await session.execute()

       const childId = findActivityId(session, "user-board")
       assert(typeof childId === "string", "a user-board activity was created")

        // The host resolves using the child id (from ActivityStart).
        userBoard.resolve(childId!, "Alice")
        void session.execute()
        await settled

       eq(resolvedId, childId, "activity_resolved carries the child id (matches ActivityStart)")
    })

    it("interact__prompt resolution emits a UserMessage carrying the user's text", async () => {
      const { session } = await buildSession({
         turns: [
            [createToolUse("u1", "interact__prompt", { message: "go ahead" })],
            [createAgentMessage("got it")],
         ],
         resources: [new InteractSurfaceObject({ name: "user" }, {})],
      })
      const userBoard = registerStandardEnvironments(session, new CaptureEnvironment())

      const settled = waitForSettled(session)
      await session.execute()

      const activityId = findActivityId(session, "user-board")
      assert(typeof activityId === "string", "a user-board activity was created")

       // The host hands back the user's free-form text.
       userBoard.resolve(activityId, "hello from the user")
       void session.execute()
       const outcome = await settled
      eq(outcome, "prompt", "settles after the user answers")

      const types = threadTypes(session)
      assert(types.includes("ToolFeedback"), "answer still wrapped as ToolFeedback")
      const um = session.context.thread.fragments.find(
         (f) => f.kind === "UserMessage",
      ) as { type: string; content: string } | undefined
      assert(
         !!um && um.content === "hello from the user",
         "a UserMessage carries the user's free-form text",
      )
      // Order matters for the provider: the tool result precedes the user turn.
      const fbIdx = types.indexOf("ToolFeedback")
      const umIdx = types.indexOf("UserMessage")
      assert(fbIdx > -1 && umIdx > fbIdx, "UserMessage emitted after the ToolFeedback")
   })

    it("failed activity: unregistered environment yields an error ToolFeedback", async () => {
       const { session } = await buildSession({
          turns: [
             [createToolUse("u1", "test-worker__delegate_task", { task: "x" })],
             [createAgentMessage("recovered")],
          ],
          resources: [new TestWorkerObject()],
       })
       // No environment registered for "test-worker": the activity fails
       // immediately and the loop resumes on its own.
       session.registerEnvironment(new CaptureEnvironment("user-board"))

       const settled = waitForSettled(session)
       await session.execute()

       // The activity failed immediately (env not registered); the loop resumed
       // on its own because there is nothing left pending.
       const outcome = await settled
       eq(outcome, "prompt", "settles after the failed activity")

       const types = threadTypes(session)
       assert(types.includes("ActivityComplete"), "ActivityComplete emitted")
       const fb = session.context.thread.fragments.find(
          (f) => f.kind === "ToolFeedback",
       ) as any
       assert(fb && fb.isError === true, "ToolFeedback is an error")
    })
})

function delay(ms: number): Promise<void> {
   return new Promise((r) => setTimeout(r, ms))
}

// Suppress unused import warnings for helpers kept for clarity.
void ScriptedCompletionService
