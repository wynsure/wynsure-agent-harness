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
   CaptureEnvironment,
   buildSession,
   registerStandardEnvironments,
   waitForSettled,
   threadTypes,
} from "./harness.ts"
import { AgentSession } from "../src/session.ts"
import { UserBoardEnvironment } from "../src/activity.ts"
import {
   createToolUse,
   createAgentMessage,
   type ActivityStartFragment,
} from "../src/fragment.ts"

/** Find the first activity id for a given environment on the root thread. */
function findActivityId(session: AgentSession, environment: string): string | undefined {
   const start = session.context.thread.fragments.find(
      (f): f is ActivityStartFragment =>
         f.type === "ActivityStart" && f.environment === environment,
   )
   return start?.activityId
}

describe("Activity execution", () => {
   it("direct tool returns ToolResult and emits ToolFeedback immediately", async () => {
      const { session, completion } = buildSession({
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
      const { session, completion } = buildSession({
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
      const { session } = buildSession({
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
      const outcome = await settled
      eq(outcome, "prompt", "settles after the second resolution")

      const types = threadTypes(session)
      eq(types.filter((t) => t === "ActivityStart").length, 2, "two ActivityStart")
      eq(types.filter((t) => t === "ActivityComplete").length, 2, "two ActivityComplete")
      eq(types.filter((t) => t === "ToolFeedback").length, 2, "two ToolFeedback")
   })

   it("progress: intermediate feedback emits ActivityProgress fragments", async () => {
      const { session } = buildSession({
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

      await settled
      const types = threadTypes(session)
      eq(types.filter((t) => t === "ActivityProgress").length, 2, "two progress fragments")
   })

   it("user-board interaction: interact tool delegates and is resolved out of band", async () => {
      const { session } = buildSession({
         turns: [
            [createToolUse("u1", "interact__ask", { question: "name?" })],
            [createAgentMessage("thanks")],
         ],
      })
      session.registerEnvironment(new UserBoardEnvironment())

      const settled = waitForSettled(session)
      await session.execute()

      const activityId = findActivityId(session, "user-board")
      assert(typeof activityId === "string", "a user-board activity was created")

      const start = session.context.thread.fragments.find(
         (f): f is ActivityStartFragment => f.type === "ActivityStart",
      )!
      eq(start.environment, "user-board", "user-board environment")
      eq(start.parentActivityId, session.context.modelActivityId, "parent is the model root (LLM call)")
      assert(!!start.payload && start.payload.kind === "ask", "payload is the ask interaction")

      session.resolveActivity(activityId, "Alice")
      const outcome = await settled
      eq(outcome, "prompt", "settles after the user answers")

      const types = threadTypes(session)
      assert(types.includes("ToolFeedback"), "user answer wrapped as ToolFeedback")
   })

   it("failed activity: unregistered environment yields an error ToolFeedback", async () => {
      const { session } = buildSession({
         turns: [
            [createToolUse("u1", "test-worker__delegate_task", { task: "x" })],
            [createAgentMessage("recovered")],
         ],
         resources: [new TestWorkerObject()],
      })
      // Only user-board is registered: the test-worker environment is missing.
      session.registerEnvironment(new UserBoardEnvironment())

      const settled = waitForSettled(session)
      await session.execute()

      // The activity failed immediately (env not registered); the loop resumed
      // on its own because there is nothing left pending.
      const outcome = await settled
      eq(outcome, "prompt", "settles after the failed activity")

      const types = threadTypes(session)
      assert(types.includes("ActivityComplete"), "ActivityComplete emitted")
      const fb = session.context.thread.fragments.find(
         (f) => f.type === "ToolFeedback",
      ) as any
      assert(fb && fb.isError === true, "ToolFeedback is an error")
   })
})

function delay(ms: number): Promise<void> {
   return new Promise((r) => setTimeout(r, ms))
}

// Suppress unused import warnings for helpers kept for clarity.
void ScriptedCompletionService
