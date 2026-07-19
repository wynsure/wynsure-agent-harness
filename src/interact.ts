import { z } from "zod"
import { type ToolGuide, defineTool } from "./blueprint.ts"

export const INTERACT_PREFIX = "interact__"

export const INTERACT_ASK = "interact__ask"
export const INTERACT_CONFIRM = "interact__confirm"
export const INTERACT_TODO = "interact__todo"
export const INTERACT_NOTIFY = "interact__notify"
export const INTERACT_MESSAGE = "interact__message"

export function isInteractTool(toolName: string): boolean {
   return toolName.startsWith(INTERACT_PREFIX)
}

export const interactAskTool: ToolGuide = defineTool(
   INTERACT_ASK,
   "Ask the user a question. Provide 'choices' for single/multiple selection, 'suggestions' for free-text with hints, or neither for pure free-text input.",
   z.object({
      question: z.string().describe("The question to ask"),
      choices: z.array(z.string()).optional().describe("Fixed options to select from"),
      multiple: z.boolean().optional().describe("Allow multiple selections (default: false)"),
      suggestions: z.array(z.string()).optional().describe("Suggested responses for free-text input"),
      priority: z.number().optional().describe("Optional display priority (higher = shown first when several interactions are pending; default 0)"),
   }),
)

export const interactConfirmTool: ToolGuide = defineTool(
   INTERACT_CONFIRM,
   "Ask the user for a yes/no confirmation before proceeding.",
   z.object({
      message: z.string().describe("The message to confirm with the user"),
      priority: z.number().optional().describe("Optional display priority (higher = shown first when several interactions are pending; default 0)"),
   }),
)

export const interactTodoTool: ToolGuide = defineTool(
   INTERACT_TODO,
   "Display an interactive todo list. The user can check off completed items and submit. Use to track multi-step processes with the user.",
   z.object({
      title: z.string().describe("Title for the todo list"),
      items: z
         .array(
            z.union([
               z.string(),
               z.object({ label: z.string(), done: z.boolean().optional() }),
            ]),
         )
         .describe("Items in the todo list"),
      priority: z.number().optional().describe("Optional display priority (higher = shown first when several interactions are pending; default 0)"),
   }),
)

export const interactNotifyTool: ToolGuide = defineTool(
   INTERACT_NOTIFY,
   "Display a notification to the user that requires acknowledgement before continuing.",
   z.object({
      message: z.string().describe("The notification message"),
      level: z
         .enum(["info", "warn", "error"])
         .optional()
         .describe("Notification severity (default: info)"),
      priority: z.number().optional().describe("Optional display priority (higher = shown first when several interactions are pending; default 0)"),
   }),
)

export const interactMessageTool: ToolGuide = defineTool(
   INTERACT_MESSAGE,
   "Hand control to the user so they can create a free-form message. Use when the user should drive the conversation.",
   z.object({
      prompt: z.string().optional().describe("Optional prompt shown to the user"),
      priority: z.number().optional().describe("Optional display priority (higher = shown first when several interactions are pending; default 0)"),
   }),
)

export const INTERACT_TOOLS: ToolGuide[] = [
   interactAskTool,
   interactConfirmTool,
   interactTodoTool,
   interactNotifyTool,
   interactMessageTool,
]

export type InteractionKind = "ask" | "confirm" | "todo" | "notify" | "message"

interface BaseInteraction {
   id: string
   toolName: string
   kind: InteractionKind
   /**
    * Optional display priority the host may use to order stacked user-board
    * interactions (higher = first). The harness does not interpret it; the
    * webapp applies it as the primary sort key (see docs/serve.spec.md §
    * "Surface d'entrée unique"). Defaults to undefined, treated as 0 by hosts.
    */
   priority?: number
}

export interface AskInteraction extends BaseInteraction {
   kind: "ask"
   question: string
   choices?: string[]
   multiple?: boolean
   suggestions?: string[]
}

export interface ConfirmInteraction extends BaseInteraction {
   kind: "confirm"
   message: string
}

export interface TodoInteraction extends BaseInteraction {
   kind: "todo"
   title: string
   items: { label: string; done: boolean }[]
}

export interface NotifyInteraction extends BaseInteraction {
   kind: "notify"
   message: string
   level: "info" | "warn" | "error"
}

export interface MessageInteraction extends BaseInteraction {
   kind: "message"
   prompt?: string
}

export type UserInteraction =
   | AskInteraction
   | ConfirmInteraction
   | TodoInteraction
   | NotifyInteraction
   | MessageInteraction

function asStringArray(value: unknown): string[] {
   return Array.isArray(value)
      ? value.filter((v: unknown) => typeof v === "string")
      : []
}

function normalizeTodoItems(
   value: unknown,
): { label: string; done: boolean }[] {
   if (!Array.isArray(value)) return []
   return value.map((item) => {
      if (typeof item === "string") {
         return { label: item, done: false }
      }
      if (item && typeof item === "object" && "label" in item) {
         return {
            label: String((item as any).label),
            done: (item as any).done === true,
         }
      }
      return { label: String(item), done: false }
   })
}

export function buildInteraction(
   toolName: string,
   args: Record<string, any>,
   id: string,
): UserInteraction {
   const result = buildInteractionKind(toolName, args, id)
   // `priority` is shared by every kind; attach it once post-switch rather than
   // duplicating the read in each branch.
   if (typeof args.priority === "number" && Number.isFinite(args.priority)) {
      result.priority = args.priority
   }
   return result
}

function buildInteractionKind(
   toolName: string,
   args: Record<string, any>,
   id: string,
): UserInteraction {
   switch (toolName) {
      case INTERACT_ASK:
         return {
            id,
            toolName,
            kind: "ask",
            question: typeof args.question === "string" ? args.question : "",
            choices: Array.isArray(args.choices) ? asStringArray(args.choices) : undefined,
            multiple: args.multiple === true,
            suggestions: Array.isArray(args.suggestions)
               ? asStringArray(args.suggestions)
               : undefined,
         }

      case INTERACT_CONFIRM:
         return {
            id,
            toolName,
            kind: "confirm",
            message: typeof args.message === "string" ? args.message : "",
         }

      case INTERACT_TODO:
         return {
            id,
            toolName,
            kind: "todo",
            title: typeof args.title === "string" ? args.title : "",
            items: normalizeTodoItems(args.items),
         }

      case INTERACT_NOTIFY: {
         const level =
            args.level === "warn" || args.level === "error"
               ? (args.level as "warn" | "error")
               : "info"
         return {
            id,
            toolName,
            kind: "notify",
            message: typeof args.message === "string" ? args.message : "",
            level,
         }
      }

      case INTERACT_MESSAGE:
         return {
            id,
            toolName,
            kind: "message",
            prompt: typeof args.prompt === "string" ? args.prompt : undefined,
         }

      default:
         throw new Error(`Not an interact tool: ${toolName}`)
   }
}
