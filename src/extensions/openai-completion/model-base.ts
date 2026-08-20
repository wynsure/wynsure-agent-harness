import OpenAI from "openai"
import { type ZodTypeAny, toJSONSchema } from "zod"
import type {
   ResourceObject,
} from "../../runtime/resource.ts"
import type {
   ToolGuide,
   ToolName,
} from "../../runtime/tool.ts"
import { validateToolGuides } from "../../runtime/tool.ts"
import type {
   GuardrailDecl,
   HookEntry,
   HookTrigger,
} from "../../blueprint/blueprint-schema.ts"
import type { ObjectManifest, ObjectMeta } from "../../blueprint/object-meta.ts"
import type { ServiceContract } from "../../blueprint/service.ts"
import {
   type IThreadCompletionService,
   type CompletionResult,
   ThreadCompletionService,
} from "../../runtime/thread.ts"
import type { AgentContext } from "../../runtime/context.ts"
import type { ActivityId } from "../../state/activity.ts"
import {
   type Fragment,
   createAgentMessage,
   createThinking,
   createToolUse,
} from "../../state/fragment.ts"
import { logger } from "../../system/logger.ts"

/** Read a process environment variable (undefined outside Node). */
export function env(name: string): string | undefined {
   return typeof process !== "undefined" ? process.env?.[name] : undefined
}

/**
 * Observed model state — audit only, never the runtime source of truth.
 */
export interface ModelStatus {
   readonly kind: string
}

/**
 * BaseModelObject — the shared mechanics every model-kind resource reuses
 * (OpenAIModel, OllamaModel, AzureFoundryModel…). Each concrete kind turns its
 * spec into a live `IThreadCompletionService` via `buildCompletion`; the base
 * owns the capability dispatch (`getService`), the lazy build + cache, and the
 * inert tool surface.
 *
 * A model resource publishes no tools, hooks or fragments: it exists solely to
 * provide the `ThreadCompletionService` capability. The agent references it by
 * name via `spec.model`; resolution is contract-based (see
 * docs/architecture.spec.md § "ServiceContract").
 *
 * Every model kind targets an OpenAI-compatible Chat Completions endpoint, so
 * the concrete engine (`OpenAIThreadCompletionService`) lives alongside the
 * base in this module rather than behind a pluggable provider seam.
 */
export abstract class BaseModelObject<S = unknown> implements ResourceObject {
   abstract readonly apiVersion: string
   abstract readonly kind: string
   readonly metadata: ObjectMeta
   readonly name: string
   readonly spec: S
   private cached?: IThreadCompletionService

   protected constructor(metadata: ObjectMeta, spec: S) {
      this.metadata = metadata
      this.name = metadata.name
      this.spec = spec
   }

   get status(): ModelStatus {
      return { kind: this.kind }
   }

   getService<T>(contract: ServiceContract<T>): T | undefined {
      if (contract.id === ThreadCompletionService.id) {
         this.cached ??= this.buildCompletion()
         return this.cached as unknown as T
      }
      return undefined
   }

   /** Build the live completion service from the spec. Called once. */
   protected abstract buildCompletion(): IThreadCompletionService

   getTools(): ToolGuide[] {
      return []
   }
   getHooks(_trigger: HookTrigger): HookEntry[] {
      return []
   }
   getGuardrails(): GuardrailDecl[] {
      return []
   }
   async applyTool(
      _toolName: ToolName,
      _params: Record<string, any>,
      _context: AgentContext,
      _deliveryId?: ActivityId,
   ): Promise<string | undefined> {
      return undefined
   }
   toManifest(): ObjectManifest {
      return {
         apiVersion: this.apiVersion,
         kind: this.kind,
         metadata: this.metadata,
         spec: this.spec as unknown,
      }
   }
}

// ---------------------------------------------------------------------------
// OpenAI-compatible Chat Completions engine
//
// The single completion service backing every model-kind resource. Speaks the
// OpenAI Chat Completions wire format, which OpenAI, Ollama (/v1) and Azure AI
// Foundry all expose. The harness knows only the `IThreadCompletionService`
// contract; this class is the one concrete implementation, owned here.
// ---------------------------------------------------------------------------

export type SkillPlacement = "system" | "user"

export interface OpenAIThreadCompletionOptions {
   model?: string
   skillPlacement?: SkillPlacement
   reasoningEffort?: string
   apiKey?: string
   baseURL?: string
}

/**
 * Project the agent thread (a sequence of fragments) onto the OpenAI Chat
 * Completions message list. `Instruction`/`PostureUse`/`Reference` map to a
 * system message; `SkillAttach` to system or user per `skillPlacement`;
 * `UserMessage` to user; `AgentMessage` to assistant (merged into a preceding
 * tool-call assistant message when present); `ToolUse` to `tool_calls`;
 * `ToolFeedback` to a `tool` message placed right after the assistant that
 * owns the call. `SkillDetach`/`PostureExit` and the Activity lifecycle
 * signals are audit-only and emit no message.
 */
function fragmentsToMessages(
   fragments: Fragment[],
   skillPlacement: SkillPlacement,
): any[] {
   const messages: any[] = []

   for (const frag of fragments) {
      switch (frag.kind) {
         case "Instruction":
            messages.push({ role: "system", content: frag.content })
            break

         case "PostureUse":
            messages.push({ role: "system", content: frag.content })
            break

         case "PostureExit":
            break

         case "SkillAttach":
            if (skillPlacement === "system") {
               messages.push({ role: "system", content: frag.content })
            } else {
               messages.push({ role: "user", content: frag.content })
            }
            break

         case "SkillDetach":
            break

         case "UserMessage":
            messages.push({ role: "user", content: frag.content })
            break

         case "AgentMessage": {
            let content = frag.content
            const last = messages[messages.length - 1]
            if (last && last.role === "assistant" && !last.content) {
               last.content = content
            } else {
               messages.push({ role: "assistant", content })
            }
            break
         }

         case "Thinking":
            break

         case "ToolUse": {
            const toolCall = {
               id: frag.id,
               type: "function",
               function: {
                  name: frag.toolName,
                  arguments: JSON.stringify(frag.arguments),
               },
            }
            const last = messages[messages.length - 1]
            if (last && last.role === "assistant") {
               if (!last.tool_calls) last.tool_calls = []
               last.tool_calls.push(toolCall)
            } else {
               messages.push({
                  role: "assistant",
                  content: null,
                  tool_calls: [toolCall],
               })
            }
            break
         }

         case "ToolFeedback": {
            const result = frag.result
            const content =
               typeof result === "string" ? result : JSON.stringify(result)
            const toolMsg = {
               role: "tool" as const,
               tool_call_id: frag.toolUseId,
               content,
            }

            let insertIdx = -1
            for (let i = messages.length - 1; i >= 0; i--) {
               const m = messages[i]
               if (
                  m.role === "assistant" &&
                  Array.isArray(m.tool_calls) &&
                  m.tool_calls.some((tc: any) => tc.id === frag.toolUseId)
               ) {
                  insertIdx = i + 1
                  break
               }
            }

            if (insertIdx >= 0) {
               while (
                  insertIdx < messages.length &&
                  messages[insertIdx].role === "tool"
               ) {
                  insertIdx++
               }
               messages.splice(insertIdx, 0, toolMsg)
            } else {
               messages.push(toolMsg)
            }
            break
         }

         case "Reference":
            messages.push({
               role: "system",
               content: `Reference: ${frag.uri}\n\n${frag.content}`,
            })
            break

         case "ActivityStart":
         case "ActivityProgress":
         case "ActivityComplete":
            // Activity lifecycle signals are audit-only; they carry no
            // content for the model. The terminal ToolFeedback that follows
            // an ActivityComplete is what the model sees.
            break

         case "Opaque":
            messages.push(frag.data)
            break
      }
   }

   return messages
}

/**
 * Build the OpenAI function-calling tool list from the harness tool guides,
 * deduplicated by name.
 */
function collectTools(toolGuides: ToolGuide[]): any[] {
   validateToolGuides(toolGuides)

   const tools: any[] = toolGuides.map((g) => ({
      type: "function",
      function: {
         name: g.name,
         description: g.intent ?? "",
         parameters: g.input
            ? (toJSONSchema(g.input as ZodTypeAny) as Record<string, any>)
            : { type: "object", properties: {} },
      },
   }))

   const seen = new Set<string>()
   return tools.filter((t) => {
      if (seen.has(t.function.name)) return false
      seen.add(t.function.name)
      return true
   })
}

/** Extract reasoning text (chain-of-thought) if the model emits any. */
function extractReasoning(message: any): string | null {
   const rc = (message as any)?.reasoning_content
   if (typeof rc === "string" && rc.length > 0) return rc

   const r = (message as any)?.reasoning
   if (r && Array.isArray((r as any).content)) {
      const texts = (r as any).content
         .filter((c: any) => typeof c?.text === "string" && c.text.length > 0)
         .map((c: any) => c.text)
      if (texts.length > 0) return texts.join("\n")
   }
   if (typeof r === "string" && r.length > 0) return r

   return null
}

/** Turn one OpenAI choice message into the harness fragment stream. */
function responseToFragments(message: any): Fragment[] {
   const fragments: Fragment[] = []

   const reasoning = extractReasoning(message)
   if (reasoning) {
      fragments.push(createThinking(reasoning))
   }

   if (message.content) {
      fragments.push(createAgentMessage(message.content))
   }

   if (message.tool_calls) {
      for (const tc of message.tool_calls) {
         let args: Record<string, any> = {}
         try {
            args = JSON.parse(tc.function.arguments)
         } catch (err) {
            logger.warn(
               { err, toolCallId: tc.id, toolName: tc.function.name, raw: tc.function.arguments },
               "failed to parse tool call arguments",
            )
            args = {}
         }
         fragments.push(createToolUse(tc.id, tc.function.name, args))
      }
   }

   return fragments
}

/**
 * OpenAIThreadCompletionService — the OpenAI-compatible Chat Completions
 * engine. Used unchanged by OpenAIModel, OllamaModel and AzureFoundryModel;
 * each just configures `model`/`baseURL`/`apiKey` for its endpoint.
 *
 * Completions are not retried: a failed request surfaces directly to the
 * caller (the run loop), which keeps failure observable.
 */
export class OpenAIThreadCompletionService {
   private client: OpenAI
   readonly model: string
   readonly skillPlacement: SkillPlacement
   readonly reasoningEffort: string | undefined

   constructor(options: OpenAIThreadCompletionOptions = {}) {
      this.model = options.model ?? "gpt-5-nano"
      this.skillPlacement = options.skillPlacement ?? "system"
      this.reasoningEffort = options.reasoningEffort
      this.client = new OpenAI({
         apiKey:
            options.apiKey ??
            (typeof process !== "undefined" ? process.env?.OPENAI_API_KEY : undefined),
         baseURL: options.baseURL,
         maxRetries: 0,
      })
   }

   async complete(
      thread: Fragment[],
      tools: ToolGuide[],
      signal?: AbortSignal,
   ): Promise<CompletionResult> {
      const messages = fragmentsToMessages(thread, this.skillPlacement)
      const openaiTools = collectTools(tools)

      const request: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming = {
         model: this.model,
         messages,
      }

      if (this.reasoningEffort) {
         request.reasoning_effort = this.reasoningEffort as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming["reasoning_effort"]
      }

      if (openaiTools.length > 0) {
         request.tools = openaiTools
      }

      let response: any
      try {
         response = await this.client.chat.completions.create(
            request,
            signal ? { signal } : undefined,
         )
      } catch (err) {
         // Wrap non-Error throws (e.g. undefined) into a descriptive Error so
         // the caller gets an actionable message instead of "undefined".
         if (err instanceof Error) throw err
         const detail = {
            thrownType: typeof err,
            thrownValue: err === undefined ? "undefined" : JSON.stringify(err),
            model: this.model,
            baseURL: this.client.baseURL,
            messageCount: messages.length,
            toolCount: openaiTools.length,
            stack: new Error("capture point").stack,
         }
         console.error("[openai] complete: caught non-Error throw:", detail)
         throw new Error(
            `OpenAI request failed with a non-Error value (${typeof err}). ` +
               `Details: ${JSON.stringify(detail)}`,
         )
      }
      const choice = response.choices[0]

      if (!choice) {
         return { fragments: [] }
      }

      const fragments = responseToFragments(choice.message)

      const rawUsage = response.usage as any
      const usage = rawUsage
         ? {
            inputTokens: rawUsage.prompt_tokens ?? 0,
            cachedTokens: rawUsage.prompt_tokens_details?.cached_tokens ?? 0,
            outputTokens: rawUsage.completion_tokens ?? 0,
         }
         : undefined

      return { fragments, usage }
   }
}
