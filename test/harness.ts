/**
 * Test helpers for the agent harness: a scripted completion service (replaces
 * the LLM), a resource whose tool delegates to a custom environment, an
 * environment that captures assigned activities so a test can drive them, and
 * session builders.
 */
import { z } from "zod"
import {
   Blueprint,
   type ResourceObject,
   type ToolGuide,
   type ToolOutcome,
   type GuardrailDecl,
   type HookEntry,
   type HookTrigger,
} from "../src/blueprint.ts"
import { AgentObject, AGENT_API_VERSION, type AgentSpec } from "../src/resources/index.ts"
import { BaseModelObject } from "../src/resources/model-base.ts"
import { AgentSession } from "../src/session.ts"
import {
   type IThreadCompletionService,
   type CompletionResult,
} from "../src/thread.ts"
import type { Fragment } from "../src/fragment.ts"
import {
   type Activity,
   type ActivityDelivery,
   type ActivityEnvironment,
   UserBoardEnvironment,
} from "../src/activity.ts"
import type { ObjectManifest } from "../src/object-meta.ts"

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

/** Push a stub model resource providing the given completion service. */
export function injectStubModel(
   blueprint: Blueprint,
   completion: IThreadCompletionService,
): StubModelObject {
   const stub = new StubModelObject(STUB_MODEL_NAME, completion)
   blueprint.resources.push(stub)
   return stub
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
       id: string,
       params: Record<string, unknown>,
    ): Promise<ToolOutcome | undefined> {
       const toolName = id.startsWith(`${this.name}__`)
          ? id.slice(this.name.length + 2)
          : id
       if (toolName === "delegate_task") {
          return {
             environment: "test-worker",
             kind: "delegate_task",
             arguments: params,
          }
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
   async applyTool(id: string, params: Record<string, unknown>): Promise<ToolOutcome | undefined> {
      const toolName = id.startsWith(`${this.name}__`) ? id.slice(this.name.length + 2) : id
      if (toolName === "say") {
         if (this.failOn !== undefined && params.message === this.failOn) {
            return { result: { denied: true }, isError: true }
         }
         return { result: { echoed: params.message ?? "" } }
      }
      return undefined
   }
}

/**
 * Captures every activity assigned to it, exposing the deliveries so a test can
 * push progress / resolve / fail out of band. Mirrors how a real environment
 * would drive an ActivityDelivery.
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
 * The test agent is constructed directly (not via a manifest) since the test
 * fixtures want to inject a synthetic persona without going through file-based
 * instruction resolution.
 */
export function buildSession(opts: BuildSessionOptions): {
    session: AgentSession
    completion: ScriptedCompletionService
} {
    const completion = new ScriptedCompletionService(opts.turns)
    const blueprint = new Blueprint()
     const agent = new AgentObject(
        { name: "test-agent" },
        // Inline instruction content is enough for the synthetic persona; the
        // frontmatter fields are defaulted by Zod at parse time and irrelevant
        // for the test path (the persona is injected directly via runtime).
        {
           instruction: { content: "You are a test agent." },
           model: STUB_MODEL_NAME,
        } as AgentSpec,
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
       )
    blueprint.resources.push(agent)
    injectStubModel(blueprint, completion)
    for (const r of opts.resources ?? []) blueprint.resources.push(r)
    const session = new AgentSession(blueprint)
    return { session, completion }
}

/** Standard environments for tests: the passive user-board + a capturer. */
export function registerStandardEnvironments(
   session: AgentSession,
   capturer: CaptureEnvironment,
): void {
   session.registerEnvironment(new UserBoardEnvironment())
   session.registerEnvironment(capturer)
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
   return session.context.thread.fragments.map((f) => f.type)
}
