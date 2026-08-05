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
   CaptureEnvironment,
   stampDefaultModel,
   injectStubModel,
   waitForSettled,
   threadTypes,
} from "./harness.ts"
import { createBlueprintFrom, type Blueprint } from "../src/blueprint/blueprint.ts"
import { AgentSession } from "../src/runtime/session.ts"
import { PostureObject, SkillObject, AgentObject } from "../src/blueprint/resources/index.ts"
import { InteractSurfaceObject, InteractSurfaceManifestSchema } from "../src/extensions/interact-surface/index.ts"
import { createToolUse, createAgentMessage, type InstructionFragment } from "../src/state/fragment.ts"

// Ensure every core resource loader (agent/posture/preset/skill) is registered.
import "../src/blueprint/resources"
// Ensure every pluggable resource loader (memory/interact-surface/openai-
// completion/mcp-stdio) is registered too — the harness.ts stub model extends
// BaseModelObject from extensions/openai-completion.
import "../src/extensions"

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
    session.registerEnvironment(new CaptureEnvironment("user-board"))
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
         (f): f is InstructionFragment => f.kind === "Instruction",
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

    it("no builtin catalogue: extends of an undeclared preset fails at load", async () => {
       // The harness ships no presets. Referencing one that is not declared in
       // the blueprint (the former `harness/conversational`) now fails fast.
       let threw: unknown
       try {
          await buildFromManifestsAsync([
             {
                apiVersion: "agent/v1",
                kind: "Agent",
                metadata: { name: "a" },
                spec: { extends: ["harness/conversational"], instruction: { content: "You are A." } },
             },
          ])
       } catch (err) {
          threw = err
       }
       assert(!!threw, "extends of an undeclared preset throws at load")
    })

    it("no builtin catalogue: toolset referencing an undeclared resource fails at resolve time", async () => {
       // There is no virtual `harness` resource anymore. A toolset resolves
       // lazily (when the posture's tooling is collected); an undeclared
       // resource throws at that point.
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
       let threw: unknown
       try {
          posture.getActiveTooling()
       } catch (err) {
          threw = err
       }
       assert(!!threw, "referencing an undeclared resource throws at resolve time")
       assert(
          (threw as Error).message.includes("unknown resource"),
          "error message names the unknown resource",
       )
    })

    it("no reserved namespace: a Preset named harness/* loads like any other", async () => {
       // The reserved harness/ namespace guard is gone with the builtin
       // catalogue. A user Preset under that prefix now loads normally.
       const { blueprint } = await buildFromManifestsAsync([
          {
             apiVersion: "agent/v1",
             kind: "Preset",
             metadata: { name: "harness/impostor" },
             spec: {},
          },
          {
             apiVersion: "agent/v1",
             kind: "Agent",
             metadata: { name: "a" },
             spec: { extends: ["harness/impostor"], instruction: { content: "You are A." } },
          },
       ])
       const agent = blueprint.getResource("a") as AgentObject
       assert(
          (agent as any).status.mergedFrom.includes("harness/impostor"),
          "preset under the former reserved prefix is merged normally",
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
      const attach = session.context.thread.fragments.find((f) => f.kind === "SkillAttach") as any
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
             f.kind === "ToolUse" &&
             (f as any).activityId === session.context.harnessActivityId,
       )
       eq(hookToolUses.length, 0, "no ToolUse fragment for the hook invocation")
       const harnessFeedbacks = session.context.thread.fragments.filter(
          (f) =>
             f.kind === "ToolFeedback" &&
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
         (f) => f.kind === "ToolFeedback",
      ) as any[]
      const routeFeedback = feedbacks.find((fb) => fb.toolUseId === "u1")
      assert(!!routeFeedback, "route tool call produced feedback")
      assert(routeFeedback.isError !== true, "route call is not an error")

      // The target posture is now active: a PostureUse fragment was emitted
      // for it and currentPosture reflects the transition.
      const postureUses = session.context.thread.fragments.filter(
         (f) => f.kind === "PostureUse",
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
         (f) => f.kind === "ToolFeedback",
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
             kind: "Memory",
             metadata: { name: "memory" },
             spec: {},
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
                      tools: ["echo/*", "memory/get"],
                   },
                ],
             },
          },
       ], [], (bp) => bp.resources.push(new DirectEchoObject()))
       const posture = blueprint.getResource("p") as PostureObject
       const names = posture.getActiveTooling().map((g) => g.name).sort()
       eq(names.join(","), "echo__say,memory__get", "list form aggregates all sources in declaration order")
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
         (f) => f.kind === "ToolFeedback" && (f as any).toolUseId === "u1",
      ) as any
      assert(!!setFeedback, "set produced a ToolFeedback")
      assert(setFeedback.isError !== true, "set did not error")
      eq(JSON.stringify(setFeedback.result), JSON.stringify({ ok: true }), "set result is { ok: true }")

      // The get call returns the stored value.
      const getFeedback = session.context.thread.fragments.find(
         (f) => f.kind === "ToolFeedback" && (f as any).toolUseId === "u2",
      ) as any
      assert(!!getFeedback, "get produced a ToolFeedback")
      eq(getFeedback.result.value.v, 42, "get returns the stored value")

      // And the store itself reflects the write.
      const convo = session.blueprint.getResource("convo")!
      const cell = session.context.getState(convo)
      eq((cell?.payload as Record<string, { v: number }> | undefined)?.k?.v, 42, "store reflects the write")
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
         (f) => f.kind === "ToolFeedback" && (f as any).toolUseId === "u1",
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

describe("InteractSurface — spec.tools subset", () => {
   it("omitted spec.tools publishes the full catalogue (9 tools)", () => {
      const surface = new InteractSurfaceObject({ name: "user" }, {})
      const names = surface.getTools().map((g) => g.name).sort()
      eq(
         names.length,
         9,
         "all 9 interact tools exposed when no filter is set",
      )
      assert(names.includes("interact__ask"), "ask is in the default catalogue")
      assert(names.includes("interact__display"), "display is in the default catalogue")
      assert(names.includes("interact__plan"), "plan is in the default catalogue")
      assert(names.includes("interact__announce"), "announce is in the default catalogue")
   })

   it("spec.tools: '*' is equivalent to omitting the field", () => {
      const surface = new InteractSurfaceObject({ name: "user" }, { tools: "*" })
      eq(
         surface.getTools().length,
         9,
         "'*' keeps the full catalogue",
      )
   })

   it("spec.tools: a list of kinds publishes only the matching tools", () => {
      const surface = new InteractSurfaceObject(
         { name: "chat" },
         { tools: ["ask", "confirm", "prompt"] },
      )
      const names = surface.getTools().map((g) => g.name).sort()
      eq(names, ["interact__ask", "interact__confirm", "interact__prompt"])
   })

   it("spec.tools: a kind matches its (single) tool, and a full name matches the same tool", () => {
      // `display` is now a single-tool kind — both spellings resolve to the
      // same tool guide.
      const byKind = new InteractSurfaceObject({ name: "a" }, { tools: ["display"] })
      const byName = new InteractSurfaceObject({ name: "b" }, { tools: ["interact__display"] })
      eq(byKind.getTools().map((g) => g.name), ["interact__display"])
      eq(byName.getTools().map((g) => g.name), ["interact__display"])
   })

   it("fromManifest rejects an unknown tool name at load time", async () => {
      const manifest = InteractSurfaceManifestSchema.parse({
         apiVersion: "agent/v1",
         kind: "InteractSurface",
         metadata: { name: "bad" },
         spec: { tools: ["ask", "does_not_exist"] },
      })
      let threw: unknown
      try {
         await InteractSurfaceObject.fromManifest(manifest, {} as any)
      } catch (err) {
         threw = err
      }
      assert(!!threw, "fromManifest throws on an unknown tool name")
      assert(
         String(threw).includes("does_not_exist"),
         "the error names the offending entry",
      )
   })
})


