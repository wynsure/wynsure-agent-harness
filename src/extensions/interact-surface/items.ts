/**
 * InteractSurface registry — single dispatch point for every interact kind.
 *
 * One entry per kind captures everything the runtime needs: the tool name
 * (for the catalogue + tool lookup), the zod schema (for the catalogue), the
 * arg normaliser (`apply`), the per-kind `pinned` flag, and an optional
 * `reply` hook invoked when the backing activity resolves. Add a kind by
 * registering an entry; nothing else in the runtime branches on a kind name.
 *
 * Mirrors the UI-side registry (`agent-blueprint-ui/views/registry.ts`):
 * module-level map, last-writer-wins, simple `registerInteractionItem` /
 * lookup helpers. The two registries stay independent — one maps a kind to
 * its tool/payload runtime, the other maps the same kind to its React view —
 * and share only the kind string. Both registries only ever expose the
 * single-entry `registerInteractionItem` / `registerInteractionView`; there
 * is no batch collection variant.
 *
 * `pinned` is the ONLY behavioural seam. When true, the resource delegates
 * the response to the `user-board` environment: the item carries the activity
 * id, starts `pending`, and flips to `resolved`/`failed` when the host
 * resolves the activity. When false, the resource delivers immediately and
 * the item has no activity binding (fire-and-forget). `notify` and `prompt`
 * go through the exact same code path — only the per-entry fields differ.
 *
 * `reply` is the one extensible post-resolution hook. The resource hands it
 * the originating context and the resolution result; the entry is free to
 * emit whatever fragments it wants on that context. `prompt` uses this to
 * turn the user's free-form text into a real `UserMessage` conversation turn.
 * The resource never inspects what `reply` did — no `if (frag) ctx.emit(frag)`
 * seam, the entry owns its side effects.
 */
import { z, type ZodType } from "zod"
import { defineTool, type ToolGuide } from "../../blueprint/blueprint.ts"
import { createUserMessage } from "../../state/fragment.ts"
import type { AgentContext } from "../../runtime/context.ts"
import type {
   InteractionItemBase,
   InteractionItemDraft,
   NotifyLevel,
   RequestStatus,
} from "./state.ts"

// ── Item variants (host UI narrows via `kind`) ───────────────────────────────
//
// Helper interfaces for the built-in interact kinds. The kind is a plain
// string at the contract level (`InteractionKind = string`) — these are just
// ergonomic narrow types a host casts to for field access. They are NOT a
// closed union: the harness dispatches by registry entry, never by `kind`.

export interface AskItem extends InteractionItemBase {
   kind: "ask"
   question: string
   choices?: string[]
   multiple?: boolean
   suggestions?: string[]
}

export interface ConfirmItem extends InteractionItemBase {
   kind: "confirm"
   message: string
}

export interface TodoItem extends InteractionItemBase {
   kind: "todo"
   title: string
   items: { label: string; done: boolean }[]
}

export interface AlertItem extends InteractionItemBase {
   kind: "alert"
   message: string
   level: NotifyLevel
   /** Short heading shown in the card header (defaults to "alert" when empty). */
   title: string
}

export interface PromptItem extends InteractionItemBase {
   kind: "prompt"
   /** Optional short heading for the input area. */
   title?: string
   /** Optional prompt body shown to the user before the input. */
   message?: string
}

export interface NotifyItem extends InteractionItemBase {
   kind: "notify"
   message: string
   level: NotifyLevel
   /** Short heading shown in the banner header (defaults to "notify" when empty). */
   title: string
}

/** Kind discriminant. A plain string — the registry is the closed surface, not the type. */
export type InteractionKind = string

// ── Registry entry ──────────────────────────────────────────────────────────

/**
 * A single registry entry. `apply` normalises raw tool args into the payload
 * carried on the item (and on the backing activity when pinned). `reply` is
 * the optional post-resolution hook — the resource passes it the originating
 * context and the result; the entry emits whatever fragments it wants.
 */
export interface InteractionItemEntry<P = Record<string, unknown>> {
   /** Discriminant carried on the item AND the activity payload. */
   readonly kind: string
   /** Full tool name (interact__ask, …). */
   readonly tool: string
   /** One-line description for the tool catalogue. */
   readonly description: string
   /** True → delegates to the `user-board` env (item pinned: pending → resolved|failed). False → fire-and-forget. */
   readonly pinned: boolean
   /** Canonical zod schema for the tool args (no `kind`). */
   readonly schema: ZodType<P>
   /** Normalise raw tool args into the canonical payload body (with `kind`). */
   apply(args: Record<string, any>): P & { kind: string }
   /**
    * Optional post-resolution hook (pinned kinds). The resource passes the
    * originating context and the resolution result; the entry is free to emit
    * whatever fragments it wants on that context. The resource never inspects
    * the return — the entry owns its side effects.
    */
   reply?(ctx: AgentContext, result: unknown): void
}

const ENTRIES = new Map<string, InteractionItemEntry>()
const BY_TOOL = new Map<string, InteractionItemEntry>()

/** Register (or override) the entry for a kind. Last writer wins. */
export function registerInteractionItem(entry: InteractionItemEntry): void {
   ENTRIES.set(entry.kind, entry)
   BY_TOOL.set(entry.tool, entry)
}

/** Look up an entry by its kind discriminant. */
export function interactionItemEntry(kind: string): InteractionItemEntry | undefined {
   return ENTRIES.get(kind)
}

/** Look up an entry by its full tool name. */
export function interactionItemEntryByTool(tool: string): InteractionItemEntry | undefined {
   return BY_TOOL.get(tool)
}

/** Every registered entry (snapshot copy). */
export function interactionItemEntries(): readonly InteractionItemEntry[] {
   return [...ENTRIES.values()]
}

// ── Per-kind schemas (private; the registry is the public face) ──────────────

const askSchema = z.object({
   question: z.string().describe("The question to ask"),
   choices: z.array(z.string()).optional().describe("Fixed options to select from"),
   multiple: z.boolean().optional().describe("Allow multiple selections (default: false)"),
   suggestions: z.array(z.string()).optional().describe("Suggested responses for free-text input"),
   priority: z.number().optional().describe("Optional display priority (higher = shown first when several interactions are pinned; default 0)"),
})

const confirmSchema = z.object({
   message: z.string().describe("The message to confirm with the user"),
   priority: z.number().optional().describe("Optional display priority (higher = shown first when several interactions are pinned; default 0)"),
})

const todoItemSchema = z.union([
   z.string(),
   z.object({ label: z.string(), done: z.boolean().optional() }),
])
const todoSchema = z.object({
   title: z.string().describe("Title for the todo list"),
   items: z.array(todoItemSchema).describe("Items in the todo list"),
   priority: z.number().optional().describe("Optional display priority (higher = shown first when several interactions are pinned; default 0)"),
})

const alertSchema = z.object({
   message: z.string().describe("The alert message"),
   title: z.string().describe("Short heading shown in the card header (defaults to \"alert\" when empty)"),
   level: z.enum(["info", "warn", "error"]).optional().describe("Severity tint (default: info)"),
   priority: z.number().optional().describe("Optional display priority (higher = shown first when several interactions are pinned; default 0)"),
})

const promptSchema = z.object({
   title: z.string().optional().describe("Optional short heading for the input area"),
   message: z.string().optional().describe("Optional prompt body shown to the user before the input"),
   priority: z.number().optional().describe("Optional display priority (higher = shown first when several interactions are pinned; default 0)"),
})

const notifySchema = z.object({
   message: z.string().describe("The notification message"),
   title: z.string().describe("Short heading shown in the banner header (defaults to \"notify\" when empty)"),
   level: z.enum(["info", "warn", "error"]).optional().describe("Notification severity (default: info)"),
})

// ── Arg normalisers (private) ─────────────────────────────────────────────────

function asStringArray(value: unknown): string[] {
   return Array.isArray(value)
      ? value.filter((v: unknown) => typeof v === "string")
      : []
}

function normalizeTodoItems(value: unknown): { label: string; done: boolean }[] {
   if (!Array.isArray(value)) return []
   return value.map((item) => {
      if (typeof item === "string") return { label: item, done: false }
      if (item && typeof item === "object" && "label" in item) {
         return {
            label: String((item as any).label),
            done: (item as any).done === true,
         }
      }
      return { label: String(item), done: false }
   })
}

function optionalPriority(args: Record<string, any>): number | undefined {
   return typeof args.priority === "number" && Number.isFinite(args.priority)
      ? args.priority
      : undefined
}

function notifyLevelOf(args: Record<string, any>): NotifyLevel {
   return args.level === "warn" || args.level === "error" ? args.level : "info"
}

// ── Built-in kinds registered at import time ─────────────────────────────────

registerInteractionItem({
   kind: "ask",
   tool: "interact__ask",
   description: "Ask the user a question. Provide 'choices' for single/multiple selection, 'suggestions' for free-text with hints, or neither for pure free-text input.",
   pinned: true,
   schema: askSchema,
   apply(args) {
      return {
         kind: "ask",
         question: typeof args.question === "string" ? args.question : "",
         choices: Array.isArray(args.choices) ? asStringArray(args.choices) : undefined,
         multiple: args.multiple === true,
         suggestions: Array.isArray(args.suggestions) ? asStringArray(args.suggestions) : undefined,
         priority: optionalPriority(args),
      }
   },
})

registerInteractionItem({
   kind: "confirm",
   tool: "interact__confirm",
   description: "Ask the user for a yes/no confirmation before proceeding.",
   pinned: true,
   schema: confirmSchema,
   apply(args) {
      return {
         kind: "confirm",
         message: typeof args.message === "string" ? args.message : "",
         priority: optionalPriority(args),
      }
   },
})

registerInteractionItem({
   kind: "todo",
   tool: "interact__todo",
   description: "Display an interactive todo list. The user can check off completed items and submit. Use to track multi-step processes with the user.",
   pinned: true,
   schema: todoSchema,
   apply(args) {
      return {
         kind: "todo",
         title: typeof args.title === "string" ? args.title : "",
         items: normalizeTodoItems(args.items),
         priority: optionalPriority(args),
      }
   },
})

registerInteractionItem({
   kind: "alert",
   tool: "interact__alert",
   description: "Alert the user with a message that MUST be acknowledged before continuing. Use to force the user's attention on something critical before proceeding (the agent is suspended until acknowledged).",
   pinned: true,
   schema: alertSchema,
   apply(args) {
      return {
         kind: "alert",
         message: typeof args.message === "string" ? args.message : "",
         title: typeof args.title === "string" ? args.title : "",
         level: notifyLevelOf(args),
         priority: optionalPriority(args),
      }
   },
})

registerInteractionItem({
   kind: "prompt",
   tool: "interact__prompt",
   description: "Hand control to the user so they can drive the conversation. `message` is the prompt body shown before the input; `title` is an optional heading.",
   pinned: true,
   schema: promptSchema,
   apply(args) {
      return {
         kind: "prompt",
         title: typeof args.title === "string" ? args.title : undefined,
         message: typeof args.message === "string" ? args.message : undefined,
         priority: optionalPriority(args),
      }
   },
   reply(ctx, result) {
      // The user's free-form text becomes a real conversation turn.
      if (typeof result === "string" && result.length > 0) {
         ctx.emit(createUserMessage(result))
      }
   },
})

registerInteractionItem({
   kind: "notify",
   tool: "interact__notify",
   description: "Display a notification to the user. Fire-and-forget: the agent continues immediately without waiting for any acknowledgement. Use to surface information (progress, status, warnings) while the work goes on.",
   pinned: false,
   schema: notifySchema,
   apply(args) {
      return {
         kind: "notify",
         message: typeof args.message === "string" ? args.message : "",
         title: typeof args.title === "string" ? args.title : "",
         level: notifyLevelOf(args),
      }
   },
})

// ── Tool catalogue (derived from the registry) ───────────────────────────────

/** Tool guides for every registered interact__* kind — the full catalogue an InteractSurface exposes. */
export function getInteractTools(): readonly ToolGuide[] {
   return [...ENTRIES.values()].map((e) =>
      defineTool(e.tool, e.description, e.schema as ZodType<unknown>),
   )
}

// ── Payload / draft builders ──────────────────────────────────────────────────

/**
 * Build the payload of an interact__* tool from its call args. The resource's
 * `applyTool` embeds it on the InteractionItem (and on the backing activity
 * when the kind is pinned). Throws if the tool isn't an interact tool.
 */
export function buildInteractionPayload(
   tool: string,
   args: Record<string, any>,
): Record<string, any> & { kind: string } {
   const entry = interactionItemEntryByTool(tool)
   if (!entry) throw new Error(`Not an interact tool: ${tool}`)
   return entry.apply(args)
}

/**
 * Build an InteractionItem draft from a payload and the host-side base fields.
 * The item carries the kind only — the tool name lives on the registry entry,
 * not on the item. When `binding.activityId` is provided (the kind is pinned),
 * the draft is marked `pending` and indexed by that activity id so the runtime
 * can flip it on resolution. When omitted (the kind is not pinned), the draft
 * carries no activity binding — it is terminal from append.
 */
export function createInteractionItemDraft(
   payload: Record<string, any> & { kind: string },
   base: {
      contextId: string
      parentId: string | null
      agentName: string
   },
   binding?: { activityId: string },
): InteractionItemDraft {
   const draft: InteractionItemDraft = {
      ...payload,
      contextId: base.contextId,
      parentId: base.parentId,
      agentName: base.agentName,
   }
   if (binding) {
      draft.activityId = binding.activityId
      draft.status = "pending" satisfies RequestStatus
   }
   return draft
}