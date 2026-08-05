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

export interface ChecklistItem extends InteractionItemBase {
   kind: "checklist"
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

/**
 * Rich-content item produced by the `interact__display` tool. The kind is
 * the "raw content shown to the user" family — fire-and-forget, no activity,
 * the body is rendered as-is (no sanitization).
 */
export interface DisplayItem extends InteractionItemBase {
   kind: "display"
   /** Raw HTML rendered via `dangerouslySetInnerHTML`. No sanitization. */
   html: string
}

/** Lifecycle of a single step in the agent's plan. */
export type PlanStepStatus = "pending" | "active" | "done" | "skipped"

/** One step of the agent's declared plan. */
export interface PlanStep {
   label: string
   status: PlanStepStatus
}

/**
 * The agent's live roadmap, produced by `interact__plan`. Upsertable: the
 * resource keeps exactly ONE plan item per context — re-calling the tool
 * updates it in place so the user follows a single evolving checklist, not a
 * pile of snapshots. Non-blocking (fire-and-forget); the agent owns progress
 * by re-emitting the steps with updated statuses.
 */
export interface PlanItem extends InteractionItemBase {
   kind: "plan"
   /** Optional heading for the plan. */
   title?: string
   steps: PlanStep[]
}

/**
 * The agent's current focus, produced by `interact__announce`. Upsertable:
 * only the latest announce is live — re-calling replaces the previous one, so
 * it reads as a single "working on X" indicator rather than a log. Distinct
 * from `notify` (an append-only severity banner) and from `plan` (a
 * multi-step roadmap): announce is the one-line "what I'm doing right now".
 */
export interface AnnounceItem extends InteractionItemBase {
   kind: "announce"
   /** Short, imperative description of the current action. */
   action: string
   /** Optional extra context shown alongside the action. */
   detail?: string
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
   /**
    * True → the resource keeps ONE living item for this kind and replaces it in
    * place on every call (emits `replace`, stable `seq`). Implies fire-and-
    * forget (never pinned). Used by the agent-driven living kinds (`plan`,
    * `announce`); false for every append/once kind.
    */
   readonly upsert?: boolean
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

// `priority` is intentionally absent from every schema below: it is a UI
// ordering hint the model cannot set meaningfully (it has no view of the other
// pinned items). The runtime still reads `args.priority` in each `apply()` so a
// host can inject it programmatically — it is simply hidden from the LLM contract.
const askSchema = z.object({
   question: z.string().describe("The question to ask the user"),
   choices: z.array(z.string()).optional().describe("Fixed options the user must select from. Omit for free-text input."),
   multiple: z.boolean().optional().describe("Allow several selections from `choices` (default: false)"),
   suggestions: z.array(z.string()).optional().describe("Suggested free-text answers shown as hints (not enforced)"),
})

const confirmSchema = z.object({
   message: z.string().describe("The yes/no statement to confirm with the user"),
})

const checklistItemSchema = z.union([
   z.string(),
   z.object({ label: z.string(), done: z.boolean().optional() }),
])
const checklistSchema = z.object({
   title: z.string().describe("Heading shown above the checklist"),
   items: z.array(checklistItemSchema).describe("Items in the checklist. Each may be a string (defaults to not done) or `{ label, done }`."),
})

const alertSchema = z.object({
   message: z.string().describe("The critical message the user must acknowledge"),
   title: z.string().describe("Short heading shown in the card header (defaults to \"alert\")"),
   level: z.enum(["info", "warn", "error"]).optional().describe("Severity: info, warn, or error (default: info)"),
})

const promptSchema = z.object({
   title: z.string().optional().describe("Short heading for the input area. Omit for no heading."),
   message: z.string().optional().describe("Body text shown above the input. Omit for no body."),
})

const notifySchema = z.object({
   message: z.string().describe("The notification message to display"),
   title: z.string().describe("Short heading shown in the banner header (defaults to \"notify\")"),
   level: z.enum(["info", "warn", "error"]).optional().describe("Severity: info, warn, or error (default: info)"),
})

const displaySchema = z.object({
   html: z.string().describe("The raw HTML to render. Rendered as-is via dangerouslySetInnerHTML — no sanitization."),
})

const planStepSchema = z.object({
   label: z.string().describe("Short description of this step"),
   status: z.enum(["pending", "active", "done", "skipped"]).optional().describe("Lifecycle state: pending, active, done, or skipped (default: pending)"),
})
const planSchema = z.object({
   title: z.string().optional().describe("Heading for the plan. Omit for no heading."),
   steps: z.array(planStepSchema).describe("The full plan — re-calling replaces the live plan in place, so send every step each time."),
})

const announceSchema = z.object({
   action: z.string().describe("Short imperative phrase describing what you are doing right now (e.g. \"Running tests\")"),
   detail: z.string().optional().describe("Extra context shown alongside the action. Omit for none."),
})

// ── Arg normalisers (private) ─────────────────────────────────────────────────

function asStringArray(value: unknown): string[] {
   return Array.isArray(value)
      ? value.filter((v: unknown) => typeof v === "string")
      : []
}

function normalizeChecklistItems(value: unknown): { label: string; done: boolean }[] {
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

const PLAN_STATUSES = new Set(["pending", "active", "done", "skipped"])

/** Coerce raw plan-step args into the canonical `{ label, status }` shape. */
function normalizePlanSteps(value: unknown): PlanStep[] {
   if (!Array.isArray(value)) return []
   return value.map((s) => {
      if (typeof s === "string") return { label: s, status: "pending" }
      if (s && typeof s === "object" && "label" in s) {
         const raw = (s as any).status
         return {
            label: String((s as any).label),
            status: typeof raw === "string" && PLAN_STATUSES.has(raw) ? (raw as PlanStepStatus) : "pending",
         }
      }
      return { label: String(s), status: "pending" }
   })
}

function notifyLevelOf(args: Record<string, any>): NotifyLevel {
   return args.level === "warn" || args.level === "error" ? args.level : "info"
}

// ── Built-in kinds registered at import time ─────────────────────────────────

registerInteractionItem({
   kind: "ask",
   tool: "interact__ask",
   description: "Ask the user a question and block until they answer (the agent is suspended). Set `choices` to constrain the answer to a fixed list (single or multiple when `multiple` is true), `suggestions` to hint free-text answers, or omit both for pure free-text. Use for any question needing a selected or structured reply. For an open-ended reply that becomes a conversation turn, use `interact__prompt` instead; for a yes/no decision, use `interact__confirm`.",
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
   description: "Ask the user for a yes/no confirmation and block until they respond (the agent is suspended). Use before an irreversible or high-impact action. For anything other than a binary approve/reject decision, prefer `interact__ask` (structured choices) or `interact__prompt` (free text).",
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
   kind: "checklist",
   tool: "interact__checklist",
   description: "Present an interactive checklist the user completes and submits, and block until they submit (the agent is suspended). Use when you want the user to mark which steps are done in a multi-step process. For a checklist the agent itself tracks as it works (non-blocking, agent-driven), use `interact__plan` instead.",
   pinned: true,
   schema: checklistSchema,
   apply(args) {
      return {
         kind: "checklist",
         title: typeof args.title === "string" ? args.title : "",
         items: normalizeChecklistItems(args.items),
         priority: optionalPriority(args),
      }
   },
})

registerInteractionItem({
   kind: "alert",
   tool: "interact__alert",
   description: "Surface a critical message the user MUST acknowledge before you continue (the agent is suspended until acknowledged). Use only to force attention on something that genuinely blocks progress. For a non-blocking severity notice, use `interact__notify` instead.",
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
   description: "Hand control to the user for an open-ended reply and block until they respond (the agent is suspended). The reply becomes a real conversation turn. Use when you want free-form input. For a targeted question with selectable choices, use `interact__ask` instead; for a yes/no decision, use `interact__confirm`.",
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
   description: "Display a severity-tinted notification banner (info/warn/error). Fire-and-forget: you continue immediately and there is nothing for the user to resolve. Use to surface status, progress, or warnings while work goes on. Appends a new banner each call. For a single evolving 'working on X now' indicator use `interact__announce`; to force attention before continuing use `interact__alert`.",
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

// `interact__display` produces a single `display` item kind. Fire-and-forget:
// the agent continues immediately and the item has no activity binding. The
// body is rendered as-is (no sanitization) so the tool is meant for trusted
// content the agent authors itself.
registerInteractionItem({
   kind: "display",
   tool: "interact__display",
   description: "Render a raw HTML card in the chat (custom layout, inline CSS, images, iframes). Fire-and-forget: you continue immediately. The HTML is rendered as-is with no sanitization, so use only for content you author yourself. For plain text, just speak normally — your message is shown as-is and is always preferred over `display` when it would do. For a severity notice use `interact__notify` instead.",
   pinned: false,
   schema: displaySchema,
   apply(args) {
      return {
         kind: "display",
         html: typeof args.html === "string" ? args.html : "",
      }
   },
})

// `interact__plan` and `interact__announce` are the agent-driven living kinds:
// fire-and-forget (never pinned) but upsertable — the resource keeps exactly one
// living item per kind and replaces it in place on every call. The agent owns
// progress by re-emitting; the host sees a single evolving indicator, not a log.
registerInteractionItem({
   kind: "plan",
   tool: "interact__plan",
   description: "Declare or update your plan as a checklist of steps the user can follow along. Non-blocking: you continue immediately. Upsertable: re-calling replaces the live plan in place (the user sees one evolving roadmap, not a stack of versions), so send the FULL plan every time. Mark each step pending → active → done (or skipped) as you progress. Declare it when you start multi-step work and keep it current. For a one-line 'what I'm doing right now' indicator use `interact__announce`; for a checklist the user completes themselves use `interact__checklist`.",
   pinned: false,
   upsert: true,
   schema: planSchema,
   apply(args) {
      return {
         kind: "plan",
         title: typeof args.title === "string" ? args.title : undefined,
         steps: normalizePlanSteps(args.steps),
      }
   },
})

registerInteractionItem({
   kind: "announce",
   tool: "interact__announce",
   description: "Tell the user what you are doing right now in one short line. Non-blocking: you continue immediately. Upsertable: re-calling replaces the previous announce (only your current focus is shown, not a log). Use as a live 'working on X' indicator. For a structured multi-step roadmap use `interact__plan`; for a severity-tinted notice (info/warn/error) use `interact__notify`.",
   pinned: false,
   upsert: true,
   schema: announceSchema,
   apply(args) {
      return {
         kind: "announce",
         action: typeof args.action === "string" ? args.action : "",
         detail: typeof args.detail === "string" ? args.detail : undefined,
      }
   },
})

// ── Tool catalogue (derived from the registry) ───────────────────────────────

/**
 * Tool guides for every registered interact__* kind — the full catalogue an
 * InteractSurface exposes. Iterates over the per-tool map so multi-tool kinds
 * (e.g. `display` → `interact__display_html` + `interact__display_markdown`)
 * contribute every tool, not just the last one registered.
 */
export function getInteractTools(): readonly ToolGuide[] {
   return [...BY_TOOL.values()].map((e) =>
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