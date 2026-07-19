/**
 * Runtime scenarios for the `preset` and `skill` resources (see
 * docs/resources.spec.md). Blueprints are built from inline descriptors so the
 * schema + loader + `extends` merge + activation lifecycle are exercised
 * end-to-end against a scripted completion service.
 */
import { describe, it, assert, eq } from "./runner.ts"
import {
   ScriptedCompletionService,
   DirectEchoObject,
   stampDefaultModel,
   injectStubModel,
   waitForSettled,
   threadTypes,
} from "./harness.ts"
import { createBlueprintFrom, type Blueprint } from "../src/blueprint.ts"
import { AgentSession } from "../src/session.ts"
import { PostureObject, SkillObject, AgentObject } from "../src/resources/index.ts"
import { UserBoardEnvironment } from "../src/activity.ts"
import { createToolUse, createAgentMessage, type InstructionFragment } from "../src/fragment.ts"

// Ensure every resource loader (agent/posture/mcp/preset/skill/model) is registered.
import "../src/resources"

/** Async blueprint→session builder (resource factories are async). */
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

describe("preset resource", () => {
   it("agent `extends` a preset: preset instruction becomes a guideline emitted at init", async () => {
      const { session } = await buildFromManifestsAsync([
          {
             apiVersion: "agent/v1",
             kind: "Preset",
             metadata: { name: "shared" },
             spec: { instruction: { content: "Be concise." } },
          },
          {
             apiVersion: "agent/v1",
             kind: "Agent",
             metadata: { name: "a" },
             spec: { extends: ["shared"], instruction: { content: "You are A." } },
          },
      ])

      const settled = waitForSettled(session)
      await session.execute()
      const outcome = await settled
      eq(outcome, "prompt", "session settles on prompt after init")

      const instructions = session.context.thread.fragments.filter(
         (f): f is InstructionFragment => f.type === "Instruction",
      )
      const sources = instructions.map((f) => f.source)
      assert(sources.includes("a"), "persona instruction emitted")
      assert(sources.includes("shared"), "preset guideline instruction emitted")
      assert(
         instructions.some((f) => f.content === "Be concise."),
         "preset guideline content present",
      )
   })

   it("posture `extends` a preset: preset tooling is merged into the posture", async () => {
      const { blueprint } = await buildFromManifestsAsync([
         {
            apiVersion: "agent/v1",
            kind: "Agent",
            metadata: { name: "a" },
            spec: { instruction: { content: "You are A." } },
         },
          {
             apiVersion: "agent/v1",
             kind: "Posture",
             metadata: { name: "p" },
             spec: {
                extends: ["shared"],
                instruction: { content: "posture body" },
                tooling: [],
             },
          },
         {
            apiVersion: "agent/v1",
            kind: "Preset",
            metadata: { name: "shared" },
            spec: { tooling: [{ type: "subagent", agent_id: "researcher" }] },
         },
      ])

      const posture = blueprint.getResource("p") as PostureObject
      assert(posture instanceof PostureObject, "posture object exists")
      const guides = posture.getActiveTooling().map((g) => g.name)
      assert(
         guides.includes("subagent_researcher"),
         "preset tooling merged into posture's active tooling",
      )
   })

   it("agent `extends` a preset: preset tooling becomes the agent's permanent surface", async () => {
      const { blueprint } = await buildFromManifestsAsync([
         {
            apiVersion: "agent/v1",
            kind: "Preset",
            metadata: { name: "shared" },
            spec: {
               tooling: [{ type: "subagent", agent_id: "researcher" }],
            },
         },
          {
             apiVersion: "agent/v1",
             kind: "Agent",
             metadata: { name: "a" },
             spec: { extends: ["shared"], instruction: { content: "You are A." } },
          },
      ])

      const agent = blueprint.getResource("a") as AgentObject
      assert(agent instanceof AgentObject, "agent object exists")
      const guides = agent.getTools().map((g) => g.name)
      assert(
         guides.includes("subagent_researcher"),
         "preset tooling folded onto the agent's permanent surface",
      )
    })

    it("harness/conversational preset exposes the five interact tools via extends", async () => {
       const { blueprint } = await buildFromManifestsAsync([
          {
             apiVersion: "agent/v1",
             kind: "Agent",
             metadata: { name: "a" },
             spec: { extends: ["harness/conversational"], instruction: { content: "You are A." } },
          },
      ])
      const agent = blueprint.getResource("a") as AgentObject
      const names = agent.getTools().map((g) => g.name)
      for (const t of [
         "interact__ask",
         "interact__confirm",
         "interact__todo",
         "interact__notify",
         "interact__message",
      ]) {
         assert(names.includes(t), `harness/conversational exposes ${t}`)
      }
   })

   it("toolset tools harness/<tool> resolves to the harness-published tool", async () => {
      const { blueprint } = await buildFromManifestsAsync([
         {
            apiVersion: "agent/v1",
            kind: "Agent",
            metadata: { name: "a" },
            spec: { instruction: { content: "You are A." } },
         },
         {
            apiVersion: "agent/v1",
            kind: "Posture",
            metadata: { name: "p" },
            spec: {
               instruction: { content: "posture body" },
               tooling: [{ type: "toolset", tools: "harness/interact__ask" }],
            },
         },
      ])
      const posture = blueprint.getResource("p") as PostureObject
      const guides = posture.getActiveTooling().map((g) => g.name)
      assert(guides.includes("interact__ask"), "builtin tool resolved via harness tools")
   })

   it("toolset tools harness/<unknown> fails fast at load", async () => {
      let threw: unknown
      try {
         await buildFromManifestsAsync([
            {
               apiVersion: "agent/v1",
               kind: "Agent",
               metadata: { name: "a" },
               spec: { instruction: { content: "You are A." } },
            },
            {
               apiVersion: "agent/v1",
               kind: "Posture",
               metadata: { name: "p" },
               spec: {
                  instruction: { content: "posture body" },
                  tooling: [{ type: "toolset", tools: "harness/interact__no_such_thing" }],
               },
            },
         ])
      } catch (err) {
         threw = err
      }
      assert(!!threw, "unknown builtin tool throws at load")
      assert(
         (threw as Error).message.includes("Unknown builtin tool"),
         "error message names the failure",
      )
   })

   it("user Preset under harness/ namespace is rejected", async () => {
      let threw: unknown
      try {
         await buildFromManifestsAsync([
            {
               apiVersion: "agent/v1",
               kind: "Preset",
               metadata: { name: "harness/impostor" },
               spec: {},
            },
         ])
      } catch (err) {
         threw = err
      }
      assert(!!threw, "reserved namespace collision throws")
      assert(
         (threw as Error).message.includes("Reserved namespace"),
         "error message names the reserved namespace",
      )
   })
})

describe("skill resource", () => {
   const skillBlueprint = () => [
      {
         apiVersion: "agent/v1",
         kind: "Agent",
         metadata: { name: "a" },
         spec: { instruction: { content: "You are A." }, initial_posture: "p" },
      },
      {
         apiVersion: "agent/v1",
         kind: "Posture",
         metadata: { name: "p" },
         spec: {
            instruction: { content: "posture body" },
            tooling: [{ type: "toolset", tools: "risk/*" }],
         },
      },
      {
         apiVersion: "agent/v1",
         kind: "Skill",
         metadata: { name: "risk" },
         spec: {
            description: "Assess risk",
            instruction: { content: "Assess the risk." },
            tooling: [{ type: "subagent", agent_id: "researcher" }],
         },
      },
   ]

   it("activation emits SkillAttach and exposes the skill's tooling while attached", async () => {
      const { session } = await buildFromManifestsAsync(skillBlueprint(), [
         [createToolUse("u1", "risk", {})],
         [createAgentMessage("done")],
      ])

      const settled = waitForSettled(session)
      await session.execute()
      const outcome = await settled
      eq(outcome, "prompt", "settles after activation turn")

      const types = threadTypes(session)
      assert(types.includes("SkillAttach"), "SkillAttach emitted on activation")
      const attach = session.context.thread.fragments.find((f) => f.type === "SkillAttach") as any
      eq(attach.name, "risk", "attached skill name")
      assert(
         attach.content.includes("Assess the risk."),
         "resolved instruction content attached",
      )

      assert(
         session.context.availableToolNames().includes("subagent_researcher"),
         "skill tooling is available while the skill is attached",
      )
   })

   it("contrast: the skill's tooling is NOT available until the skill is activated", async () => {
      const { session } = await buildFromManifestsAsync(skillBlueprint(), [
         [createAgentMessage("hello")],
      ])
      const settled = waitForSettled(session)
      await session.execute()
      await settled

      assert(
         !session.context.availableToolNames().includes("subagent_researcher"),
         "skill tooling hidden while the skill is inactive",
      )
      const types = threadTypes(session)
      assert(!types.includes("SkillAttach"), "no SkillAttach when skill is never called")
   })

    it("the skill's on_completion hook fires while it is attached", async () => {
       const { session } = await buildFromManifestsAsync(
          [
             {
                apiVersion: "agent/v1",
                kind: "Agent",
                metadata: { name: "a" },
                spec: { instruction: { content: "You are A." }, initial_posture: "p" },
             },
              {
                 apiVersion: "agent/v1",
                 kind: "Posture",
                 metadata: { name: "p" },
                 spec: {
                    instruction: { content: "posture body" },
                    tooling: [{ type: "toolset", tools: "audit/*" }],
                 },
              },
             {
                apiVersion: "agent/v1",
                kind: "Skill",
                metadata: { name: "audit" },
                spec: {
                   instruction: { content: "Audit mode." },
                   hooks: {
                      on_completion: [{ type: "tooluse", tool: "echo__say", args: { message: "audited" } }],
                   },
                },
             },
          ],
          [
             [createToolUse("u1", "audit", {})],
             [createAgentMessage("done")],
          ],
          (bp) => bp.resources.push(new DirectEchoObject()),
      )

      const ends: Array<{ toolName: string }> = []
      session.on("toolend", (e: { toolName: string }) => ends.push({ toolName: e.toolName }))
      const settled = waitForSettled(session)
      await session.execute()
      await settled

       // The skill's on_completion hook fired its tool (echo__say). The model
       // called `audit` then emitted a message, so the only echo__say
       // execution is the hook's.
       assert(ends.some((e) => e.toolName === "echo__say"), "hook fired echo__say")

       // No harness-rooted ToolUse or ToolFeedback was emitted for the hook.
       const hookToolUses = session.context.thread.fragments.filter(
          (f) =>
             f.type === "ToolUse" &&
             (f as any).activityId === session.context.harnessActivityId,
       )
       eq(hookToolUses.length, 0, "no ToolUse fragment for the hook invocation")
       const harnessFeedbacks = session.context.thread.fragments.filter(
          (f) =>
             f.type === "ToolFeedback" &&
             (f as any).activityId === session.context.harnessActivityId,
       )
       eq(harnessFeedbacks.length, 0, "no ToolFeedback for the hook invocation")
    })

   it("legacy inline skill: toolset tools <ref>/* falls back to an instruction template", async () => {
      const { blueprint } = await buildFromManifestsAsync([
         {
            apiVersion: "agent/v1",
            kind: "Agent",
            metadata: { name: "a" },
            spec: { instruction: { content: "You are A." } },
         },
         {
            apiVersion: "agent/v1",
            kind: "Posture",
            metadata: { name: "p" },
            spec: {
               instruction: { content: "posture body" },
               tooling: [{ type: "toolset", tools: "legacy_skill.md/*" }],
            },
         },
      ])
      // No skill object named "legacy_skill.md": the resource part of the
      // pattern resolves to a plain instruction template registered on the
      // collection.
      blueprint.instructions.add("legacy_skill.md", {
         name: "legacy",
         description: "a legacy inline skill",
         instruction: "legacy body",
      })

      const posture = blueprint.getResource("p") as PostureObject
      const guides = posture.getActiveTooling().map((g) => g.name)
      assert(guides.includes("legacy"), "legacy inline skill exposed by template name")
      const skillRes = blueprint.getResource("legacy")
      assert(!(skillRes instanceof SkillObject), "no skill object shadowed the legacy ref")
   })
})

describe("posture route dispatch", () => {
   it("an LLM call to a `type: route` tool activates the target posture", async () => {
      // Reproduces the bug where a route tool exposed by the active posture
      // (via getActiveTooling) could not be resolved by runTool (which only
      // consults getTools, returning [] for postures). The LLM saw the route
      // but invoking it produced "Tool not found: <route>".
      const { session } = await buildFromManifestsAsync(
         [
            {
               apiVersion: "agent/v1",
               kind: "Agent",
               metadata: { name: "a" },
               spec: {
                  instruction: { content: "You are A." },
                  initial_posture: "plan_meal",
               },
            },
            {
               apiVersion: "agent/v1",
               kind: "Posture",
               metadata: { name: "plan_meal" },
               spec: {
                  instruction: { content: "plan the meal" },
                  tooling: [
                     {
                        type: "route",
                        name: "greet",
                        posture: "greet",
                     },
                  ],
               },
            },
            {
               apiVersion: "agent/v1",
               kind: "Posture",
               metadata: { name: "greet" },
               spec: {
                  instruction: { content: "greet the cook" },
                  tooling: [],
               },
            },
         ],
         [
            [createToolUse("u1", "greet", {})],
            [createAgentMessage("done")],
         ],
      )

      const settled = waitForSettled(session)
      await session.execute()
      const outcome = await settled
      eq(outcome, "prompt", "session settles on prompt after route activation turn")

      // The route call produced a ToolFeedback (not a Tool not found error).
      const feedbacks = session.context.thread.fragments.filter(
         (f) => f.type === "ToolFeedback",
      ) as any[]
      const routeFeedback = feedbacks.find((fb) => fb.toolUseId === "u1")
      assert(!!routeFeedback, "route tool call produced feedback")
      assert(routeFeedback.isError !== true, "route call is not an error")

      // The target posture is now active: a PostureUse fragment was emitted
      // for it and currentPosture reflects the transition.
      const postureUses = session.context.thread.fragments.filter(
         (f) => f.type === "PostureUse",
      ) as any[]
      const targetUse = postureUses.find((p) => p.name === "greet")
      assert(!!targetUse, "PostureUse emitted for target posture")
       eq(
          session.context.currentPosture,
          "greet",
          "currentPosture switched to target",
       )
    })
})

describe("agent route dispatch (permanent)", () => {
   it("a `type: route` declared on the agent is reachable from no posture", async () => {
      // Reproduces the bug where the agent's `spec.tooling` was silently
      // ignored: a route declared on the agent (e.g. entry / back-to-root
      // navigation) was neither visible to the LLM nor dispatchable by
      // runTool, which only consulted the active posture's routes.
      const { session } = await buildFromManifestsAsync(
         [
            {
               apiVersion: "agent/v1",
               kind: "Agent",
               metadata: { name: "a" },
               spec: {
                  instruction: { content: "You are A." },
                  // No initial_posture: the agent starts with no active
                  // posture and the route below is the only entry point.
                  tooling: [
                     {
                        type: "route",
                        name: "enter_workflow",
                        posture: "plan_meal",
                        description: "Enter the workflow",
                     },
                  ],
               },
            },
            {
               apiVersion: "agent/v1",
               kind: "Posture",
               metadata: { name: "plan_meal" },
               spec: {
                  instruction: { content: "plan the meal" },
                  tooling: [],
               },
            },
         ],
         [
            [createToolUse("u1", "enter_workflow", {})],
            [createAgentMessage("done")],
         ],
      )

      // The route is visible on the permanent surface (agent.getTools).
      const permanentRoutes = session.context.agent
         .getTools()
         .map((t) => t.name)
      assert(
         permanentRoutes.includes("enter_workflow"),
         "agent.getTools exposes the route permanently",
      )

      const settled = waitForSettled(session)
      await session.execute()
      const outcome = await settled
      eq(outcome, "prompt", "session settles on prompt after route activation turn")

      // The route call produced a non-error ToolFeedback.
      const feedbacks = session.context.thread.fragments.filter(
         (f) => f.type === "ToolFeedback",
      ) as any[]
      const routeFeedback = feedbacks.find((fb) => fb.toolUseId === "u1")
      assert(!!routeFeedback, "route tool call produced feedback")
      assert(routeFeedback.isError !== true, "route call is not an error")

      // The target posture is now active.
      eq(
         session.context.currentPosture,
         "plan_meal",
         "currentPosture switched to target via the agent-declared route",
      )
   })
})

describe("toolset tools selection", () => {
   it("tools <name>/* selects all tools published by the named resource", async () => {
      const { blueprint } = await buildFromManifestsAsync([
         {
            apiVersion: "agent/v1",
            kind: "Agent",
            metadata: { name: "a" },
            spec: { instruction: { content: "You are A." } },
         },
         {
            apiVersion: "agent/v1",
            kind: "Posture",
            metadata: { name: "p" },
            spec: {
               instruction: { content: "posture body" },
               tooling: [{ type: "toolset", tools: "convo/*" }],
            },
         },
         {
            apiVersion: "agent/v1",
            kind: "Memory",
            metadata: { name: "convo" },
            spec: {},
         },
      ])
      const posture = blueprint.getResource("p") as PostureObject
      const names = posture.getActiveTooling().map((g) => g.name).sort()
      eq(names.join(","), "convo__get,convo__set", "all tools from `convo` selected via wildcard")
   })

   it("tools <name>/set,get filters by short suffix", async () => {
      const { blueprint } = await buildFromManifestsAsync([
         {
            apiVersion: "agent/v1",
            kind: "Agent",
            metadata: { name: "a" },
            spec: { instruction: { content: "You are A." } },
         },
         {
            apiVersion: "agent/v1",
            kind: "Posture",
            metadata: { name: "p" },
            spec: {
               instruction: { content: "posture body" },
               tooling: [{ type: "toolset", tools: "convo/set" }],
            },
         },
         {
            apiVersion: "agent/v1",
            kind: "Memory",
            metadata: { name: "convo" },
            spec: {},
         },
      ])
      const posture = blueprint.getResource("p") as PostureObject
      const names = posture.getActiveTooling().map((g) => g.name)
      eq(names.length, 1, "only one tool selected")
      eq(names[0], "convo__set", "selected by short suffix `set` resolves to `convo__set`")
   })

   it("tools referencing an unknown resource throws at resolve time", async () => {
      const { blueprint } = await buildFromManifestsAsync([
         {
            apiVersion: "agent/v1",
            kind: "Agent",
            metadata: { name: "a" },
            spec: { instruction: { content: "You are A." } },
         },
         {
            apiVersion: "agent/v1",
            kind: "Posture",
            metadata: { name: "p" },
            spec: {
               instruction: { content: "posture body" },
               tooling: [{ type: "toolset", tools: "ghost/*" }],
            },
         },
      ])
      const posture = blueprint.getResource("p") as PostureObject
      let threw: unknown
      try {
         posture.getActiveTooling()
      } catch (err) {
         threw = err
      }
       assert(!!threw, "unknown resource in tools throws")
       assert(
          (threw as Error).message.includes("unknown resource"),
          "error message names the missing resource",
       )
   })

   it("tools accepts a list of patterns and aggregates them in order", async () => {
      const { blueprint } = await buildFromManifestsAsync([
         {
            apiVersion: "agent/v1",
            kind: "Agent",
            metadata: { name: "a" },
            spec: { instruction: { content: "You are A." } },
         },
         {
            apiVersion: "agent/v1",
            kind: "Posture",
            metadata: { name: "p" },
            spec: {
               instruction: { content: "posture body" },
               tooling: [
                  {
                     type: "toolset",
                     tools: ["echo/*", "harness/interact__ask"],
                  },
               ],
            },
         },
      ], [], (bp) => bp.resources.push(new DirectEchoObject()))
      const posture = blueprint.getResource("p") as PostureObject
      const names = posture.getActiveTooling().map((g) => g.name).sort()
      eq(names.join(","), "echo__say,interact__ask", "list form aggregates all sources in declaration order")
   })

   it("tools entry rejects combining `tools` and `selector`", async () => {
      let threw: unknown
      try {
         await buildFromManifestsAsync([
            {
               apiVersion: "agent/v1",
               kind: "Agent",
               metadata: { name: "a" },
               spec: { instruction: { content: "You are A." } },
            },
            {
               apiVersion: "agent/v1",
               kind: "Posture",
               metadata: { name: "p" },
               spec: {
                  instruction: { content: "posture body" },
                  tooling: [
                     {
                        type: "toolset",
                        tools: "echo/*",
                        selector: { matchLabels: { app: "echo" } },
                     },
                  ],
               },
            },
         ])
      } catch (err) {
         threw = err
      }
      assert(!!threw, "combining tools and selector throws")
      assert(
         (threw as Error).message.includes("cannot combine"),
         "error message names the conflict",
      )
   })
})

describe("memory resource", () => {
   it("set/get round-trip persists values in the per-context store", async () => {
      const { session } = await buildFromManifestsAsync(
         [
            {
               apiVersion: "agent/v1",
               kind: "Agent",
               metadata: { name: "a" },
               spec: { instruction: { content: "You are A." } },
            },
            {
               apiVersion: "agent/v1",
               kind: "Memory",
               metadata: { name: "convo" },
               spec: {},
            },
         ],
         [
            [createToolUse("u1", "convo__set", { key: "k", value: { v: 42 } })],
            [createToolUse("u2", "convo__get", { key: "k" })],
            [createAgentMessage("done")],
         ],
      )

      const settled = waitForSettled(session)
      await session.execute()
      await settled

      // The set call returns { ok: true }.
      const setFeedback = session.context.thread.fragments.find(
         (f) => f.type === "ToolFeedback" && (f as any).toolUseId === "u1",
      ) as any
      assert(!!setFeedback, "set produced a ToolFeedback")
      assert(setFeedback.isError !== true, "set did not error")
      eq(JSON.stringify(setFeedback.result), JSON.stringify({ ok: true }), "set result is { ok: true }")

      // The get call returns the stored value.
      const getFeedback = session.context.thread.fragments.find(
         (f) => f.type === "ToolFeedback" && (f as any).toolUseId === "u2",
      ) as any
      assert(!!getFeedback, "get produced a ToolFeedback")
      eq(getFeedback.result.value.v, 42, "get returns the stored value")

      // And the store itself reflects the write.
      eq((session.context.memory.get("k") as { v: number } | undefined)?.v, 42, "store reflects the write")
   })

   it("get on an unknown key returns null (not an error)", async () => {
      const { session } = await buildFromManifestsAsync(
         [
            {
               apiVersion: "agent/v1",
               kind: "Agent",
               metadata: { name: "a" },
               spec: { instruction: { content: "You are A." } },
            },
            {
               apiVersion: "agent/v1",
               kind: "Memory",
               metadata: { name: "convo" },
               spec: {},
            },
         ],
         [
            [createToolUse("u1", "convo__get", { key: "missing" })],
            [createAgentMessage("done")],
         ],
      )

      const settled = waitForSettled(session)
      await session.execute()
      await settled

      const feedback = session.context.thread.fragments.find(
         (f) => f.type === "ToolFeedback" && (f as any).toolUseId === "u1",
      ) as any
      assert(!!feedback, "get produced a ToolFeedback")
      assert(feedback.isError !== true, "unknown key is not an error")
      eq(feedback.result.value, null, "unknown key returns null")
   })

   it("memory resource is NOT auto-exposed: requires explicit toolset selection", async () => {
      // Same blueprint, but the second variant declares a toolset selecting
      // the memory resource. Anchors the purely-explicit surface model: a
      // resource publishing tools via getTools() is invisible to the LLM
      // unless a tooling entry selects it.
      const withoutSelection = await buildFromManifestsAsync([
         {
            apiVersion: "agent/v1",
            kind: "Agent",
            metadata: { name: "a" },
            spec: { instruction: { content: "You are A." } },
         },
         {
            apiVersion: "agent/v1",
            kind: "Memory",
            metadata: { name: "convo" },
            spec: {},
         },
      ])
      const surfaceBefore = withoutSelection.session.context.availableToolNames()
      assert(
         !surfaceBefore.includes("convo__set") && !surfaceBefore.includes("convo__get"),
         "memory tools NOT in surface without explicit selection",
      )

      const withSelection = await buildFromManifestsAsync([
         {
            apiVersion: "agent/v1",
            kind: "Agent",
            metadata: { name: "a" },
            spec: {
               instruction: { content: "You are A." },
               initial_posture: "p",
            },
         },
         {
            apiVersion: "agent/v1",
            kind: "Posture",
            metadata: { name: "p" },
            spec: {
               instruction: { content: "posture" },
               tooling: [{ type: "toolset", tools: "convo/*" }],
            },
         },
         {
            apiVersion: "agent/v1",
            kind: "Memory",
            metadata: { name: "convo" },
            spec: {},
         },
      ])
      // The active posture selects the memory resource: tools appear.
      // Execute to settle the initial posture activation.
      const settled = waitForSettled(withSelection.session)
      await withSelection.session.execute()
      await settled
      const surfaceAfter = withSelection.session.context.availableToolNames()
      assert(surfaceAfter.includes("convo__set"), "convo__set exposed once selected")
      assert(surfaceAfter.includes("convo__get"), "convo__get exposed once selected")
   })
})


