import { describe, it, eq, assert } from "./runner.ts"
import { AgentSession } from "../src/runtime/session.ts"
import {
   buildSession,
   registerStandardEnvironments,
   waitForSettled,
   CaptureEnvironment,
} from "./harness.ts"
import {
   createAgentMessage,
   createPostureUse,
   createToolUse,
   type ActivityStartFragment,
} from "../src/state/fragment.ts"
import { MemoryObject } from "../src/extensions/memory/index.ts"
import { InteractSurfaceObject, getInteractStream } from "../src/extensions/interact-surface/index.ts"

/** First activity id for an environment on the root thread. */
function findActivityId(session: AgentSession, environment: string): string | undefined {
   const start = session.context.thread.fragments.find(
      (f): f is ActivityStartFragment =>
         f.kind === "ActivityStart" && f.environment === environment,
   )
   return start?.activityId
}

describe("state tree — serialize / restore", () => {
   it("round-trips thread, posture and resource state through the Tree", async () => {
      const memory = new MemoryObject({ name: "mem" }, {})
      const { session } = await buildSession({ turns: [], resources: [memory] })

      // Populate the tree: a posture transition, a thread fragment, a Memory
      // resource state cell. All land in the root context's leaves.
      session.context.emit(createPostureUse("p", "do p"))
      session.context.emit(createAgentMessage("hi"))
      session.context.setState(memory, { kind: "mem", payload: { k: 42 } })

      const snap = session.serialize()
      eq(snap.agentName, "test-agent", "serialize carries the agent name")
      assert("tree" in snap && "leaves" in snap.tree, "serialize carries the tree")

      // Fresh blueprint (same agent + a fresh Memory resource) for restore.
      const memory2 = new MemoryObject({ name: "mem" }, {})
      const fresh = await buildSession({ turns: [], resources: [memory2] })

      const restored = await AgentSession.restore(snap, fresh.session.blueprint)
      eq(restored.sessionId, session.sessionId, "restore preserves the session id")

      // Thread fragments round-tripped into the live AgentThread leaf.
      const kinds = restored.context.thread.fragments.map((f) => f.kind)
      assert(kinds.includes("PostureUse"), "restored thread has the PostureUse")
      assert(kinds.includes("AgentMessage"), "restored thread has the AgentMessage")

      // Context-intrinsic posture round-tripped via the state cell.
      eq(restored.context.currentPosture, "p", "posture restored")

      // Resource state cell round-tripped, keyed by resource name.
      const cell = restored.context.getState(memory2)
      eq((cell?.payload as { k: number })?.k, 42, "memory state restored")
   })

   it("the root context's interact leaf round-trips presentation items", async () => {
      // The /interact projection is owned by the InteractSurface extension —
      // register one so fragment emission projects to the leaf.
      const { session } = await buildSession({
         turns: [],
         resources: [new InteractSurfaceObject({ name: "user" }, {})],
      })

      // A root AgentMessage projects a presentation onto /interact.
      session.context.emit(createAgentMessage("hello"))
      const before = getInteractStream(session)?.items ?? []
      eq(before.length, 1, "AgentMessage projected to interact")
      eq(before[0].kind, "presentation", "projected item is a presentation")

      const snap = session.serialize()
      const fresh = await buildSession({
         turns: [],
         resources: [new InteractSurfaceObject({ name: "user" }, {})],
      })
      const restored = await AgentSession.restore(snap, fresh.session.blueprint)

      const after = getInteractStream(restored)?.items ?? []
      eq(after.length, 1, "interact leaf restored")
      eq(after[0].kind, "presentation", "restored interact item is a presentation")
      eq((after[0] as { content: string }).content, "hello", "content preserved")
   })

   it("a pending activity resumes across serialize/restore (no promise machinery)", async () => {
      // A turn that delegates to user-board and suspends mid-turn.
      const { session } = await buildSession({
         turns: [[createToolUse("u1", "interact__prompt", { message: "go ahead" })]],
         resources: [new InteractSurfaceObject({ name: "user" }, {})],
      })
      registerStandardEnvironments(session, new CaptureEnvironment())
      await session.execute() // suspends awaiting the user-board activity

      const childId = findActivityId(session, "user-board")
      assert(typeof childId === "string", "a user-board activity is pending mid-turn")

      const snap = session.serialize()

      // Restore against a fresh blueprint whose model produces the resume turn.
      const fresh = await buildSession({
         turns: [[createAgentMessage("resumed after answer")]],
         resources: [new InteractSurfaceObject({ name: "user" }, {})],
      })
      const restored = await AgentSession.restore(snap, fresh.session.blueprint)

      // The activity cell was restored as DATA: the context owns it and is
      // still awaiting — no in-memory graph to reconstruct.
      eq(restored.context.ownsActivity(childId!), true, "activity cell restored")
      eq(restored.context.hasPendingActivities(), true, "context still awaiting")

      // Resolve as the host would (synchronous data mutation), then re-drive
      // the loop. No environment needed on the restored session — the activity
      // already exists; resolution bypasses routing.
      restored.resolveActivity(childId!, "user answer")
      const settled = waitForSettled(restored)
      void restored.execute()
      eq(await settled, "prompt", "loop resumed and settled")

      const types = restored.context.thread.fragments.map((f) => f.kind)
      assert(types.includes("ToolFeedback"), "ToolFeedback emitted for the resumed tool")
      const um = restored.context.thread.fragments.find((f) => f.kind === "UserMessage") as
         | { content: string }
         | undefined
      assert(!!um && um.content === "user answer", "UserMessage carries the user's text")
      assert(types.includes("AgentMessage"), "loop produced a fresh AgentMessage")
       const req = getInteractStream(restored)?.items.find(
          (i): i is { status: string } => "status" in i,
       )
       eq(req?.status, "resolved", "delegated interaction item flipped to resolved")
   })
})
