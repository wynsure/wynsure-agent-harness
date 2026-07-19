/**
 * Runtime scenarios for the hooks + guardrails overlay. See
 * docs/hooks-guardrails.spec.md. Blueprints are built from inline descriptors
 * so the schema + loader + behavior merge + hook fire + guardrail gate are
 * exercised end-to-end against a scripted completion service.
 */
import { describe, it, assert, eq } from "./runner.ts"
import {
   ScriptedCompletionService,
   DirectEchoObject,
   stampDefaultModel,
   injectStubModel,
   waitForSettled,
} from "./harness.ts"
import { createBlueprintFrom, type Blueprint } from "../src/blueprint.ts"
import { AgentSession } from "../src/session.ts"
import { UserBoardEnvironment } from "../src/activity.ts"
import {
   createToolUse,
   createAgentMessage,
   type ToolUseFragment,
   type ToolFeedbackFragment,
} from "../src/fragment.ts"

// Ensure every resource loader (agent/posture/mcp/preset/skill/model) is registered.
import "../src/resources"

async function buildFromManifestsAsync(
   manifests: unknown[],
   turns: import("../src/fragment").Fragment[][] = [],
   extra?: (bp: Blueprint) => void,
): Promise<{ session: AgentSession; blueprint: Blueprint; completion: ScriptedCompletionService }> {
   stampDefaultModel(manifests)
    const blueprint = await createBlueprintFrom(manifests as any, ".")
    extra?.(blueprint)
    const completion = new ScriptedCompletionService(turns)
    injectStubModel(blueprint, completion)
    const session = new AgentSession(blueprint)
    session.registerEnvironment(new UserBoardEnvironment())
    return { session, blueprint, completion }
}

function toolFeedbacks(session: AgentSession): ToolFeedbackFragment[] {
   return session.context.thread.fragments.filter(
      (f) => f.type === "ToolFeedback",
   ) as ToolFeedbackFragment[]
}

function toolUses(session: AgentSession): ToolUseFragment[] {
   return session.context.thread.fragments.filter(
      (f) => f.type === "ToolUse",
   ) as ToolUseFragment[]
}

/**
 * Captures `toolend` events emitted during execution. Hook-initiated tool
 * calls emit toolstart/toolend (host notification) but no ToolUse/ToolFeedback
 * fragment, so this is how a test observes that a hook actually fired its tool.
 */
function captureToolEnds(session: AgentSession): Array<{ toolName: string; isError?: boolean }> {
   const out: Array<{ toolName: string; isError?: boolean }> = []
   session.on("toolend", (e) => out.push({ toolName: e.toolName, isError: e.isError }))
   return out
}

describe("hook fire — tooluse", () => {
   it("on_completion tooluse hook fires its tool without polluting the thread", async () => {
      const { session } = await buildFromManifestsAsync(
         [
            {
               apiVersion: "agent/v1",
               kind: "Agent",
               metadata: { name: "a" },
               spec: {
                  instruction: { content: "You are A." },
                  initial_posture: "p",
                  hooks: {
                     on_completion: [
                        { name: "log", type: "tooluse", tool: "echo__say", args: { message: "done" } },
                     ],
                  },
               },
            },
            {
               apiVersion: "agent/v1",
               kind: "Posture",
               metadata: { name: "p" },
               spec: { instruction: { content: "posture" } },
            },
         ],
         [[createAgentMessage("hello")]],
         (bp) => bp.resources.push(new DirectEchoObject()),
      )

      const ends = captureToolEnds(session)
      const settled = waitForSettled(session)
      await session.execute()
      await settled

      // The hook's tool (echo__say) executed. The model only emitted an
      // AgentMessage, so the only echo__say execution is the hook's.
      assert(
         ends.some((e) => e.toolName === "echo__say" && !e.isError),
         "hook fired its tool (echo__say) successfully",
      )

      // The hook invocation MUST NOT produce a ToolUse or ToolFeedback.
      const harnessToolUses = toolUses(session).filter(
         (t) => (t as any).activityId === session.context.harnessActivityId,
      )
      eq(harnessToolUses.length, 0, "no harness-rooted ToolUse for the hook")
      const harnessFeedbacks = toolFeedbacks(session).filter(
         (t) => (t as any).activityId === session.context.harnessActivityId,
      )
      eq(harnessFeedbacks.length, 0, "no harness-rooted ToolFeedback for the hook")
   })
})

describe("hook fire — route", () => {
   it("route hook activates the target posture (PostureUse emitted)", async () => {
      const { session } = await buildFromManifestsAsync([
         {
            apiVersion: "agent/v1",
            kind: "Agent",
            metadata: { name: "a" },
            spec: {
               instruction: { content: "You are A." },
               initial_posture: "p1",
               hooks: {
                  on_completion: [{ name: "go2", type: "route", posture: "p2" }],
               },
            },
         },
         {
            apiVersion: "agent/v1",
            kind: "Posture",
            metadata: { name: "p1" },
            spec: { instruction: { content: "posture 1" } },
         },
         {
            apiVersion: "agent/v1",
            kind: "Posture",
            metadata: { name: "p2" },
            spec: { instruction: { content: "posture 2" } },
         },
      ], [[createAgentMessage("hello")]])

      const settled = waitForSettled(session)
      await session.execute()
      await settled

      // PostureUse was emitted as side effect of the route hook.
      const postureUses = session.context.thread.fragments.filter(
         (f) => f.type === "PostureUse",
      ) as Array<{ name: string }>
      assert(postureUses.some((p) => p.name === "p2"), "PostureUse emitted for p2")
   })
})

describe("on_tool_error trigger", () => {
   it("fires when a tool returns isError via direct execution", async () => {
      // Use an unknown tool name so runTool returns an isError ToolResult;
      // that path emits a ToolFeedback and triggers on_tool_error.
      const { session } = await buildFromManifestsAsync(
         [
            {
               apiVersion: "agent/v1",
               kind: "Agent",
               metadata: { name: "a" },
               spec: {
                  instruction: { content: "You are A." },
                  initial_posture: "p",
                  hooks: {
                     on_tool_error: [
                        { name: "log_err", type: "tooluse", tool: "echo__say", args: { message: "recovered" } },
                     ],
                  },
               },
            },
            {
               apiVersion: "agent/v1",
               kind: "Posture",
               metadata: { name: "p" },
               spec: { instruction: { content: "posture" } },
            },
         ],
         [
            [createToolUse("u1", "echo__missing", {})], // unknown subtool → isError
            [createAgentMessage("retrying")],
         ],
         (bp) => bp.resources.push(new DirectEchoObject()),
      )

      const ends = captureToolEnds(session)
      const settled = waitForSettled(session)
      await session.execute()
      await settled

      // The on_tool_error recovery hook fired its tool (echo__say). The model
      // called echo__missing (unknown), so any echo__say execution is the hook.
      assert(
         ends.some((e) => e.toolName === "echo__say"),
         "on_tool_error recovery hook fired echo__say",
      )
   })
})

describe("guardrails — pre-execution gate", () => {
   const guardrailBlueprint = (appliesTo: any, assertion: string, message = "blocked") => [
      {
         apiVersion: "agent/v1",
         kind: "Agent",
         metadata: { name: "a" },
         spec: {
            instruction: { content: "You are A." },
            initial_posture: "p",
            guardrails: [
               { name: "g1", appliesTo, assertion, message },
            ],
         },
      },
      {
         apiVersion: "agent/v1",
         kind: "Posture",
         metadata: { name: "p" },
         spec: { instruction: { content: "posture" } },
      },
   ]

   it("guardrail assertion=false short-circuits: ToolFeedback carries the errors and the tool is not invoked", async () => {
      const { session } = await buildFromManifestsAsync(
         guardrailBlueprint(["echo__say"], "args.message !== 'forbidden'", "Forbidden message"),
         [[createToolUse("u1", "echo__say", { message: "forbidden" })]],
         (bp) => bp.resources.push(new DirectEchoObject()),
      )

      const settled = waitForSettled(session)
      await session.execute()
      await settled

      // The ToolFeedback carries the guardrail errors with isError=true.
      const fb = toolFeedbacks(session).find((f) => f.toolUseId === "u1")
      assert(!!fb, "ToolFeedback present")
      eq(fb!.isError, true, "isError")
      const result = fb!.result as { errors: string[] }
      assert(Array.isArray(result.errors), "errors array in result")
      assert(result.errors.length > 0, "at least one error message")
      assert(result.errors[0].includes("Forbidden"), "rendered message")
   })

   it("guardrail assertion=true lets the tool run normally", async () => {
      const { session } = await buildFromManifestsAsync(
         guardrailBlueprint(["echo__say"], "args.message !== 'forbidden'"),
         [[createToolUse("u1", "echo__say", { message: "ok" })]],
         (bp) => bp.resources.push(new DirectEchoObject()),
      )

      const settled = waitForSettled(session)
      await session.execute()
      await settled

      const fb = toolFeedbacks(session).find((f) => f.toolUseId === "u1")
      assert(!!fb, "ToolFeedback present")
      assert(fb!.isError !== true, "no error")
      assert(
         JSON.stringify(fb!.result).includes("echoed"),
         "tool ran and produced its result",
      )
   })

   it("appliesTo: '*' matches every tool (guardrail blocks)", async () => {
      const { session } = await buildFromManifestsAsync(
         guardrailBlueprint("*", "false", "denied"),
         [[createToolUse("u1", "echo__say", {})]],
         (bp) => bp.resources.push(new DirectEchoObject()),
      )

      const settled = waitForSettled(session)
      await session.execute()
      await settled

      const fb = toolFeedbacks(session).find((f) => f.toolUseId === "u1")
      assert(!!fb, "ToolFeedback present")
      eq(fb!.isError, true, "guardrain applied to all tools → blocked")
      assert(
         JSON.stringify(fb!.result).includes("denied"),
         "guardrail message rendered",
      )
   })

   it("appliesTo: list of tool names selects only those (non-matching tool runs)", async () => {
      const { session } = await buildFromManifestsAsync(
         guardrailBlueprint(["echo__other"], "false", "denied"),
         [[createToolUse("u1", "echo__say", { message: "x" })]],
         (bp) => bp.resources.push(new DirectEchoObject()),
      )

      const settled = waitForSettled(session)
      await session.execute()
      await settled

      // The guardrail does NOT apply to echo__say: the tool runs normally.
      const fb = toolFeedbacks(session).find((f) => f.toolUseId === "u1")
      assert(!!fb, "ToolFeedback present")
      assert(fb!.isError !== true, "guardrail not applied to non-matching tool")
      assert(
         JSON.stringify(fb!.result).includes("echoed"),
         "tool ran and produced its result",
      )
   })

   it("union: a posture guardrail can block a tool (posture guardrails participate)", async () => {
      const { session } = await buildFromManifestsAsync(
         [
            {
               apiVersion: "agent/v1",
               kind: "Agent",
               metadata: { name: "a" },
               spec: {
                  instruction: { content: "You are A." },
                  initial_posture: "p",
                  guardrails: [
                     { name: "agent_g", appliesTo: "*", assertion: "true" },
                  ],
               },
            },
            {
               apiVersion: "agent/v1",
               kind: "Posture",
               metadata: { name: "p" },
               spec: {
                  instruction: { content: "posture" },
                  guardrails: [
                     { name: "posture_g", appliesTo: "*", assertion: "false", message: "posture-denied" },
                  ],
               },
            },
         ],
         [[createToolUse("u1", "echo__say", { message: "x" })]],
         (bp) => bp.resources.push(new DirectEchoObject()),
      )

      const settled = waitForSettled(session)
      await session.execute()
      await settled

      // The posture's guardrail (assertion:false) blocks the tool — proving
      // posture guardrails are part of the evaluation set, not just the agent's.
      const fb = toolFeedbacks(session).find((f) => f.toolUseId === "u1")
      assert(!!fb, "ToolFeedback present")
      eq(fb!.isError, true, "posture guardrail blocked the tool")
      assert(
         JSON.stringify(fb!.result).includes("posture-denied"),
         "posture guardrail message rendered",
      )
   })
})

describe("on_tool_use hook — pre-execution via hook", () => {
   it("a hook returning isError blocks the tool; errors flow into ToolFeedback", async () => {
      // The hook invokes echo__say; the synthetic tool returns isError when
      // message === 'block'. That error becomes the gate's verdict.
      const { session } = await buildFromManifestsAsync(
         [
            {
               apiVersion: "agent/v1",
               kind: "Agent",
               metadata: { name: "a" },
               spec: {
                  instruction: { content: "You are A." },
                  initial_posture: "p",
                  hooks: {
                     on_tool_use: [
                        { name: "gate", type: "tooluse", tool: "echo__say", args: { message: "block" } },
                     ],
                  },
               },
            },
            {
               apiVersion: "agent/v1",
               kind: "Posture",
               metadata: { name: "p" },
               spec: { instruction: { content: "posture" } },
            },
         ],
         [[createToolUse("u1", "echo__say", { message: "forbidden" })]],
         (bp) => bp.resources.push(new DirectEchoObject({ failOn: "block" })),
      )

      const ends = captureToolEnds(session)
      const settled = waitForSettled(session)
      await session.execute()
      await settled

      // The gate hook fired its tool (echo__say) and it failed.
      const gateEnd = ends.find((e) => e.toolName === "echo__say")
      assert(!!gateEnd, "on_tool_use hook fired echo__say")
      eq(gateEnd!.isError, true, "hook tool returned isError")

      // ToolFeedback carries the gate's errors (the controlled tool is blocked).
      const fb = toolFeedbacks(session).find((f) => f.toolUseId === "u1")
      assert(!!fb, "ToolFeedback present")
      eq(fb!.isError, true, "isError (tool was blocked)")
      const result = fb!.result as { errors: string[] }
      assert(Array.isArray(result.errors), "errors array")
      assert(result.errors.length > 0, "error message captured")
   })
})
