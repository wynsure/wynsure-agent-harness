import type { AgentSession, LogEntry } from "./session.ts"
import type { HookTrigger } from "./blueprint-schema.ts"
import {
   type Fragment,
   type AnyFragment,
   type ToolUseFragment,
   type FragmentType,
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
} from "./fragment.ts"
import {
   type AgentBehavior,
   type GuardrailDecl,
   type ToolGuide,
   type ToolResult,
   type ToolOutcome,
} from "./blueprint.ts"
import {
   AgentThread,
   ThreadCompletionService,
   type CompletionResult,
   type IThreadCompletionService,
   type TokenUsage,
} from "./thread.ts"
import { isDebugMode, writeTraceFile, logsDir, logger } from "./logger.ts"
import { resolve } from "path"
import { stringify } from "yaml"
import { AgentObject, PostureObject, SkillObject } from "./resources/index.ts"
import type { HookEntry, GuardrailAppliesTo } from "./blueprint-schema.ts"
import { labelSelectorMatches, type LabelSelector } from "./object-meta.ts"
import { evaluateCondition, renderTemplate } from "./scripting.ts"
import {
   type Activity,
   type ActivitySpec,
   isActivitySpec,
   USER_BOARD_ENVIRONMENT,
} from "./activity.ts"
import {
   buildInteraction,
   isInteractTool,
} from "./interact.ts"
import {
   type SteeringShape,
   type SteerOptions,
   SteeringBusyError,
} from "./steering.ts"
import { MemoryStore } from "./memory.ts"

// ─── Activity-root selection ───────────────────────────────────────────────

/**
 * Fragment types produced by LLM generation default to the `modelActivityId`
 * root. Everything else (instruction, user message, hook audit, memory,
 * subagent) defaults to `harnessActivityId`. The caller can
 * still override by setting `fragment.activityId` explicitly.
 */
const MODEL_ROOTED_TYPES = new Set<FragmentType>([
   "AgentMessage",
   "Thinking",
   "Reference",
   "ToolUse",
   "ToolFeedback",
])

function fragmentPreview(f: AnyFragment): string {
   switch (f.type) {
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
         return `[↗ ActivityStart] ${f.environment}/${f.kind} <${f.activityId.slice(-5)}>${f.toolUseId ? ` tool=${f.toolUseId.slice(0, 5)}` : ""}`
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
   return fragments.some((f) => STIMULUS_TYPES.has(f.type))
}

export type RunOutcome =
   | { kind: "terminated" }
   | { kind: "awaiting_activities"; pending: string[] }
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

/** Outcome of executing a ToolUse: either direct or delegated. */
type UseOutcome =
   | { kind: "direct"; result: ToolResult | undefined }
   | { kind: "delegated"; activity: Activity }

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
   parentId?: string
   /** The agent resource this context is an instance of. */
   agent: AgentObject
   agentName?: string
}

export class AgentContext {
   readonly thread: AgentThread = new AgentThread()
   readonly contextId: string
   readonly parentId: string | null
   readonly agentName: string
   readonly agent: AgentObject
   /**
    * The thread completion service this context drives its run loop with.
    * Resolved eagerly (by contract) from the agent's declared model resource,
    * so a missing or invalid model reference fails fast at session creation.
    * See docs/resources.spec.md § "model — service de complétion".
    */
   private readonly completionService: IThreadCompletionService
   readonly tracePath: string
   /**
    * Activity id root for fragments produced by the LLM (AgentMessage,
    * Thinking, Reference, ToolUse emitted by the provider, ToolFeedback
    * answering an LLM tool call). Filtered by the provider as "assistant"
    * contributions in the next request.
    */
   readonly modelActivityId: string
    /**
     * Activity id root for fragments produced by the harness (Instruction,
     * UserMessage, PostureUse, SkillAttach, hook-originated tool calls,
     * Activity audit, Subagent*). Filtered by the
     * provider as "context/audit" — never mapped as assistant messages.
     */
   readonly harnessActivityId: string
   /** Back-compat alias for `modelActivityId` (used to be the single root). */
   get activityId(): string { return this.modelActivityId }
   tokenUsage: TokenUsage = {
      inputTokens: 0,
      cachedTokens: 0,
      outputTokens: 0,
   }
   private _currentPosture: string | null = null
   /** In-flight delegated activities, keyed by id. */
   private readonly pendingActivities = new Map<string, Activity>()
   /** Per-context volatile memory shared by tools (writers) and rules (readers). */
   readonly memory: MemoryStore = new MemoryStore()
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
       this.modelActivityId = session.allocId("activity")
       this.harnessActivityId = session.allocId("activity")
       this.tracePath = resolve(logsDir, session.sessionId, `${this.contextId}.yaml`)
      this.completionService = session.blueprint.getService(
         this.agent.spec.model,
         ThreadCompletionService,
      )
       session.registerContext(this)
   }

   /** The active posture resource, or null. Derived from the thread. */
   get posture(): PostureObject | null {
      if (this._currentPosture === null) return null
      const res = this.session.blueprint.getResource(this._currentPosture)
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

   private get parentSnapshot(): { contextId: string; parentId: string | null; agentName: string } {
      return { contextId: this.contextId, parentId: this.parentId, agentName: this.agentName }
   }

   private emitPosture(postureName: string | null): void {
      const payload = { ...this.parentSnapshot, postureName }
      this.session.events.emit("posture", payload)
   }

   get currentPosture(): string | null {
      return this._currentPosture
   }

   emit(fragment: AnyFragment): void {
      // Inject the appropriate activity root when the fragment doesn't carry
      // one. The root is selected by fragment type: LLM-generated types get
       // modelActivityId; everything else gets harnessActivityId. Activity-
       // scoped fragments (ActivityStart/Progress/Complete) already carry a
       // child or harness id and are left untouched.
      if (fragment.activityId === undefined) {
         fragment.activityId = MODEL_ROOTED_TYPES.has(fragment.type)
            ? this.modelActivityId
            : this.harnessActivityId
      }

      const prevPosture = this._currentPosture

      let nextPosture = prevPosture
      if (fragment.type === "PostureUse") {
         nextPosture = fragment.name
      } else if (fragment.type === "PostureExit") {
         nextPosture = null
      }

      // Detach active skills BEFORE the transition fragment enters the
      // thread, so SkillDetach precedes PostureUse/PostureExit and the
      // thread can be replayed to reconstruct state in document order.
      if (prevPosture !== null && nextPosture !== prevPosture) {
         this.detachActiveSkills()
      }

      this.thread.emit(fragment)
      this._currentPosture = nextPosture

      this.session.events.emit("fragment", { ...this.parentSnapshot, fragment })
      this.traceFragment(fragment)

      if (prevPosture !== nextPosture) {
         this.emitPosture(nextPosture)
      }
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
                 (f) => f.type === "ToolUse",
              ) as ToolUseFragment[]

              if (toolUses.length > 0) {
                 for (const toolUse of toolUses) {
                    this.session.events.emit("toolstart", { ...this.parentSnapshot, toolName: toolUse.toolName, id: toolUse.id })

                    let isError = false
                    let ended = false
                    try {
                       const outcome = await this.executeUse(
                          toolUse.toolName,
                          toolUse.arguments,
                          toolUse.id,
                          false,
                       )
                       if (outcome.kind === "direct") {
                          const r = outcome.result
                          if (r) {
                             this.emit(
                                createToolFeedback(toolUse.id, toolUse.toolName, r.result, r.isError),
                             )
                             isError = r.isError === true
                          }
                          ended = true
                       }
                       // delegated: the activity is now in-flight; the ToolFeedback
                       // will be emitted when the activity terminates. Do not end
                       // the tool visually yet (it is still running).
                    } catch (err) {
                       isError = true
                       ended = true
                       const error = err instanceof Error ? err : new Error(String(err))
                       logger.error({ err: error, toolName: toolUse.toolName, toolUseId: toolUse.id }, "tool execution failed")
                       this.session.events.emit("error", { ...this.parentSnapshot, error })
                       this.emit(
                          createToolFeedback(
                             toolUse.id,
                             toolUse.toolName,
                             { error: err instanceof Error ? err.message : String(err) },
                             true,
                          ),
                       )
                    }
                    if (ended) {
                       this.session.events.emit("toolend", { ...this.parentSnapshot, toolName: toolUse.toolName, id: toolUse.id, isError })
                       // on_tool_error fires whenever a tool execution ended in
                       // an error — whether thrown or returned as isError=true
                       // (e.g. tool not found). Guarded against reentrancy.
                       if (isError) {
                          await this.maybeFireToolError()
                       }
                    }
                 }

                 // If any tool delegated an activity that is still in flight,
                 // suspend the loop until all of them resolve.
                 if (this.pendingActivities.size > 0) {
                    return { kind: "awaiting_activities", pending: [...this.pendingActivities.keys()] }
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
          if (this.pendingActivities.size > 0) {
             return { kind: "awaiting_activities", pending: [...this.pendingActivities.keys()] }
          }
          // Normal end of a conversation turn: the posture persists and the
          // session waits for the next user message. Only an explicit exit
          // hook terminates and exits the posture.
          return { kind: "prompt" }
       } finally {
          this.running = false
       }
    }

   /**
    * Resume the loop once all in-flight activities of a turn have terminated.
    * Triggered by deliverActivityComplete when the pending set becomes empty
    * and no loop is currently running.
    */
   private async resumeAfterActivities(): Promise<void> {
      await this.driveLoop()
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
   }

   /** Emit and clear any queued steering injection. */
   private flushPendingSteer(): void {
      if (!this.pendingSteer) return
      const { text, as } = this.pendingSteer
      this.pendingSteer = null
      this.emitSteerFragment(text, as)
   }

    private async fireHooks(trigger: HookTrigger): Promise<HookFireResult> {
       const collected = this.collectHooks(trigger)
       if (collected.length === 0) return { outcome: { kind: "continue" } }

       let didExit = false
       const errors: string[] = []

       for (const { hook } of collected) {
          if (hook.type === "tooluse") {
             const hookId = this.session.allocId("hook")
             this.session.events.emit("toolstart", { ...this.parentSnapshot, toolName: hook.tool, id: hookId })
             try {
                const outcome = await this.executeUse(
                   hook.tool,
                   hook.args ?? {},
                   hookId,
                   true,
                )
                if (outcome.kind === "direct") {
                   const wrapped = outcome.result ?? { result: undefined }
                   const failed = wrapped.isError === true
                   if (failed) {
                      errors.push(
                         typeof wrapped.result === "string"
                            ? wrapped.result
                            : JSON.stringify(wrapped.result),
                      )
                   }
                   this.session.events.emit("toolend", {
                      ...this.parentSnapshot,
                      toolName: hook.tool,
                      id: hookId,
                      isError: failed,
                   })
                }
                // Delegated: the ActivityStart has been emitted by executeUse;
                // the loop suspends until the activity resolves.
             } catch (err) {
                const error = err instanceof Error ? err : new Error(String(err))
                logger.error({ err: error, hookType: "tooluse", toolName: hook.tool }, "hook tool execution failed")
                this.session.events.emit("error", { ...this.parentSnapshot, error })
                errors.push(error.message)
                this.session.events.emit("toolend", {
                   ...this.parentSnapshot,
                   toolName: hook.tool,
                   id: hookId,
                   isError: true,
                })
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
    * Fire `on_tool_error` hooks if any are declared, with reentrancy guard.
    * Called from the catch path of a tool execution. A hook failing inside
    * this fire must not re-trigger the trigger (infinite cascade).
    */
   private async maybeFireToolError(): Promise<void> {
      if (this.firingToolError) return
      if (this.collectHooks("on_tool_error").length === 0) return
      this.firingToolError = true
      try {
         await this.fireHooks("on_tool_error")
      } finally {
         this.firingToolError = false
      }
   }

   private async activatePosture(postureName: string): Promise<void> {
      const postureResource = this.session.blueprint.getResource(postureName)
      if (!(postureResource instanceof PostureObject)) return
      await postureResource.applyTool(postureName, {}, this)
   }

   private exitPosture(): void {
      if (this._currentPosture === null) return
      this.emit(createPostureExit(this._currentPosture))
   }

   private activeSkillNames(): string[] {
      const attached = new Set<string>()
      for (const f of this.thread.fragments) {
         if (f.type === "SkillAttach") attached.add(f.name)
         else if (f.type === "SkillDetach") attached.delete(f.name)
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
    */
   private collectHooks(trigger: HookTrigger): Array<{ owner: string; hook: HookEntry }> {
      const out: Array<{ owner: string; hook: HookEntry }> = []
      for (const hook of this.agent.getHooks(trigger)) {
         out.push({ owner: this.agent.name, hook })
      }
      if (this.posture) {
         for (const hook of this.posture.getHooks(trigger)) {
            out.push({ owner: this.posture.name, hook })
         }
      }
      for (const name of this.activeSkillNames()) {
         const res = this.session.blueprint.getResource(name)
         if (res instanceof SkillObject) {
            for (const hook of res.getHooks(trigger)) {
               out.push({ owner: res.name, hook })
            }
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
   private collectApplicableGuardrails(toolName: string): ResolvedGuardrail[] {
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
         const res = this.session.blueprint.getResource(name)
         if (res instanceof SkillObject) push(res.name, res.getGuardrails())
      }
      return out
   }

   /** True iff the selector matches the given tool name (or its publisher). */
   private guardrailAppliesTo(
      appliesTo: GuardrailAppliesTo,
      toolName: string,
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
    * Find the resource that publishes a tool by name. Walks every resource's
    * getTools(); the first one whose tool name (exact or `${name}__...`
    * prefixed) matches wins. Used by the guardrail label selector.
    */
   private findToolPublisher(toolName: string) {
      for (const res of this.session.blueprint.resources) {
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
        //      resolved against the blueprint — `toolset pattern/selector`,
        //      `subagent`, etc.);
        //   2. the active posture's tooling (resolved the same way);
        //   3. each attached skill's tooling.
        // McpStdio, Memory, and any other tool-publishing resource contribute
        // only when an entry selects them — there is no implicit aggregation
        // of every resource's getTools(). See docs/resources.spec.md §
        // "Surfaces d'outils".
        tools.push(...this.agent.getTools())
        if (this.posture) {
           tools.push(...this.posture.getActiveTooling())
        }
        for (const name of this.activeSkillNames()) {
           const res = this.session.blueprint.getResource(name)
           if (res instanceof SkillObject) {
              tools.push(...res.getActiveTooling())
           }
        }
        return tools
     }

    /**
     * Write a value to the per-context memory store. Tools call this during
     * `applyTool` to publish state that future tools (or hooks) can read.
     */
    remember(key: string, value: unknown): void {
       this.memory.set(key, value)
    }

   availableToolNames(): string[] {
      const fullNames = this.collectTools().map((t) => t.name)
      const shortNames = fullNames
         .filter((n) => n.includes("__"))
         .map((n) => n.split("__").slice(1).join("__"))
      return [...new Set([...fullNames, ...shortNames])]
   }

    /**
     * Execute a tool invocation (LLM or harness-initiated), returning either a
     * direct result (wrapped as ToolFeedback by the caller) or a delegated
     * activity (in-flight; feedback deferred to termination).
     *
     * `fromHarness` distinguishes a harness-initiated invocation (a hook,
     * carried by the harnessActivityId) from an LLM ToolUse (carried by the
     * modelActivityId). The semantic parent of any delegated activity follows
     * this distinction.
     *
     * Pre-execution controls run **only** for LLM-emitted ToolUse (when
     * `fromHarness === false`): applicable guardrails are evaluated first
     * (declarative, synchronous), then `on_tool_use` hooks fire (imperative,
     * may invoke a tool). The first control that produces errors short-circuits
     * the invocation; the returned direct ToolResult carries those errors with
     * `isError: true`. The caller wraps them into a ToolFeedback that the
     * model sees in place of the tool's result. Hooks never recurse into
     * controls (a tool called by a hook bypasses this gate).
     */
    private async executeUse(
       toolName: string,
       args: Record<string, any>,
       id: string,
       fromHarness: boolean,
    ): Promise<UseOutcome> {
       if (!fromHarness) {
          const guardrailErrors = this.checkGuardrails(toolName, args)
          if (guardrailErrors) {
             return { kind: "direct", result: { result: { errors: guardrailErrors }, isError: true } }
          }
          const hookFire = await this.fireHooks("on_tool_use")
          if (hookFire.errors && hookFire.errors.length > 0) {
             return { kind: "direct", result: { result: { errors: hookFire.errors }, isError: true } }
          }
          if (hookFire.outcome.kind === "exit") {
             return { kind: "direct", result: undefined }
          }
          // A pending on_tool_use delegation suspends the loop until the
          // activity resolves; resumeAfterActivities re-enters the loop, and
          // the LLM gets to call the tool again or do something else. The
          // simplest faithful behavior: proceed with the tool — the hook's
          // delegated verification is async and not awaited.
       }

       // Interact tools always delegate to the user-board environment.
       if (isInteractTool(toolName)) {
          const spec = this.interactSpec(toolName, args, id)
          const activity = this.createActivity(spec, id, fromHarness)
          return { kind: "delegated", activity }
       }

       const outcome = await this.runTool(toolName, args, id)
       if (outcome !== undefined && isActivitySpec(outcome)) {
          const activity = this.createActivity(outcome, id, fromHarness)
          return { kind: "delegated", activity }
       }
       return { kind: "direct", result: outcome as ToolResult | undefined }
    }

    /**
     * Evaluate every applicable guardrail in order. Returns the first non-empty
     * list of error messages (the spec's "court-circuit à la première erreur"),
     * or `undefined` when all guardrails allow. The scope exposed to `assertion`
     * and `message` is `{ toolName, args, memory, currentPosture, sessionId,
     * agentName, cwd }`.
     */
    private checkGuardrails(
       toolName: string,
       args: Record<string, any>,
    ): string[] | undefined {
       const guardrails = this.collectApplicableGuardrails(toolName)
       if (guardrails.length === 0) return undefined
       const scope = {
          toolName,
          args,
          memory: this.memory.snapshot(),
          currentPosture: this._currentPosture ?? "",
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

    /** Build an ActivitySpec for an interact tool, embedding the UserInteraction. */
    private interactSpec(
       toolName: string,
       args: Record<string, any>,
       id: string,
    ): ActivitySpec {
       const interaction = buildInteraction(toolName, args, id)
       return {
          environment: USER_BOARD_ENVIRONMENT,
          kind: toolName,
          arguments: args,
          payload: interaction,
       }
    }

   /**
    * Materialize an ActivitySpec into a full Activity: allocate its id, emit the
    * ActivityStart fragment (parent root depends on the trigger's channel),
    * register it as pending, and route it to its environment via the session.
    */
   private createActivity(
      spec: ActivitySpec,
      triggerId: string,
      fromHarness: boolean,
   ): Activity {
      const activityId = this.session.allocId("activity")
      const parentActivityId = fromHarness
         ? this.harnessActivityId
         : this.modelActivityId
      const activity: Activity = {
         activityId,
         parentActivityId,
         contextId: this.contextId,
         environment: spec.environment,
         kind: spec.kind,
         arguments: spec.arguments ?? {},
         payload: spec.payload,
         status: "pending",
         toolUseId: triggerId,
      }

      this.pendingActivities.set(activityId, activity)
      this.emit(
         createActivityStart({
            activityId,
            parentActivityId,
            environment: spec.environment,
            kind: spec.kind,
            arguments: activity.arguments,
            toolUseId: activity.toolUseId,
            payload: spec.payload,
         }),
      )
      this.session.assignActivity(activity)
      return activity
   }

   // ── Activity feedback (routed from the session) ────────────────────

   /** Intermediate progress from an environment: audit + host notification. */
   deliverActivityProgress(activityId: string, feedback: any, progress?: number): void {
      if (!this.pendingActivities.has(activityId)) return
      this.emit(createActivityProgress(activityId, feedback, progress))
   }

     /**
      * Terminal feedback: emit ActivityComplete, then a wrapping ToolFeedback
      * when the activity was triggered by an LLM ToolUse (hook-originated
      * activities emit no ToolFeedback). The loop resumes when the pending
      * set becomes empty.
      */
     deliverActivityComplete(activityId: string, status: "completed" | "failed", result: any): void {
        const activity = this.pendingActivities.get(activityId)
        if (!activity) return
        this.pendingActivities.delete(activityId)

        const isError = status === "failed"
        this.emit(createActivityComplete(activityId, status))

        // Hook-originated activities (parent = harnessActivityId) do NOT emit
        // a wrapping ToolFeedback: this keeps the ToolUse → ToolFeedback
        // pattern exclusive to model-initiated invocations.
        const root =
           activity.parentActivityId === this.modelActivityId
              ? this.modelActivityId
              : this.harnessActivityId
        const fromHook = root === this.harnessActivityId
        if (!fromHook) {
           this.emit({
              ...createToolFeedback(activity.toolUseId!, activity.kind, result, isError),
              activityId: root,
           })
        }
        // A user-board interaction originated from a hook: the user's response
        // re-enters the thread as a UserMessage so the model can continue.
        if (fromHook && activity.environment === USER_BOARD_ENVIRONMENT) {
           this.emit(createUserMessage(stringifyResult(result)))
        }
       this.session.events.emit("toolend", {
          ...this.parentSnapshot,
          toolName: activity.kind,
          id: activity.toolUseId!,
          isError,
       })

       this.session.events.emit("activity_resolved", {
          ...this.parentSnapshot,
          activityId,
          status,
       })
       this.session.forgetActivity(activityId)

       // Resume only when everything is resolved and no loop is running.
        if (this.pendingActivities.size === 0 && !this.running) {
           void this.resumeAfterActivities()
        }
     }

    /**
     * Finds and runs a tool by name, returning its outcome. Does NOT emit any
    * feedback fragment — the caller wraps a direct ToolResult into a
    * ToolFeedback, or delegates when an ActivitySpec is returned. A not-found
    * tool is reported as an isError ToolResult rather than thrown.
    */
    private async runTool(
       toolName: string,
       args: Record<string, any>,
       id?: string,
    ): Promise<ToolOutcome | undefined> {
       // The first loop dispatches by ownership: it finds the resource that
       // publishes the tool via `getTools()` and delegates to its `applyTool`.
       // Agents and postures are skipped here — they contribute to the LLM
       // surface (collectTools) but do not own tool execution: an agent's
       // `applyTool` is a no-op, and a posture's `getTools()` is empty by
       // design. Their `type: route` entries are resolved explicitly below.
       for (const res of this.session.blueprint.resources) {
          if (res instanceof AgentObject || res instanceof PostureObject) continue
          const tools = res.getTools()
          const match = tools.find(
             (t) => t.name === toolName || t.name === `${res.name}/${toolName}`,
          )
          if (match) {
             return await res.applyTool(toolName, args, this, id)
          }
       }

       const skillRes = this.session.blueprint.getResource(toolName)
       if (skillRes instanceof SkillObject) {
          return await skillRes.activate(toolName, args, this, id)
       }

      for (const res of this.session.blueprint.resources) {
         if (res instanceof PostureObject && res.resolveSkillTemplate(toolName)) {
            return await res.activateSkill(toolName, args, this, id)
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
             const targetResource = this.session.blueprint.getResource(target)
             if (targetResource instanceof PostureObject) {
                return await targetResource.applyTool(toolName, args, this, id)
             }
          }
       }

       // Permanent fallback: a route declared on the agent's `spec.tooling` is
       // always reachable, even from no posture (entry / back-to-root). The
       // active posture wins above; we get here only when it doesn't declare
       // the route.
       const agentTarget = this.agent.resolveRouteTarget(toolName)
       if (agentTarget) {
          const targetResource = this.session.blueprint.getResource(agentTarget)
          if (targetResource instanceof PostureObject) {
             return await targetResource.applyTool(toolName, args, this, id)
          }
       }

      if (toolName.startsWith("subagent_")) {
         return await this.dispatchSubagent(toolName, args)
      }

      return { result: { error: `Tool not found: ${toolName}` }, isError: true }
   }

   /**
    * Resolves a `subagent_*` tool call to its agent resource and spawns a
    * child context for it. Subagent creation is an AgentContext capability —
    * the posture only exposes the `subagent_*` tool surface; the dispatch and
    * spawn live here.
    */
   private async dispatchSubagent(
      toolName: string,
      args: Record<string, any>,
   ): Promise<ToolOutcome | undefined> {
      const agentId = toolName.replace(/^subagent_/, "")
      const resource = this.session.blueprint.getResource(agentId)
      if (!resource || !(resource instanceof AgentObject)) {
         return { result: { error: `Subagent not found: ${agentId}` }, isError: true }
      }
      const behavior = resource.getBehavior()
      if (!behavior?.persona) {
         return { result: { error: `Subagent has no persona: ${agentId}` }, isError: true }
      }
      const task = typeof args.task === "string" ? args.task : ""
      return await this.runSubagent(agentId, resource, task)
   }

   /**
    * Spawns a child context bound to a subagent behavior, runs it
    * autonomously, and returns the ToolResult to wrap in a ToolFeedback on
    * the parent thread. Emits SubagentSpawn before run and SubagentComplete
    * after. The child inherits the session's blueprint resources and
    * completion service but has its own thread, posture, and token usage;
    * it cannot request user interaction.
    */
   async runSubagent(
      agentId: string,
      agentResource: AgentObject,
      task: string,
   ): Promise<ToolResult> {
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

      const last = child.thread.filterByType("AgentMessage").pop()
      const message = last?.content ?? "(no output)"
      return { result: { status, message } }
   }

   private traceFragment(f: AnyFragment): void {
      const preview = fragmentPreview(f)
      const shown = preview.length > 120 ? preview.slice(0, 120) + "…" : preview
      this.emitLog({
         level: "debug",
         fragmentType: f.type,
         source: f.type === "Instruction" ? f.source : undefined,
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
         currentPosture: this._currentPosture,
         tokenUsage: { ...this.tokenUsage },
         threadLength: fragments.length,
      }

      const behavior = {
         instructions: this.thread.filterByType("Instruction").map((f) => ({
            source: f.source,
         })),
         postureUses: this.thread.filterByType("PostureUse").map((f) => ({
            name: f.name,
         })),
         skillAttaches: this.thread.filterByType("SkillAttach").map((f) => ({
            name: f.name,
         })),
         skillDetaches: this.thread.filterByType("SkillDetach").map((f) => ({
            name: f.name,
         })),
      }

      const tool = {
         uses: this.thread.filterByType("ToolUse").map((f) => ({
            id: f.id,
            toolName: f.toolName,
         })),
         feedbacks: this.thread.filterByType("ToolFeedback").map((f) => ({
            toolUseId: f.toolUseId,
            toolName: f.toolName,
            isError: f.isError,
         })),
      }

      const others = {
         userMessages: this.thread.filterByType("UserMessage").length,
         agentMessages: this.thread.filterByType("AgentMessage").length,
         thinking: this.thread.filterByType("Thinking").length,
         references: this.thread.filterByType("Reference").map((f) => ({
            uri: f.uri,
         })),
      }

      const ts = new Date().toISOString()
      const docs: string[] = []
      docs.push(toYamlDoc({ trace: "context-change", timestamp: ts, triggeredBy: triggered.type, variables }))
      docs.push(toYamlDoc({ behavior }))
      docs.push(toYamlDoc({ tool }))
      docs.push(toYamlDoc({ others }))
      for (const f of fragments) {
         docs.push(toYamlDoc(f))
      }

      writeTraceFile(this.tracePath, docs.join("\n") + "\n")
   }
}

/** Reduce an arbitrary activity result to a string for the UserMessage path. */
function stringifyResult(result: unknown): string {
   if (typeof result === "string") return result
   try {
      return JSON.stringify(result)
   } catch {
      return String(result)
   }
}

