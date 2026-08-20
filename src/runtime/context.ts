import type { AgentSession, LogEntry, ContextId, ContextRef } from "./session.ts"
import type { HookTrigger } from "../blueprint/blueprint-schema.ts"
import {
   type Fragment,
   type AnyFragment,
   type ToolUseFragment,
   type FragmentKind,
   createInstruction,
   createToolFeedback,
   createToolUse,
   createUserMessage,
   createSkillDetach,
   createPostureExit,
   createSubagentSpawn,
   createSubagentComplete,
   createActivityStart,
   createActivityProgress,
   createActivityComplete,
} from "../state/fragment.ts"
import type {
   AgentBehavior,
   ResourceObject,
} from "./resource.ts"
import type { ToolGuide, ToolName } from "./tool.ts"
import {
   AgentThread,
   ThreadCompletionService,
   type CompletionResult,
   type IThreadCompletionService,
   type TokenUsage,
} from "./thread.ts"
import { isDebugMode, writeTraceFile, logsDir, logger } from "../system/logger.ts"
import { resolve } from "path"
import { stringify } from "yaml"
import { AgentObject } from "./resources/agent.ts"
import { PostureObject } from "./resources/posture.ts"
import { SkillObject } from "./resources/skill.ts"
import type {
   GuardrailDecl,
   HookEntry,
   GuardrailAppliesTo,
} from "../blueprint/blueprint-schema.ts"
import { labelSelectorMatches, type LabelSelector } from "../blueprint/object-meta.ts"
import { evaluateCondition, renderTemplate } from "../blueprint/scripting.ts"
import { type Activity, type ActivityChildSpec, type ActivityDelivery, type ActivityId, type EnvironmentName, type ToolUseId } from "../state/activity.ts"
import {
   type SteeringShape,
   type SteerOptions,
   SteeringBusyError,
} from "./steering.ts"
import { type Tree, joinLeafPath } from "../state/tree.ts"
import { type Cell, type Leaf, type StateCell } from "../state/leaf.ts"

// ─── Activity-root selection ───────────────────────────────────────────────

/**
 * Fragment types produced by LLM generation default to the `modelActivityId`
 * root. Everything else (instruction, user message, hook audit, memory,
 * subagent) defaults to `harnessActivityId`. The caller can
 * still override by setting `fragment.activityId` explicitly.
 */
const MODEL_ROOTED_TYPES = new Set<FragmentKind>([
   "AgentMessage",
   "Thinking",
   "Reference",
   "ToolUse",
   "ToolFeedback",
])

function fragmentPreview(f: AnyFragment): string {
   switch (f.kind) {
      case "Instruction":
         return `[📜 Instruction] ${f.source ?? "instruction"}`
      case "PostureUse":
         return `[🧭 PostureUse] ${f.name}`
      case "PostureExit":
         return `[🔚 PostureExit] ${f.name}`
      case "SkillAttach":
         return `[🎓 SkillAttach] ${f.name}`
      case "SkillDetach":
         return `[✖️ SkillDetach] ${f.name}`
      case "ToolUse":
         return `[🛠️  ToolUse] ${f.toolName} <${f.id.slice(0, 5)}>`
      case "ToolFeedback":
         return `[📥 ToolFeedback] <${f.toolUseId.slice(0, 5)}>`
      case "Thinking":
         return "[🧠 Thinking]"
      case "AgentMessage":
         return "[🤖 AgentMessage]"
      case "UserMessage":
         return "[👤 UserMessage]"
      case "Reference":
         return `[🔗 Reference] ${f.uri}`
      case "SubagentSpawn":
         return `[◉ SubagentSpawn] ${f.agentId} → ${f.contextId}`
      case "SubagentComplete":
         return `[◉ SubagentComplete] ${f.agentId} (${f.status})`
      case "ActivityStart":
         return `[↗ ActivityStart] ${f.environment}/${f.tool} <${f.activityId.slice(-5)}>`
      case "ActivityProgress":
         return `[↪ ActivityProgress] <${f.activityId.slice(-5)}>`
      case "ActivityComplete":
         return `[↙ ActivityComplete] <${f.activityId.slice(-5)}> ${f.status}`
      case "Opaque":
         return `[📦 Opaque]${f.label ? ` ${f.label}` : ""}`
      default:
         return ""
   }
}

function toYamlDoc(value: unknown): string {
   return `---\n${stringify(value).trimEnd()}`
}

const STIMULUS_TYPES = new Set([
   "PostureUse",
   "SkillAttach",
   "Instruction",
   "Reference",
])

function hasStimulus(fragments: Fragment[]): boolean {
   return fragments.some((f) => STIMULUS_TYPES.has(f.kind))
}

/** Reduce a hook's terminal payload to a single error message string. */
function asErrorMessage(payload: any): string {
   if (typeof payload === "string") return payload
   if (payload?.error) return String(payload.error)
   if (payload?.message) return String(payload.message)
   return JSON.stringify(payload)
}

export type RunOutcome =
   | { kind: "terminated" }
   | { kind: "awaiting_activities"; pending: ActivityId[] }
   | { kind: "prompt" }

type HookOutcome =
   | { kind: "continue" }
   | { kind: "exit" }

/**
 * Result of firing a hook trigger. `errors` is set when the trigger is
 * `on_tool_use` and a hook's tooluse returned isError (the controlled tool
 * must be blocked). Otherwise the fire completed normally.
 */
interface HookFireResult {
   outcome: HookOutcome
   /** Set iff a hook returned isError and the tool must be blocked. */
   errors?: string[]
}

/** Outcome of executing a tool invocation, as seen by the runLoop. */
interface UseResult {
   /** True when the delivery settled inline (sync); false when deferred. */
   settled: boolean
   /** Error flag of the inline settlement (meaningful when settled). */
   isError: boolean
   /** Terminal payload of the inline settlement (the delivered result). */
   result?: any
}

/**
 * A guardrail with its owner resolved, ready for evaluation against a tool.
 * The owner name is used to build the fully-qualified audit name.
 */
interface ResolvedGuardrail {
   owner: string
   decl: GuardrailDecl
}

const DEFAULT_MAX_TOOL_ROUNDS = 10

export interface AgentContextOptions {
   parentId?: ContextId
   /** The agent resource this context is an instance of. */
   agent: AgentObject
   agentName?: string
}

/**
 * Activity cell at `${contextPath}/activities` (kind = activity id). Collapses
 * the former delivery/child pair into one serializable record: the routing
 * (environment/tool/args/payload), the ToolFeedback correlation (toolUseId +
 * parentRoot), the completion effect kind, and the terminal result. The whole
 * lifecycle is synchronous data mutation — no gate, await graph, or promise.
 */
export interface ActivityCell extends Cell {
   status: "pending" | "completed" | "failed"
   parentRoot: ActivityId
   toolUseId?: ToolUseId
   toolName?: ToolName
   environment?: EnvironmentName
   tool?: string
   arguments?: Record<string, any>
   payload?: any
   result?: any
   isError?: boolean
}

export class AgentContext {
   readonly tree: Tree
   readonly scopePath: string
   readonly thread: AgentThread
   readonly contextId: ContextId
   readonly parentId: ContextId | null
   readonly agentName: string
   readonly agent: AgentObject
   /**
    * The thread completion service this context drives its run loop with.
    * Resolved eagerly (by contract) from the agent's declared model resource,
     * so a missing or invalid model reference fails fast at session creation.
     * See docs/architecture.spec.md § "ServiceContract".
    */
   private readonly completionService: IThreadCompletionService
   readonly tracePath: string
   /**
    * Activity id root for fragments produced by the LLM (AgentMessage,
    * Thinking, Reference, ToolUse emitted by the provider, ToolFeedback
    * answering an LLM tool call). Filtered by the provider as "assistant"
    * contributions in the next request.
    */
    readonly modelActivityId: ActivityId
    /**
     * Activity id root for fragments produced by the harness (Instruction,
     * UserMessage, PostureUse, SkillAttach, hook-originated tool calls,
     * Activity audit, Subagent*). Filtered by the
     * provider as "context/audit" — never mapped as assistant messages.
     */
     readonly harnessActivityId: ActivityId
     /** Backing token-usage state, persisted as cell `__tokenUsage`. */
    get tokenUsage(): TokenUsage {
       return (
          this.getIntrinsic<TokenUsage>("__tokenUsage") ?? {
             inputTokens: 0,
             cachedTokens: 0,
             outputTokens: 0,
          }
       )
    }
    set tokenUsage(u: TokenUsage) {
       this.setIntrinsic("__tokenUsage", u)
    }
    /** Activities this context owns, as cells at /activities (data, serializable). */
    readonly activities: Leaf<ActivityCell>
    /** Activity ids this context delegated (transient: progress/audit routing). */
    private readonly children = new Set<ActivityId>()
    /** Idempotency guard for one-shot ActivityComplete emission. */
    private readonly completedChildren = new Set<ActivityId>()
    /** True while a runLoop is executing; guards against double resumption. */
   private running = false
   /** Abort controller for the current completion, if one is in flight. */
   private completionAbort: AbortController | null = null
   /** Steering injection queued while a completion was aborted; flushed at loop top. */
   private pendingSteer: { text: string; as: SteeringShape } | null = null
   /** Set when a completion abort was requested by steer() (vs. a real error). */
   private steerAbortRequested = false
   /**
    * Reentrancy guard for `on_tool_error`: a hook firing on a tool error that
    * itself fails must not re-trigger on_tool_error (infinite cascade).
    */
   private firingToolError = false

   constructor(
      readonly session: AgentSession,
      opts: AgentContextOptions,
   ) {
       this.parentId = opts.parentId ?? null
       this.agent = opts.agent
       this.agentName = opts.agentName ?? session.agentName
       this.contextId = session.allocId("ctx")
       this.tree = session.tree
       // Scope path: root context owns "/"; a subagent nests under its parent.
       const parent = this.parentId ? session.getContext(this.parentId) : undefined
       this.scopePath = parent ? joinLeafPath(parent.scopePath, this.contextId) : "/"
       this.thread = this.tree.acquireLeaf<Fragment>(
          joinLeafPath(this.scopePath, "thread"),
          (p, t) => new AgentThread(p, t),
       ) as AgentThread
       this.activities = this.tree.acquireLeaf<ActivityCell>(
          joinLeafPath(this.scopePath, "activities"),
       )
       this.modelActivityId = session.allocId("activity")
      this.harnessActivityId = session.allocId("activity")
      this.tracePath = resolve(logsDir, session.sessionId, `${this.contextId}.yaml`)
      this.completionService = session.getService(
         this.agent.spec.model,
         ThreadCompletionService,
      )
      session.registerContext(this)
   }

   /** The active posture resource, or null. Derived from the thread. */
   get posture(): PostureObject | null {
      const name = this.currentPosture
      if (name === null) return null
      const res = this.session.getResource(name)
      return res instanceof PostureObject ? res : null
   }

   /**
    * Current behavior = the agent's behavior combined with the active posture
    * (the posture patches the agent's base). When no posture is active this is
    * just the agent's behavior.
    */
   get behavior(): AgentBehavior {
      const base = this.agent.getBehavior() ?? {}
      return this.posture ? (this.posture.getBehavior(base) ?? base) : base
   }

   get maxToolRounds(): number {
      return this.behavior.maxToolRounds ?? DEFAULT_MAX_TOOL_ROUNDS
   }

   private get parentSnapshot(): ContextRef {
      return { contextId: this.contextId, parentId: this.parentId, agentName: this.agentName }
   }

   private emitPosture(postureName: string | null): void {
      const payload = { ...this.parentSnapshot, postureName }
      this.session.events.emit("posture", payload)
   }

   get currentPosture(): string | null {
      return this.getIntrinsic<string>("__posture") ?? null
   }

   emit(fragment: AnyFragment): void {
      // Inject the appropriate activity root when the fragment doesn't carry
      // one. The root is selected by fragment type: LLM-generated types get
      // modelActivityId; everything else gets harnessActivityId. Activity-
      // scoped fragments (ActivityStart/Progress/Complete) already carry a
      // child id and are left untouched.
      if (fragment.activityId === undefined) {
         fragment.activityId = MODEL_ROOTED_TYPES.has(fragment.kind)
            ? this.modelActivityId
            : this.harnessActivityId
      }

      const prevPosture = this.currentPosture

      let nextPosture = prevPosture
      if (fragment.kind === "PostureUse") {
         nextPosture = fragment.name
      } else if (fragment.kind === "PostureExit") {
         nextPosture = null
      }

      // Detach active skills BEFORE the transition fragment enters the
      // thread, so SkillDetach precedes PostureUse/PostureExit and the
      // thread can be replayed to reconstruct state in document order.
      if (prevPosture !== null && nextPosture !== prevPosture) {
         this.detachActiveSkills()
      }

      this.thread.emit(fragment)
      this.setIntrinsic("__posture", nextPosture)

      this.session.events.emit("fragment", { ...this.parentSnapshot, fragment })
      this.traceFragment(fragment)

      if (prevPosture !== nextPosture) {
         this.emitPosture(nextPosture)
      }

      // Note: the harness deliberately does NOT project fragments to any
      // user-facing leaf. That concern is owned by extensions (e.g.
      // InteractSurface subscribes to this `fragment` event and maintains its
      // own /interact leaf + emits its own `interaction` events). The runtime
      // is projection-agnostic so it stays valid when the extension is absent.
   }

   emitAll(fragments: AnyFragment[]): void {
      for (const f of fragments) this.emit(f)
   }

   emitLog(entry: Omit<LogEntry, "timestamp">): void {
      const full: LogEntry = { ...entry, timestamp: Date.now() }
      logger.debug({ entry: full }, `fragment emitted (${entry.fragmentType})`)
      this.session.events.emit("log", { ...this.parentSnapshot, entry: full })
   }

   async run(userMessage?: string): Promise<RunOutcome> {
      // Init phase runs once: detected by an empty thread. The agent resource
      // always emits a persona Instruction, so the thread is non-empty after.
      if (this.thread.length === 0) {
         const persona = this.behavior.persona
         if (persona) {
            this.emit(createInstruction(persona.instruction ?? "", persona.name))
         }
         // Additional guidelines (e.g. instructions mutualized via a preset
         // the agent `extends`) layer on top of the persona at init.
         for (const g of this.behavior.guidelines ?? []) {
            this.emit(createInstruction(g.instruction ?? "", g.name))
         }

         const startFire = await this.fireHooks("on_start")
         if (startFire.outcome.kind === "exit") {
            return this.finishEmit({ kind: "terminated" })
         }

         if (this === this.session.context) {
            const initialPosture = this.behavior.posture
            if (initialPosture) {
               await this.activatePosture(initialPosture)
            }
         }
      }

      if (userMessage) this.emit(createUserMessage(userMessage))
      const outcome = await this.runLoop()
      return this.finishEmit(outcome)
   }

   /** Emit the terminal event for an outcome and return it unchanged. */
   private finishEmit(outcome: RunOutcome): RunOutcome {
      switch (outcome.kind) {
         case "terminated":
            this.session.events.emit("terminated", this.parentSnapshot)
            break
         case "awaiting_activities":
            this.session.events.emit("awaiting_activities", {
               ...this.parentSnapshot,
               pending: outcome.pending,
            })
            break
         case "prompt":
            this.session.events.emit("prompt", this.parentSnapshot)
            break
      }
      return outcome
   }

   private async runLoop(): Promise<RunOutcome> {
       // Re-entry guard: if the host re-calls execute() while activities are
       // still pending (batch not fully resolved), do not complete — just
       // re-report awaiting. The loop is host-driven (no promise-based resume).
       if (this.hasPendingActivities()) {
          return { kind: "awaiting_activities", pending: this.pendingActivityIds() }
       }
       this.running = true
       try {
         let rounds = 0
         while (rounds < this.maxToolRounds) {
            // Flush any steering injection that landed since the last iteration
            // (interrupt path queues here; harmless no-op when none is pending).
            this.flushPendingSteer()
            rounds++

            const tools = this.collectTools()
            this.session.events.emit("thinking", this.parentSnapshot)
            let result: CompletionResult
            this.completionAbort = new AbortController()
            try {
               result = await this.completionService.complete(
                  this.thread.fragments,
                  tools,
                  this.completionAbort.signal,
               )
            } catch (err) {
               this.completionAbort = null
               // Steering aborted this completion: discard the partial result,
               // don't charge the aborted attempt against the round budget, and
               // loop back (the top flush emits the steering fragment).
               if (this.steerAbortRequested) {
                  this.steerAbortRequested = false
                  rounds--
                  continue
               }
               const error =
                  err instanceof Error
                     ? err
                     : new Error(
                        `Completion service threw a non-Error value (type: ${typeof err}, value: ${err === undefined ? "undefined" : String(err)})`,
                     )
               logger.error({ err: error }, "completion service failed")
               this.session.events.emit("error", { ...this.parentSnapshot, error })
               return { kind: "prompt" }
            }
            this.completionAbort = null

            if (result.usage) this.addUsage(result.usage)
            if (result.fragments.length === 0) break

            this.emitAll(result.fragments)

            const toolUses = result.fragments.filter(
               (f) => f.kind === "ToolUse",
            ) as ToolUseFragment[]

            if (toolUses.length > 0) {
               for (const toolUse of toolUses) {
                  this.session.events.emit("toolstart", { ...this.parentSnapshot, toolName: toolUse.toolName, id: toolUse.id })

                  let isError = false
                  let settled = false
                  try {
                     const res = await this.executeUse(
                        toolUse.toolName,
                        toolUse.arguments,
                        toolUse.id,
                        false,
                     )
                     isError = res.isError
                     settled = res.settled
                     // Settled inline (sync): the ToolFeedback is already on the
                     // thread. Deferred: the loop suspends until the delivery
                     // terminates and settles.
                  } catch (err) {
                     isError = true
                     settled = true
                     const error = err instanceof Error ? err : new Error(String(err))
                     logger.error({ err: error, toolName: toolUse.toolName, toolUseId: toolUse.id }, "tool execution failed")
                     this.session.events.emit("error", { ...this.parentSnapshot, error })
                     // An exception during applyTool: synthesize an error
                     // feedback so the agent can react.
                     const fb = createToolFeedback(
                        toolUse.id,
                        toolUse.toolName,
                        { error: err instanceof Error ? err.message : String(err) },
                        true,
                     )
                     fb.activityId = this.modelActivityId
                     this.emit(fb)
                  }
                  // toolend fires when the invocation is fully resolved. For an
                  // inline settlement that is now; for a deferred one, the
                  // settlement emits toolend when the delivery terminates.
                  if (settled) {
                     this.session.events.emit("toolend", { ...this.parentSnapshot, toolName: toolUse.toolName, id: toolUse.id, isError })
                     // on_tool_error fires whenever a tool execution ended in
                     // an error (inline path only — deferred errors are not
                     // attributed back, matching the previous behavior).
                     if (isError) {
                        await this.maybeFireToolError(toolUse.toolName)
                     }
                  }
               }

               // If any delivery is still pending, suspend the loop until all
               // of them terminate.
                if (this.hasPendingActivities()) {
                  return { kind: "awaiting_activities", pending: this.pendingActivityIds() }
                }

               continue
            }

            if (hasStimulus(result.fragments)) continue
            break
         }

         const hookFire = await this.fireHooks("on_completion")
         if (hookFire.outcome.kind === "exit") {
            this.exitPosture()
            return { kind: "terminated" }
         }
         // A completion hook may have delegated activities; suspend if so.
         if (this.hasPendingActivities()) {
            return { kind: "awaiting_activities", pending: this.pendingActivityIds() }
         }
         // Normal end of a conversation turn: the posture persists and the
         // session waits for the next user message. Only an explicit exit
         // hook terminates and exits the posture.
         return { kind: "prompt" }
      } finally {
         this.running = false
      }
   }

    /** Run a fresh loop and emit its terminal outcome. */
    private async driveLoop(): Promise<void> {
       const outcome = await this.runLoop()
       this.finishEmit(outcome)
    }

   // ── Steering (host injection) ─────────────────────────────────────

   /**
    * Inject a host steering into this context's thread. Synchronous setup:
    * validation + fragment emit + loop kick happen here; the loop itself runs
    * fire-and-forget. Throws SteeringBusyError (→ HTTP 409) when the loop is
    * busy and the injection cannot be applied.
    *
    * - Loop idle: emit the fragment, kick a fresh loop.
    * - Loop running + interrupt + completion in flight: queue the fragment,
    *   abort the completion (the runLoop discards the partial result, flushes
    *   the fragment, and resumes).
    * - Otherwise (busy, not interruptible): throw.
    */
   steer(text: string, opts?: SteerOptions): void {
      const as: SteeringShape = opts?.as === "instruction" ? "instruction" : "user"
      const interrupt = opts?.interrupt === true

      if (this.running) {
         if (interrupt && this.completionAbort) {
            this.pendingSteer = { text, as }
            this.steerAbortRequested = true
            this.completionAbort.abort()
            return
         }
         throw new SteeringBusyError(
            interrupt
               ? "tool execution is not interruptible"
               : "agent is busy; set interrupt to steer mid-run",
         )
      }

      this.emitSteerFragment(text, as)
      void this.driveLoop()
   }

   /** Emit the steering fragment for the given shape (UserMessage or Instruction). */
   private emitSteerFragment(text: string, as: SteeringShape): void {
      this.emit(as === "instruction" ? createInstruction(text, "steering") : createUserMessage(text))
      // Echoing a user-shaped steering into a conversation projection is a
      // host concern: the host knows what it injects and builds its own
      // presentation surface. The harness only emits the thread fragment.
   }

   /** Emit and clear any queued steering injection. */
   private flushPendingSteer(): void {
      if (!this.pendingSteer) return
      const { text, as } = this.pendingSteer
      this.pendingSteer = null
      this.emitSteerFragment(text, as)
   }

    private async fireHooks(
       trigger: HookTrigger,
       toolName?: ToolName,
    ): Promise<HookFireResult> {
       const collected = this.collectHooks(trigger, toolName)
       if (collected.length === 0) return { outcome: { kind: "continue" } }

      let didExit = false
      const errors: string[] = []

      for (const { hook } of collected) {
         if (hook.type === "tooluse") {
            const hookId = this.session.allocId("hook")
            this.session.events.emit("toolstart", { ...this.parentSnapshot, toolName: hook.tool, id: hookId })
            let failed = false
            let settled = false
            let result: any
            try {
               const res = await this.executeUse(
                  hook.tool,
                  hook.args ?? {},
                  hookId,
                  true,
               )
               settled = res.settled
               failed = res.settled && res.isError
               result = res.result
            } catch (err) {
               const error = err instanceof Error ? err : new Error(String(err))
               logger.error({ err: error, hookType: "tooluse", toolName: hook.tool }, "hook tool execution failed")
               this.session.events.emit("error", { ...this.parentSnapshot, error })
               failed = true
               settled = true
               result = { error: error.message }
            }
            // toolend for the hook fires only when the invocation settled
            // inline (sync); a deferred hook reports toolend at settlement.
            if (settled) {
               this.session.events.emit("toolend", {
                  ...this.parentSnapshot,
                  toolName: hook.tool,
                  id: hookId,
                  isError: failed,
               })
            }
            if (failed) {
               // The hook produced an error: its terminal payload becomes the
               // gate's verdict message (the controlled tool will be blocked).
               errors.push(asErrorMessage(result))
            }

            // Pre-execution semantics: short-circuit at the first isError.
            // For on_tool_use, the controlled tool must be blocked; for other
            // triggers the fire just stops here.
            if (errors.length > 0 && trigger === "on_tool_use") break
            continue
         }

         if (hook.type === "route") {
            await this.activatePosture(hook.posture)
            continue
         }

         // exit
         this.exitPosture()
         didExit = true
         break
      }

      return {
         outcome: didExit ? { kind: "exit" } : { kind: "continue" },
         errors: errors.length > 0 ? errors : undefined,
      }
   }

    /**
     * Fire `on_tool_error` hooks if any are declared for the failing tool, with
     * reentrancy guard. Called from the catch path of a tool execution. A hook
     * failing inside this fire must not re-trigger the trigger (infinite
     * cascade). The `toolName` is passed so hooks can filter via `appliesTo`.
     */
    private async maybeFireToolError(toolName: ToolName): Promise<void> {
       if (this.firingToolError) return
       if (this.collectHooks("on_tool_error", toolName).length === 0) return
       this.firingToolError = true
       try {
          await this.fireHooks("on_tool_error", toolName)
       } finally {
          this.firingToolError = false
       }
    }

   private async activatePosture(postureName: string): Promise<void> {
      const postureResource = this.session.getResource(postureName)
      if (!(postureResource instanceof PostureObject)) return
      await postureResource.applyTool(postureName, {}, this)
   }

   private exitPosture(): void {
      const name = this.currentPosture
      if (name === null) return
      this.emit(createPostureExit(name))
   }

   private activeSkillNames(): string[] {
      const attached = new Set<string>()
      for (const f of this.thread.fragments) {
         if (f.kind === "SkillAttach") attached.add(f.name)
         else if (f.kind === "SkillDetach") attached.delete(f.name)
      }
      return [...attached]
   }

   private detachActiveSkills(): void {
      for (const name of this.activeSkillNames()) {
         this.emit(createSkillDetach(name))
      }
   }

   private addUsage(usage: TokenUsage): void {
      this.tokenUsage = {
         inputTokens: this.tokenUsage.inputTokens + usage.inputTokens,
         cachedTokens: this.tokenUsage.cachedTokens + usage.cachedTokens,
         outputTokens: this.tokenUsage.outputTokens + usage.outputTokens,
      }
      this.session.events.emit("usage", { ...this.parentSnapshot, usage: { ...this.tokenUsage } })
   }

    /**
     * Collect every hook declared for a trigger, tagged with its owner resource
     * name. Owners are, in order: the agent, the active posture, then attached
     * skills. Each hook's fully-qualified audit name is `hooks:<owner>:<local>`
     * — the local part is the optional `name` field, falling back to a derived
     * default (type + ref). The owner is what disambiguates two hooks with the
     * same local name across resources.
     *
     * When `toolName` is provided (the tool-scoped triggers `on_tool_use` /
     * `on_tool_error`), each hook's optional `appliesTo` selector is matched
     * against it; a non-matching hook is filtered out. A hook without
     * `appliesTo` matches every tool. The selector reuses the
     * guardrail semantics (`"*"`, name list, or label selector on the
     * publishing resource).
     */
    private collectHooks(
       trigger: HookTrigger,
       toolName?: ToolName,
    ): Array<{ owner: string; hook: HookEntry }> {
       const out: Array<{ owner: string; hook: HookEntry }> = []
       const push = (owner: string, hooks: HookEntry[]): void => {
          for (const hook of hooks) {
             if (
                toolName !== undefined &&
                hook.appliesTo !== undefined &&
                !this.guardrailAppliesTo(hook.appliesTo, toolName)
             ) {
                continue
             }
             out.push({ owner, hook })
          }
       }
       push(this.agent.name, this.agent.getHooks(trigger))
       if (this.posture) {
          push(this.posture.name, this.posture.getHooks(trigger))
       }
       for (const name of this.activeSkillNames()) {
          const res = this.session.getResource(name)
          if (res instanceof SkillObject) {
             push(res.name, res.getHooks(trigger))
          }
       }
       return out
    }

   /**
    * Resolve the active guardrails (from behavior + attached skills) to those
    * whose `appliesTo` selector matches the given tool name, in declaration
    * order. Each entry carries its owner resource name (used to build the
    * audit identity).
    */
   private collectApplicableGuardrails(toolName: ToolName): ResolvedGuardrail[] {
      const all = this.collectAllGuardrails()
      const applicable: ResolvedGuardrail[] = []
      for (const g of all) {
         if (this.guardrailAppliesTo(g.decl.appliesTo, toolName)) {
            applicable.push(g)
         }
      }
      return applicable
   }

   /**
    * Walk every contributing owner (agent, active posture, then attached
    * skills) and collect their guardrail declarations, each tagged with its
    * owner resource name. Deduplication is by qualified name
    * (`guardrails:<owner>:<local>`) so the same local name on different
    * owners coexists. Order matters: the first guardrail whose assertion
    * fails wins, so the agent's guardrails are evaluated before the
    * posture's, before the skills'.
    */
   private collectAllGuardrails(): ResolvedGuardrail[] {
      const seen = new Set<string>()
      const out: ResolvedGuardrail[] = []
      const push = (owner: string, decls: GuardrailDecl[] | undefined): void => {
         if (!decls) return
         for (const decl of decls) {
            const qname = `guardrails:${owner}:${decl.name}`
            if (seen.has(qname)) continue
            seen.add(qname)
            out.push({ owner, decl })
         }
      }
      push(this.agent.name, this.agent.getGuardrails())
      if (this.posture) {
         push(this.posture.name, this.posture.getGuardrails())
      }
      for (const name of this.activeSkillNames()) {
         const res = this.session.getResource(name)
         if (res instanceof SkillObject) push(res.name, res.getGuardrails())
      }
      return out
   }

   /** True iff the selector matches the given tool name (or its publisher). */
   private guardrailAppliesTo(
      appliesTo: GuardrailAppliesTo,
      toolName: ToolName,
   ): boolean {
      if (appliesTo === "*") return true
      if (Array.isArray(appliesTo)) {
         return appliesTo.includes(toolName)
      }
      // Label selector: match against the resource that publishes the tool.
      const owner = this.findToolPublisher(toolName)
      if (!owner) return false
      return labelSelectorMatches(appliesTo as LabelSelector, owner.metadata.labels)
   }

   /**
    * Evaluate every applicable guardrail in order. Returns the first non-empty
    * list of error messages (the spec's "court-circuit à la première erreur"),
    * or `undefined` when all guardrails allow. The scope exposed to `assertion`
    * and `message` is `{ toolName, args, memory, currentPosture, sessionId,
    * agentName, cwd }`.
    */
   private checkGuardrails(
      toolName: ToolName,
      args: Record<string, any>,
   ): string[] | undefined {
      const guardrails = this.collectApplicableGuardrails(toolName)
      if (guardrails.length === 0) return undefined
      const scope = {
         toolName,
         args,
          memory: this.memorySnapshot(),
         currentPosture: this.currentPosture ?? "",
         sessionId: this.session.sessionId,
         agentName: this.agentName,
         cwd: this.session.blueprint.instructions.cwd,
      }
      for (const g of guardrails) {
         if (!g.decl.assertion) continue
         let asserted: boolean
         try {
            asserted = evaluateCondition(g.decl.assertion, scope)
         } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            logger.warn(
               { err: msg, guardrail: g.decl.name, owner: g.owner },
               "guardrail assertion expression failed to evaluate — treated as allow",
            )
            continue
         }
         if (asserted) continue
         const tmpl = g.decl.message ?? `Tool ${toolName} blocked by guardrail ${g.decl.name}`
         let rendered: string
         try {
            rendered = renderTemplate(tmpl, scope)
         } catch {
            rendered = tmpl
         }
         return [rendered]
      }
      return undefined
   }

   /**
    * Find the resource that publishes a tool by name. Walks every resource's
    * getTools(); the first one whose tool name (exact or `${name}__...`
    * prefixed) matches wins. Used by the guardrail label selector.
    */
   private findToolPublisher(toolName: ToolName) {
      for (const res of this.session.resources) {
         for (const t of res.getTools()) {
            if (t.name === toolName || t.name === `${res.name}__${toolName}`) {
               return res
            }
         }
      }
      if (this.posture) {
         for (const t of this.posture.getActiveTooling()) {
            if (t.name === toolName) return this.posture
         }
      }
      return undefined
   }

   private collectTools() {
      const tools: ToolGuide[] = []
      // Explicit selection model: a tool reaches the LLM surface only when
      // declared in the YAML, never by virtue of being loaded. Three channels:
       //   1. the agent's permanent tooling (folded from its `extends` presets,
       //      resolved against the session's resources — `toolset
       //      pattern/selector`, `subagent`, etc.);
      //   2. the active posture's tooling (resolved the same way);
      //   3. each attached skill's tooling.
      // McpStdio, Memory, and any other tool-publishing resource contribute
      // only when an entry selects them — there is no implicit aggregation
       // of every resource's getTools(). See docs/architecture.spec.md §
       // "La surface d'outils, assemblée à l'instant t".
      tools.push(...this.agent.getTools())
      if (this.posture) {
         tools.push(...this.posture.getActiveTooling())
      }
      for (const name of this.activeSkillNames()) {
         const res = this.session.getResource(name)
         if (res instanceof SkillObject) {
            tools.push(...res.getActiveTooling())
         }
      }
      return tools
   }

   /**
    * State-Tree façade scoped to this context (rooted at `scopePath`).
    * Resources read/write their per-context state through these accessors;
     * the `kind` of a state cell is the resource `metadata.name`. See
     * docs/architecture.spec.md.
    */
   getState(rc: ResourceObject): StateCell | undefined {
      return this.stateLeaf().get(rc.name)
   }

   setState(rc: ResourceObject, value: StateCell): void {
      value.kind = rc.name
      this.stateLeaf().upsert(value)
   }

   findLeaf<C extends Cell>(sub: string): Leaf<C> | undefined {
      return this.tree.findLeaf<C>(joinLeafPath(this.scopePath, sub))
   }

   acquireLeaf<C extends Cell>(sub: string): Leaf<C> {
      return this.tree.acquireLeaf<C>(joinLeafPath(this.scopePath, sub))
   }

   deleteLeaf(sub: string): void {
      this.tree.deleteLeaf(joinLeafPath(this.scopePath, sub))
   }

   private stateLeaf(): Leaf<StateCell> {
      return this.tree.acquireLeaf<StateCell>(joinLeafPath(this.scopePath, "state"))
   }

   /** Read a context-intrinsic state value (reserved `__`-prefixed kind). */
   private getIntrinsic<T>(kind: string): T | undefined {
      return this.stateLeaf().get(kind)?.payload as T | undefined
   }

   /** Write a context-intrinsic state value (reserved `__`-prefixed kind). */
   private setIntrinsic(kind: string, payload: unknown): void {
      this.stateLeaf().upsert({ kind, payload })
   }

   /**
    * Frozen merge of every `Memory` resource's state cell, exposed to guardrail
    * evaluation as the `memory` variable. Replaces the former shared
    * `MemoryStore`: each Memory resource owns its own cell keyed by name, and
    * this view flattens them for backward-compatible rule expressions.
    */
   memorySnapshot(): Record<string, unknown> {
      const merged: Record<string, unknown> = {}
      for (const r of this.session.resources) {
         if (r.kind !== "Memory") continue
         const bag = this.getState(r)?.payload as Record<string, unknown> | undefined
         if (bag) Object.assign(merged, bag)
      }
      return Object.freeze(merged)
   }

   availableToolNames(): string[] {
      const fullNames = this.collectTools().map((t) => t.name)
      const shortNames = fullNames
         .filter((n) => n.includes("__"))
         .map((n) => n.split("__").slice(1).join("__"))
      return [...new Set([...fullNames, ...shortNames])]
   }

   // ── Delivery + delegation (tool surface) ──────────────────────────

   /**
    * Settle an activity with a payload (synchronous). Tools call this from
    * `applyTool` for the synchronous path; the host/env calls it (via
    * `session.resolveActivity`) for the deferred path. Either way the activity
    * cell goes terminal and the effects (ToolFeedback, completion, interact
    * flip, events) derive from the data. No promise, no resume.
    */
   deliver(activityId: ActivityId, payload: any, isError = false): void {
      this.settleActivity(activityId, payload, isError)
   }

   /**
    * Turn a freshly-allocated activity into a delegated one: fill its cell with
    * the environment routing, emit its `ActivityStart`, and route it. The id is
    * the one the harness allocated and passed to the tool (`deliveryId`) — it is
    * the same id the host/env resolves. The completion effect (if any) is the
    * delegating resource's responsibility: extensions subscribe to
    * `activity_resolved` and emit further fragments themselves.
    */
   delegateActivity(
      spec: ActivityChildSpec,
      activityId?: ActivityId,
   ): ActivityId {
      const id = activityId ?? this.session.allocId("activity")
      const cell = this.activities.get(id) ?? {
         kind: id,
         activityId: id,
         status: "pending" as const,
         parentRoot: this.harnessActivityId,
      }
      cell.environment = spec.environment
      cell.tool = spec.tool
      cell.arguments = spec.arguments ?? {}
      cell.payload = spec.payload
      this.activities.upsert(cell)
      this.children.add(id)
      this.emit(
         createActivityStart({
            activityId: id,
            parentActivityId: cell.parentRoot,
            environment: spec.environment,
            tool: spec.tool,
            arguments: spec.arguments ?? {},
            payload: spec.payload,
         }),
      )
      this.routeActivity(id)
      return id
   }

   /**
    * Execute a tool invocation (LLM or harness-initiated). The harness always
    * allocates a delivery and passes its id to `applyTool`; the tool either
    * delivers it (synchronous — settled inline) or delegates by creating a
    * child the delivery waits on (deferred — gated). Returns whether the
    * invocation settled inline and its error flag.
    *
    * `fromHarness` distinguishes a harness-initiated invocation (a hook,
    * carried by the harnessActivityId — no ToolFeedback) from an LLM ToolUse
    * (carried by the modelActivityId — ToolFeedback emitted on settlement).
    *
    * Pre-execution controls run **only** for LLM-emitted ToolUse (when
    * `fromHarness === false`): applicable guardrails are evaluated first
    * (declarative, synchronous), then `on_tool_use` hooks fire (imperative,
    * may invoke a tool). The first control that produces errors short-circuits
    * the invocation; the delivery is delivered with the errors and settled.
    * Hooks never recurse into controls (a tool called by a hook bypasses this
    * gate).
    */
    private async executeUse(
       toolName: ToolName,
       args: Record<string, any>,
       id: ToolUseId,
       fromHarness: boolean,
    ): Promise<UseResult> {
      const parentRoot = fromHarness ? this.harnessActivityId : this.modelActivityId

       if (!fromHarness) {
          const guardrailErrors = this.checkGuardrails(toolName, args)
          if (guardrailErrors) {
             return this.failInline(parentRoot, id, toolName, { errors: guardrailErrors })
          }
           // Pass the LLM-emitted toolName so hooks can filter via `appliesTo`
           // (selector shape identical to guardrails). A hook without `appliesTo`
           // fires for every tool.
          const hookFire = await this.fireHooks("on_tool_use", toolName)
         if (hookFire.errors && hookFire.errors.length > 0) {
            return this.failInline(parentRoot, id, toolName, { errors: hookFire.errors })
         }
         if (hookFire.outcome.kind === "exit") {
            // Exit short-circuit: no feedback for this tool.
            return { settled: true, isError: false }
         }
         // A pending on_tool_use delegation suspends the loop until the
         // activity resolves; resumeAfterActivities re-enters the loop, and
         // the LLM gets to call the tool again or do something else. The
         // simplest faithful behavior: proceed with the tool — the hook's
         // delegated verification is async and not awaited.
      }

       const deliveryId = this.newDelivery(parentRoot, id, toolName)
       const { awaitedId } = await this.runTool(toolName, args, deliveryId)

       // The tool returned an id it has NOT settled yet → deferred: the loop
       // suspends (there is a pending activity cell). Anything else (undefined)
       // is synchronous: ensure the activity is terminal (auto-settle if the
       // tool forgot), then report inline.
       if (awaitedId !== undefined && !this.isTerminal(awaitedId)) {
          this.children.add(awaitedId)
          return { settled: false, isError: false }
       }

       if (!this.isTerminal(deliveryId)) {
          this.deliver(deliveryId, undefined, false)
       }
       const isError = this.isFailed(deliveryId)
       const result = this.getResult(deliveryId)
       return { settled: true, isError, result }
    }

    /** Allocate a pending activity cell for a tool invocation. */
    private newDelivery(parentRoot: ActivityId, toolUseId: ToolUseId | undefined, toolName: ToolName): ActivityId {
       const id = this.session.allocId("activity")
       this.activities.upsert({
          kind: id,
          activityId: id,
          status: "pending",
          parentRoot,
          toolUseId,
          toolName,
       })
       return id
    }

    /** Deliver an error payload to a fresh activity and settle it inline. */
    private failInline(
       parentRoot: ActivityId,
       toolUseId: ToolUseId,
       toolName: ToolName,
       payload: any,
    ): UseResult {
       const deliveryId = this.newDelivery(parentRoot, toolUseId, toolName)
       this.deliver(deliveryId, payload, true)
       return { settled: true, isError: true, result: payload }
    }

    // ── Activity feedback + settlement (data-driven, synchronous) ────

    /** Intermediate progress from a delegated activity: audit + host notify. */
    onActivityProgress(activityId: ActivityId, feedback: any, progress?: number): void {
       if (!this.children.has(activityId)) return
       this.emit(createActivityProgress(activityId, feedback, progress))
    }

    /**
     * Settle an activity: flip its cell terminal and derive the effects from
     * the data — `ActivityComplete` audit, `ToolFeedback` (model-rooted), the
     * completion effect (interact__prompt → UserMessage), and the
     * toolend/activity_resolved/interaction notifications for delegated
     * activities. Synchronous; the host re-calls `execute()` to continue.
     */
    settleActivity(activityId: ActivityId, payload: any, isError: boolean): void {
       const cell = this.activities.get(activityId)
       if (!cell || cell.status === "completed" || cell.status === "failed") return
       cell.status = isError ? "failed" : "completed"
       cell.result = payload
       cell.isError = isError
       this.activities.upsert(cell)

       const failed = isError
       const status: "completed" | "failed" = failed ? "failed" : "completed"
       const delegated = cell.environment != null

       if (delegated && !this.completedChildren.has(activityId)) {
          this.completedChildren.add(activityId)
          this.emit(createActivityComplete(activityId, status))
       }
       // ToolFeedback is reserved for model-originated invocations.
       if (cell.parentRoot === this.modelActivityId && cell.toolUseId && cell.toolName) {
          this.emit(createToolFeedback(cell.toolUseId, cell.toolName, payload, failed))
       }
       // The delegated-only notifications (inline settlements are bracketed by
       // the runLoop's own toolend; non-delegated activities have no Request).
        // Completion effects (e.g. interact__prompt → UserMessage) and any
       // user-facing projection update are owned by extensions, which
       // subscribe to `activity_resolved` and react themselves.
       if (delegated) {
          this.session.events.emit("toolend", {
             ...this.parentSnapshot,
             toolName: cell.toolName ?? "",
             id: cell.toolUseId ?? "",
             isError: failed,
          })
          this.session.events.emit("activity_resolved", {
             ...this.parentSnapshot,
             activityId,
             status,
             result: payload,
          })
       }
    }

    // ── Activity cell accessors ──────────────────────────────────────

    /** This context owns the activity (it has a cell in /activities). */
    ownsActivity(activityId: ActivityId): boolean {
       return this.activities.get(activityId) !== undefined
    }

    /** Any pending (unresolved) activity cell — the loop's stop condition. */
    hasPendingActivities(): boolean {
       return this.activities.cells.some((a) => a.status === "pending")
    }

    pendingActivityIds(): ActivityId[] {
       return this.activities.cells.filter((a) => a.status === "pending").map((a) => a.activityId ?? a.kind)
    }

    isTerminal(activityId: ActivityId): boolean {
       const s = this.activities.get(activityId)?.status
       return s === "completed" || s === "failed"
    }

    isFailed(activityId: ActivityId): boolean {
       return this.activities.get(activityId)?.status === "failed"
    }

    getResult(activityId: ActivityId): any {
       return this.activities.get(activityId)?.result
    }

    /** The activity data model (for environment routing). */
    getActivity(activityId: ActivityId): Activity {
       const cell = this.activities.get(activityId)!
       return {
          activityId,
          parentActivityId: cell.parentRoot,
          status: cell.status === "pending" ? "running" : cell.status,
          environment: cell.environment,
          tool: cell.tool,
          arguments: cell.arguments,
          payload: cell.payload,
       }
    }

    /** Route a delegated activity to its environment; fail it if unregistered. */
    private routeActivity(activityId: ActivityId): void {
       const cell = this.activities.get(activityId)
       if (!cell || cell.status !== "pending") return
       const env = cell.environment ? this.session.getEnvironment(cell.environment) : undefined
       if (!env) {
          this.settleActivity(activityId, { error: `environment not registered: ${cell.environment}` }, true)
          return
       }
       env.assign(this.getActivity(activityId), this.createDeliveryHandle(activityId))
    }

    /** Handle bound to an activity id, handed to the environment. */
    createDeliveryHandle(activityId: ActivityId): ActivityDelivery {
       return {
          progress: (feedback, progress) => this.onActivityProgress(activityId, feedback, progress),
          complete: (result) => this.settleActivity(activityId, result, false),
          fail: (error) => this.settleActivity(activityId, error, true),
       }
    }

    /**
     * Finds and runs a tool by name, returning the activity id the context must
     * await (the delivery id when the tool deferred, undefined when it delivered
     * synchronously). Does NOT emit any feedback fragment — settlement wraps the
     * delivery's terminal result into a ToolFeedback, or the tool delegated and
     * the feedback is deferred. A not-found tool is delivered as an isError
     * result.
     */
    private async runTool(
       toolName: ToolName,
       args: Record<string, any>,
       deliveryId: ActivityId,
    ): Promise<{ awaitedId?: ActivityId }> {
       // The first loop dispatches by ownership: it finds the resource that
       // publishes the tool via `getTools()` and delegates to its `applyTool`.
       // Agents and postures are skipped here — they contribute to the LLM
       // surface (collectTools) but do not own tool execution: an agent's
       // `applyTool` is a no-op, and a posture's `getTools()` is empty by
       // design. Their `type: route` entries are resolved explicitly below.
       for (const res of this.session.resources) {
          if (res instanceof AgentObject || res instanceof PostureObject) continue
          const tools = res.getTools()
          const match = tools.find(
             (t) => t.name === toolName || t.name === `${res.name}/${toolName}`,
          )
          if (match) {
             return { awaitedId: (await res.applyTool(toolName, args, this, deliveryId)) ?? undefined }
          }
       }

       const skillRes = this.session.getResource(toolName)
       if (skillRes instanceof SkillObject) {
          return { awaitedId: (await skillRes.applyTool(toolName, args, this, deliveryId)) ?? undefined }
       }

       for (const res of this.session.resources) {
          if (res instanceof PostureObject && res.resolveSkillTemplate(toolName)) {
             return { awaitedId: (await res.activateSkill(toolName, args, this, deliveryId)) ?? undefined }
          }
       }

       // A route tool (declared by the active posture as `type: route`) is not
       // reachable through `getTools()` — postures expose their routes only via
       // `getActiveTooling()`. Resolve the target posture from the active
       // posture's tooling and dispatch to its `applyTool`, which emits the
       // PostureUse fragment and switches the active posture.
       if (this.posture) {
          const target = this.posture.resolveRouteTarget(toolName)
          if (target) {
             const targetResource = this.session.getResource(target)
             if (targetResource instanceof PostureObject) {
                return { awaitedId: (await targetResource.applyTool(toolName, args, this, deliveryId)) ?? undefined }
             }
          }
       }

       // Permanent fallback: a route declared on the agent's `spec.tooling` is
       // always reachable, even from no posture (entry / back-to-root). The
       // active posture wins above; we get here only when it doesn't declare
       // the route.
       const agentTarget = this.agent.resolveRouteTarget(toolName)
       if (agentTarget) {
          const targetResource = this.session.getResource(agentTarget)
          if (targetResource instanceof PostureObject) {
             return { awaitedId: (await targetResource.applyTool(toolName, args, this, deliveryId)) ?? undefined }
          }
       }

       if (toolName.startsWith("subagent_")) {
          await this.dispatchSubagent(toolName, args, deliveryId)
          return {}
       }

       this.deliver(deliveryId, { error: `Tool not found: ${toolName}` }, true)
       return {}
    }

    /**
     * Resolves a `subagent_*` tool call to its agent resource and spawns a
     * child context for it. The subagent runs autonomously and its terminal
     * message is delivered to the invocation's delivery.
     */
    private async dispatchSubagent(
       toolName: ToolName,
       args: Record<string, any>,
       deliveryId: ActivityId,
    ): Promise<void> {
      const agentId = toolName.replace(/^subagent_/, "")
      const resource = this.session.getResource(agentId)
      if (!resource || !(resource instanceof AgentObject)) {
          this.deliver(deliveryId, { error: `Subagent not found: ${agentId}` }, true)
         return
      }
      const behavior = resource.getBehavior()
      if (!behavior?.persona) {
          this.deliver(deliveryId, { error: `Subagent has no persona: ${agentId}` }, true)
         return
      }
      const task = typeof args.task === "string" ? args.task : ""
      const result = await this.runSubagent(agentId, resource, task)
       this.deliver(deliveryId, result, false)
   }

   /**
     * Spawns a child context bound to a subagent behavior, runs it
     * autonomously, and returns the result to deliver on the parent thread.
     * Emits SubagentSpawn before run and SubagentComplete after. The child
     * inherits the session's resource set and completion service but has
     * its own thread, posture, and token usage. It may delegate activities to
     * any environment registered on the session when its declared tooling
     * surfaces such tools.
    */
   async runSubagent(
      agentId: string,
      agentResource: AgentObject,
      task: string,
   ): Promise<{ status: string; message: string }> {
      const behavior = agentResource.getBehavior() ?? {}
      const child = new AgentContext(this.session, {
         parentId: this.contextId,
         agent: agentResource,
         agentName: behavior.persona?.name ?? agentId,
      })

      this.emit(createSubagentSpawn(child.contextId, agentId, task))

      let status: "completed" | "terminated" = "completed"
      try {
         const outcome = await child.run(task)
         if (outcome.kind === "terminated") status = "terminated"
      } catch (err) {
         status = "terminated"
         const error = err instanceof Error ? err : new Error(String(err))
         logger.error({ err: error, agentId }, "subagent run failed")
         this.session.events.emit("error", { contextId: child.contextId, parentId: child.parentId, agentName: child.agentName, error })
      }
      this.emit(createSubagentComplete(child.contextId, agentId, status))

       const last = child.thread.filterByKind("AgentMessage").pop()
      const message = last?.content ?? "(no output)"
      return { status, message }
   }

   private traceFragment(f: AnyFragment): void {
      const preview = fragmentPreview(f)
      const shown = preview.length > 120 ? preview.slice(0, 120) + "…" : preview
      this.emitLog({
         level: "debug",
         fragmentType: f.kind,
         source: f.kind === "Instruction" ? f.source : undefined,
         preview: shown,
      })

      if (isDebugMode) {
         this.traceContextChange(f)
      }
   }

   private traceContextChange(triggered: AnyFragment): void {
      const fragments = this.thread.toArray()

      const variables = {
         agentName: this.session.agentName,
         currentPosture: this.currentPosture,
         tokenUsage: { ...this.tokenUsage },
         threadLength: fragments.length,
      }

      const behavior = {
         instructions: this.thread.filterByKind("Instruction").map((f) => ({
            source: f.source,
         })),
         postureUses: this.thread.filterByKind("PostureUse").map((f) => ({
            name: f.name,
         })),
         skillAttaches: this.thread.filterByKind("SkillAttach").map((f) => ({
            name: f.name,
         })),
         skillDetaches: this.thread.filterByKind("SkillDetach").map((f) => ({
            name: f.name,
         })),
      }

      const tool = {
         uses: this.thread.filterByKind("ToolUse").map((f) => ({
            id: f.id,
            toolName: f.toolName,
         })),
         feedbacks: this.thread.filterByKind("ToolFeedback").map((f) => ({
            toolUseId: f.toolUseId,
            toolName: f.toolName,
            isError: f.isError,
         })),
      }

      const others = {
         userMessages: this.thread.filterByKind("UserMessage").length,
         agentMessages: this.thread.filterByKind("AgentMessage").length,
         thinking: this.thread.filterByKind("Thinking").length,
         references: this.thread.filterByKind("Reference").map((f) => ({
            uri: f.uri,
         })),
      }

      const ts = new Date().toISOString()
      const docs: string[] = []
      docs.push(toYamlDoc({ trace: "context-change", timestamp: ts,          triggeredBy: triggered.kind, variables }))
      docs.push(toYamlDoc({ behavior }))
      docs.push(toYamlDoc({ tool }))
      docs.push(toYamlDoc({ others }))
      for (const f of fragments) {
         docs.push(toYamlDoc(f))
      }

      writeTraceFile(this.tracePath, docs.join("\n") + "\n")
   }
}
