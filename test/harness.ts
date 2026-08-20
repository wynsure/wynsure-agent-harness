/**
 * Test helpers for the agent harness: a scripted completion service (replaces
 * the LLM), a resource whose tool delegates to a custom environment, an
 * environment that captures assigned activities so a test can drive them, and
 * session builders.
 */
import { z } from "zod"
import { Blueprint } from "../src/blueprint/blueprint.ts"
import type { ResourceObject } from "../src/runtime/resource.ts"
import type { ToolGuide, ToolName } from "../src/runtime/tool.ts"
import type {
   GuardrailDecl,
   HookEntry,
   HookTrigger,
} from "../src/blueprint/blueprint-schema.ts"
import type { AgentContext } from "../src/runtime/context.ts"
import { AgentObject, type AgentSpec } from "../src/runtime/resources/index.ts"
import { AGENT_API_VERSION } from "../src/blueprint/api-version.ts"
import { BaseModelObject } from "../src/extensions/openai-completion/model-base.ts"
import { AgentSession } from "../src/runtime/session.ts"
import {
   type IThreadCompletionService,
   type CompletionResult,
} from "../src/runtime/thread.ts"
import type { Fragment } from "../src/state/fragment.ts"
import {
   type Activity,
   type ActivityDelivery,
   type ActivityEnvironment,
} from "../src/state/activity.ts"
import type { ObjectManifest } from "../src/blueprint/object-meta.ts"

/**
 * Replays a scripted list of completion turns. Each call to complete() pops the
 * next turn. An empty queue returns an empty fragment list (ends the loop).
 */
export class ScriptedCompletionService implements IThreadCompletionService {
   private readonly turns: CompletionResult[]
   private calls = 0
   constructor(turns: Fragment[][]) {
      this.turns = turns.map((fragments) => ({ fragments }))
   }
   async complete(): Promise<CompletionResult> {
      this.calls++
      return this.turns.shift() ?? { fragments: [] }
   }
    get callCount(): number {
       return this.calls
    }
}

/** Canonical name for the stub model injected by test session builders. */
export const STUB_MODEL_NAME = "test-model"

/**
 * A Model resource backed by an injected completion service (test double). Lets
 * tests drive the run loop with a scripted/controllable service while still
 * exercising the full declarative resolution path (agent `spec.model` →
 * `getService(ThreadCompletionService)`), so the harness never special-cases
 * tests vs. real blueprints. Extends `BaseModelObject` to reuse the real
 * capability/cache mechanics.
 */
export class StubModelObject extends BaseModelObject {
   readonly apiVersion = AGENT_API_VERSION
   readonly kind = "StubModel" as const
   constructor(
      name: string,
      private readonly injected: IThreadCompletionService,
   ) {
      super({ name }, {})
   }
   protected buildCompletion(): IThreadCompletionService {
      return this.injected
   }
}

/**
 * Stamp a default model reference onto every Agent manifest that lacks one, so
 * inline test manifests stay focused on the feature under test. Call before
 * `createBlueprintFrom`.
 */
export function stampDefaultModel(manifests: unknown[]): void {
   for (const m of manifests as Array<Record<string, any>>) {
      if (m && m.kind === "Agent") {
         m.spec ??= {}
         if (!m.spec.model) m.spec.model = STUB_MODEL_NAME
      }
   }
}

/**
 * Push a stub model resource providing the given completion service. The stub
 * is registered as a descriptor whose factory returns the pre-built instance,
 * so sessions instantiate it through the same seam as real resources.
 */
export function injectStubModel(
    blueprint: Blueprint,
    completion: IThreadCompletionService,
): StubModelObject {
    const stub = new StubModelObject(STUB_MODEL_NAME, completion)
    blueprint.addResource(
       {
          apiVersion: "test/v1",
          kind: "StubModel",
          metadata: { name: STUB_MODEL_NAME },
          spec: {},
       },
       () => stub,
    )
    return stub
}

/**
 * Register a pre-built resource object on a blueprint as a descriptor whose
 * factory returns the instance — the test-side equivalent of a manifest-loaded
 * resource.
 */
export function pushResourceObject(blueprint: Blueprint, obj: ResourceObject): void {
    blueprint.addResource(obj.toManifest(), () => obj)
}

/**
 * A synthetic resource that exposes a single tool, `test-worker__delegate_task`,
 * which always delegates to the "test-worker" environment. Used to exercise the
 * delegated-execution path without an MCP server. Not loaded from a manifest —
 * its apiVersion/kind/metadata satisfy the ResourceObject contract minimally.
 */
export class TestWorkerObject implements ResourceObject {
   readonly apiVersion = "test/v1"
   readonly kind = "TestWorker"
   readonly metadata = { name: "test-worker" }
   readonly name = "test-worker"
   getTools(): ToolGuide[] {
      return [
         {
            name: "test-worker__delegate_task",
            intent: "Delegate a task to the test worker environment",
            input: z.object({ task: z.string() }),
         },
      ]
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
          spec: {},
       }
    }
    async applyTool(
       toolName: ToolName,
       params: Record<string, unknown>,
       context: AgentContext,
       deliveryId?: string,
    ): Promise<string | undefined> {
       const name = toolName.startsWith(`${this.name}__`)
          ? toolName.slice(this.name.length + 2)
          : toolName
       if (name === "delegate_task") {
          context.delegateActivity(
             { environment: "test-worker", kind: "delegate_task", arguments: params },
             deliveryId,
          )
          return deliveryId
       }
       return undefined
    }
 }

/**
 * A synthetic resource that publishes `interact__ask` and delegates it to the
 * "user-board" environment, embedding the args as the activity payload. This
 * mirrors the shape a host-provided interaction surface (e.g. the CLI's
 * InteractSurface kind) would expose: a tool whose applyTool returns an
 * ActivitySpec toward a named environment. Used to exercise user-board-style
 * delegation without depending on any builtin catalogue.
 */
export class UserAskerObject implements ResourceObject {
   readonly apiVersion = "test/v1"
   readonly kind = "UserAsker"
   readonly metadata = { name: "user" }
   readonly name = "user"
   getTools(): ToolGuide[] {
      return [
         {
            name: "interact__ask",
            intent: "Ask the user a question",
            input: z.object({ question: z.string() }),
         },
      ]
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
         spec: {},
      }
   }
    async applyTool(
       toolName: ToolName,
       params: Record<string, unknown>,
       context: AgentContext,
       deliveryId?: string,
    ): Promise<string | undefined> {
       if (toolName === "interact__ask") {
          context.delegateActivity(
             {
                environment: "user-board",
                kind: "interact__ask",
                arguments: params,
                payload: { kind: "ask", question: params.question ?? "" },
             },
             deliveryId,
          )
          return deliveryId
       }
       return undefined
    }
}

/**
 * A synthetic resource that resolves a tool synchronously (direct execution
 * path), returning a fixed ToolResult. See TestWorkerObject for the contract
 * rationale. The optional `failOn` ctor arg flips the result to isError when
 * `params.message === failOn`, used by hook tests to simulate a verification
 * gate that rejects.
 */
export class DirectEchoObject implements ResourceObject {
   readonly apiVersion = "test/v1"
   readonly kind = "Echo"
   readonly metadata = { name: "echo" }
   readonly name = "echo"
   private readonly failOn?: string
   constructor(opts?: { failOn?: string }) {
      this.failOn = opts?.failOn
   }
   getTools(): ToolGuide[] {
      return [
         {
            name: "echo__say",
            intent: "Echo back the message",
            input: z.object({ message: z.string() }),
         },
      ]
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
         spec: {},
      }
   }
    async applyTool(
       toolName: ToolName,
       params: Record<string, unknown>,
       context: AgentContext,
       deliveryId?: string,
    ): Promise<string | undefined> {
       const name = toolName.startsWith(`${this.name}__`)
          ? toolName.slice(this.name.length + 2)
          : toolName
       if (name === "say") {
          if (this.failOn !== undefined && params.message === this.failOn) {
             context.deliver(deliveryId, { denied: true }, true)
          } else {
             context.deliver(deliveryId, { echoed: params.message ?? "" })
          }
       }
       return undefined
    }
}

/**
 * Captures every activity assigned to it, exposing the deliveries so a test can
 * push progress / resolve / fail out of band. Mirrors how a real environment
 * would drive an ActivityDelivery. Generic: the name is configurable so a test
 * can stand in for any environment ("user-board", "test-worker", …).
 */
export class CaptureEnvironment implements ActivityEnvironment {
   readonly name: string
   readonly assigned = new Map<string, { activity: Activity; delivery: ActivityDelivery }>()
   constructor(name = "test-worker") {
      this.name = name
   }
   assign(activity: Activity, delivery: ActivityDelivery): void {
      this.assigned.set(activity.activityId, { activity, delivery })
   }
   resolve(activityId: string, result: unknown): void {
      const entry = this.assigned.get(activityId)
      if (!entry) return
      this.assigned.delete(activityId)
      entry.delivery.complete(result)
   }
   fail(activityId: string, error: unknown): void {
      const entry = this.assigned.get(activityId)
      if (!entry) return
      this.assigned.delete(activityId)
      entry.delivery.fail(error)
   }
   progress(activityId: string, feedback: unknown, progress?: number): void {
      this.assigned.get(activityId)?.delivery.progress(feedback, progress)
   }
}

export interface BuildSessionOptions {
   turns: Fragment[][]
   resources?: ResourceObject[]
}

/**
 * Builds a session with a minimal "test-agent" object (persona only) plus any
 * extra resources, wired to a ScriptedCompletionService. Callers register their
 * own environments (test-worker, user-board, …) on the returned session.
 *
 * Every pre-built object is registered as a descriptor whose factory returns
 * it (or constructs it with `ctx.session` when it needs the session), so the
 * session instantiates them through the same seam as manifest-loaded
 * resources.
 */
export async function buildSession(opts: BuildSessionOptions): Promise<{
    session: AgentSession
    completion: ScriptedCompletionService
}> {
    const completion = new ScriptedCompletionService(opts.turns)
    const blueprint = new Blueprint()
    blueprint.addResource(
       {
          apiVersion: "test/v1",
          kind: "Agent",
          metadata: { name: "test-agent" },
          spec: {
             // Inline instruction content is enough for the synthetic persona;
             // the persona itself is injected directly via runtime below.
             instruction: { content: "You are a test agent." },
             model: STUB_MODEL_NAME,
          },
       },
       (m, ctx) =>
          new AgentObject(
             m.metadata,
             m.spec as unknown as AgentSpec,
             {
                persona: {
                   name: "test-agent",
                   instruction: "You are a test agent.",
                },
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
    for (const r of opts.resources ?? []) {
       blueprint.addResource(r.toManifest(), () => r)
    }
    const session = await AgentSession.create(blueprint)
    return { session, completion }
}

/**
 * Standard environments for tests: a capturer standing in for "user-board"
 * (resolved out of band, like a host would) plus the worker capturer. Returns
 * the user-board capturer so a test can drive its activities.
 */
export function registerStandardEnvironments(
   session: AgentSession,
   capturer: CaptureEnvironment,
): CaptureEnvironment {
   const userBoard = new CaptureEnvironment("user-board")
   session.registerEnvironment(userBoard)
   session.registerEnvironment(capturer)
   return userBoard
}

/**
 * Resolves when the root context reaches a terminal stopping point (prompt or
 * terminated). Used to await loop resumption after driving activities.
 */
export function waitForSettled(
   session: AgentSession,
   timeoutMs = 2000,
): Promise<"prompt" | "terminated"> {
   return new Promise((resolve, reject) => {
      const root = session.context.contextId
      const timer = setTimeout(() => {
         cleanup()
         reject(new Error(`waitForSettled timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      const onPrompt = (e: { contextId?: string }) => {
         if (e.contextId !== root) return
         cleanup()
         resolve("prompt")
      }
      const onTerm = (e: { contextId?: string }) => {
         if (e.contextId !== root) return
         cleanup()
         resolve("terminated")
      }
      function cleanup(): void {
         clearTimeout(timer)
         session.off("prompt", onPrompt)
         session.off("terminated", onTerm)
      }
      session.on("prompt", onPrompt)
      session.on("terminated", onTerm)
   })
}

/** Types of the fragments currently on the root thread, in order. */
export function threadTypes(session: AgentSession): string[] {
   return session.context.thread.fragments.map((f) => f.kind)
}
