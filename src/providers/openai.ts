import OpenAI, {
   APIConnectionError,
   APIConnectionTimeoutError,
   APIError,
} from "openai"
import { type ZodTypeAny, toJSONSchema } from "zod"
import type { ToolGuide } from "../blueprint.ts"
import { validateToolGuides } from "../blueprint.ts"
import { logger } from "../logger.ts"
import {
   type CompletionResult,
} from "../thread.ts"
import {
   type Fragment,
   createAgentMessage,
   createThinking,
   createToolUse,
} from "../fragment.ts"

export type SkillPlacement = "system" | "user"

export interface RetryPolicy {
   maxAttempts: number
   baseDelayMs: number
   maxDelayMs: number
   backoffFactor: number
   jitter: boolean
}

const DEFAULT_RETRY_POLICY: RetryPolicy = {
   maxAttempts: 4,
   baseDelayMs: 500,
   maxDelayMs: 20_000,
   backoffFactor: 2,
   jitter: true,
}

/**
 * A request is retried when the failure is plausibly transient: a connection
 * issue, a timeout, or an HTTP status that the server may recover from
 * (timeout / too many requests / server error).
 */
function isTransientError(err: unknown): boolean {
   if (err instanceof APIConnectionError || err instanceof APIConnectionTimeoutError) {
      return true
   }
   if (err instanceof APIError) {
      const status = err.status ?? 0
      return status === 408 || status === 429 || (status >= 500 && status <= 599)
   }
   return false
}

function sleep(ms: number): Promise<void> {
   return new Promise((resolve) => setTimeout(resolve, ms))
}

function resolveRetryPolicy(retry?: Partial<RetryPolicy>): RetryPolicy {
   const fromEnv = (): Partial<RetryPolicy> => {
      if (typeof process === "undefined" || !process.env) return {}
      const parse = (v: string | undefined): number | undefined => {
         if (v === undefined) return undefined
         const n = Number(v)
         return Number.isFinite(n) ? n : undefined
      }
      return {
         maxAttempts: parse(process.env.OPENAI_MAX_RETRIES),
         baseDelayMs: parse(process.env.OPENAI_RETRY_BASE_DELAY_MS),
         maxDelayMs: parse(process.env.OPENAI_RETRY_MAX_DELAY_MS),
      }
   }
   return { ...DEFAULT_RETRY_POLICY, ...fromEnv(), ...retry }
}

export interface OpenAIThreadCompletionOptions {
   model?: string
   skillPlacement?: SkillPlacement
   apiKey?: string
   baseURL?: string
   retry?: Partial<RetryPolicy>
}

function zodToJsonSchema(schema: ZodTypeAny): Record<string, any> {
   return toJSONSchema(schema) as Record<string, any>
}

function fragmentsToMessages(
   fragments: Fragment[],
   skillPlacement: SkillPlacement,
): any[] {
   const messages: any[] = []

   for (const frag of fragments) {
      switch (frag.type) {
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

function collectTools(toolGuides: ToolGuide[]): any[] {
   validateToolGuides(toolGuides)

   const tools: any[] = toolGuides.map((g) => ({
      type: "function",
      function: {
         name: g.name,
         description: g.intent ?? "",
         parameters: g.input
            ? zodToJsonSchema(g.input as ZodTypeAny)
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

export class OpenAIThreadCompletionService {
   private client: OpenAI
   readonly model: string
   readonly skillPlacement: SkillPlacement
   private readonly retry: RetryPolicy

   constructor(options: OpenAIThreadCompletionOptions = {}) {
      this.model = options.model ?? "gpt-5-nano"
      this.skillPlacement = options.skillPlacement ?? "system"
      this.retry = resolveRetryPolicy(options.retry)
      this.client = new OpenAI({
         apiKey: options.apiKey ?? (typeof process !== "undefined" ? process.env?.OPENAI_API_KEY : undefined),
         baseURL: options.baseURL,
         // Our RetryPolicy is the single source of truth for retries; disable
         // the SDK's built-in retry to avoid double-handling.
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
         reasoning_effort: "medium",
         messages,
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
