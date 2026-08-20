/**
 * Runtime scenarios for the steering primitive (host injection into the thread).
 * Covers the idle path (user / instruction shapes), the interrupt path (abort a
 * completion in flight), and the busy-rejection (→ HTTP 409 source).
 */
import { describe, it, assert, eq } from "./runner.ts"
import { type IThreadCompletionService, type CompletionResult } from "../src/runtime/thread.ts"
import { type Fragment, createAgentMessage } from "../src/state/fragment.ts"
import { Blueprint } from "../src/blueprint/blueprint.ts"
import { AgentObject, type AgentSpec } from "../src/runtime/resources/index.ts"
import { AgentSession } from "../src/runtime/session.ts"
import { SteeringBusyError } from "../src/runtime/steering.ts"
import {
   ScriptedCompletionService,
   buildSession,
   injectStubModel,
   STUB_MODEL_NAME,
   waitForSettled,
   threadTypes,
} from "./harness.ts"

/** Build a session bound to a custom completion service (mirror of buildSession). */
async function buildSessionWith(completion: IThreadCompletionService): Promise<AgentSession> {
    const blueprint = new Blueprint()
    blueprint.addResource(
       {
          apiVersion: "test/v1",
          kind: "Agent",
          metadata: { name: "test-agent" },
          spec: { instruction: { content: "You are a test agent." }, model: STUB_MODEL_NAME },
       },
       (m, ctx) =>
          new AgentObject(
             m.metadata,
             m.spec as unknown as AgentSpec,
             {
                persona: { name: "test-agent", instruction: "You are a test agent." },
                guidelines: [],
                tooling: [],
                onStartHooks: [],
                onCompletionHooks: [],
                onToolUseHooks: [],
                onToolErrorHooks: [],
                guardrails: [],
             },
             ctx.session,
          ),
    )
    injectStubModel(blueprint, completion)
    return AgentSession.create(blueprint)
}

interface Deferred<T> {
   promise: Promise<T>
   resolve: (v: T) => void
}
function deferred<T>(): Deferred<T> {
   let resolve!: (v: T) => void
   const promise = new Promise<T>((r) => (resolve = r))
   return { promise, resolve }
}

type Turn =
   | { kind: "immediate"; fragments: Fragment[] }
   | { kind: "blocking" }

/**
 * Completion service whose turns are either immediate or blocking. A blocking
 * turn never resolves on its own — it rejects when its AbortSignal fires,
 * mirroring how the OpenAI client reacts to an aborted request.
 */
class ControllableCompletionService implements IThreadCompletionService {
   private readonly turns: Turn[]
   calls = 0
   /** Resolves once a blocking turn is entered (so a test can steer then). */
   readonly blockingStarted = deferred<void>()

   constructor(turns: Turn[]) {
      this.turns = [...turns]
   }

   async complete(
      _thread: Fragment[],
      _tools: any[],
      signal?: AbortSignal,
   ): Promise<CompletionResult> {
       this.calls++
       const turn = this.turns.shift()
       if (!turn) return { fragments: [] }
       if (turn.kind === "immediate") return { fragments: turn.fragments }
       this.blockingStarted.resolve()
      return new Promise((_resolve, reject) => {
         if (signal?.aborted) return reject(new Error("aborted"))
         signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
      })
   }
}

describe("Steering", () => {
   it("idle steering (as=user) emits a UserMessage and runs a new turn", async () => {
       const { session } = await buildSession({
          turns: [[createAgentMessage("greeting")]],
       })
      const settled = waitForSettled(session)
      await session.execute()
      await settled

      // Loop is idle (prompt) → steering injects and kicks a fresh turn.
      const settled2 = waitForSettled(session)
      session.steer("hello there")
      await settled2

      const types = threadTypes(session)
      assert(types.includes("UserMessage"), "steer emitted a UserMessage")
      const um = session.context.thread.fragments.find((f) => f.kind === "UserMessage") as any
      eq(um?.content, "hello there", "UserMessage carries the steering text")
      assert(types.includes("AgentMessage"), "a fresh completion ran after steering")
   })

   it("idle steering (as=instruction) emits an Instruction tagged steering", async () => {
       const { session } = await buildSession({
          turns: [[createAgentMessage("ok")]],
       })
      const settled1 = waitForSettled(session)
      await session.execute()
      await settled1

      const settled2 = waitForSettled(session)
      session.steer("be terse", { as: "instruction" })
      await settled2

      const instr = session.context.thread.fragments.find(
         (f) => f.kind === "Instruction" && (f as any).source === "steering",
      ) as any
      assert(instr, "Instruction fragment with source=steering was emitted")
      eq(instr.content, "be terse", "Instruction carries the steering text")
   })

   it("steer without interrupt while busy throws SteeringBusyError", async () => {
      const completion = new ControllableCompletionService([
         { kind: "blocking" },
         { kind: "immediate", fragments: [createAgentMessage("done")] },
      ])
       const session = await buildSessionWith(completion)

       const exec = session.execute()
       await completion.blockingStarted // completion #1 in flight

       let threw: unknown
      try {
         session.steer("no interrupt")
      } catch (err) {
         threw = err
      }
      assert(threw instanceof SteeringBusyError, "busy steer without interrupt throws SteeringBusyError")

      // Release the loop so the process can settle: steer with interrupt to finish.
      session.steer("go", { interrupt: true })
      await exec

      assert(session.context.thread.fragments.some((f) => f.kind === "UserMessage"), "interrupt steer landed")
   })

   it("interrupt steering aborts the completion, discards its result, and resumes", async () => {
      const completion = new ControllableCompletionService([
         { kind: "blocking" }, // completion #1: will be aborted, never emits fragments
         { kind: "immediate", fragments: [createAgentMessage("recovered")] }, // completion #2
      ])
       const session = await buildSessionWith(completion)

       const exec = session.execute()
       await completion.blockingStarted // completion #1 in flight

       session.steer("redirect", { interrupt: true })
      await exec

      const types = threadTypes(session)
      // The aborted completion produced no fragments; only the steer + recovery ran.
      assert(types.includes("UserMessage"), "steer injected a UserMessage after the abort")
      const um = session.context.thread.fragments.find((f) => f.kind === "UserMessage") as any
      eq(um?.content, "redirect", "UserMessage carries the interrupt steering text")
      assert(types.includes("AgentMessage"), "the loop resumed and ran a fresh completion")
      eq((session.context.thread.fragments.at(-1) as any)?.content, "recovered", "last fragment is the recovered agent message")
      eq(completion.calls, 2, "two completions consumed (aborted + resumed)")
   })
})
