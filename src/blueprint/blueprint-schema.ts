import { z } from "zod"
import { InstructionInlineSchema } from "./instruction.ts"

export const RefSchema = z.object({
   $ref: z.string(),
})

export const ToolingParamSchema = z.union([
   z.string(),
   z
      .object({
         name: z.string().optional(),
         type: z.string().optional(),
      })
      .passthrough(),
])

/**
 * Tooling entries describe the tool surface exposed by a posture / skill /
 * agent. Each tooling variant is just a tool descriptor.
 */
export const RouteToolingSchema = z
   .object({
      type: z.literal("route"),
      name: z.string(),
      posture: z.string(),
      description: z.string().optional(),
      params: z.array(ToolingParamSchema).optional(),
   })
   .passthrough()

/**
 * `type: toolset` is the unified entry for selecting tools from other
 * resources. It accepts two mutually exclusive modes:
 *
 *   - `tools: "<resource>/<tools>"` (or a list of such patterns) — selects
 *     tools from one or more named resources. `<tools>` is `*` (all tools the
 *     resource publishes) or a comma-separated list of tool names (matched
 *     against the full name or the suffix after `${resource}__`). The virtual
 *     resource name `harness` exposes the harness-published builtin catalogue.
 *     A single-entry toolset is the common case; a list avoids the noise of
 *     declaring one toolset entry per source.
 *
 *   - `selector.matchLabels: { ... }` — multi-resource selection by label
 *     equality AND. Aggregates all tools from every non-Preset resource whose
 *     `metadata.labels` match.
 *
 * Combining `tools` and `selector` in the same entry is a validation error.
 */
export const ToolsetToolingSchema = z
   .object({
      type: z.literal("toolset"),
      tools: z.union([z.string(), z.array(z.string())]).optional(),
      selector: LabelSelectorPassthroughSchema().optional(),
   })
   .passthrough()
   .superRefine((data, ctx) => {
      if (data.tools !== undefined && data.selector !== undefined) {
         ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
               "toolset entry cannot combine `tools` and `selector` — pick one",
         })
      }
      if (data.tools === undefined && data.selector === undefined) {
         ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
               "toolset entry requires either `tools` or `selector`",
         })
      }
   })

export const SubagentToolingSchema = z
   .object({
      type: z.literal("subagent"),
      agent_id: z.string(),
   })
   .passthrough()

export const ToolingSchema = z.discriminatedUnion("type", [
   RouteToolingSchema,
   ToolsetToolingSchema,
   SubagentToolingSchema,
])

export type ToolingEntry = z.infer<typeof ToolingSchema>
export type RouteTooling = z.infer<typeof RouteToolingSchema>
export type ToolsetTooling = z.infer<typeof ToolsetToolingSchema>
export type SubagentTooling = z.infer<typeof SubagentToolingSchema>

export const InstructionRefSchema = z.union([
   RefSchema,
   InstructionInlineSchema,
   z.string(),
])

/**
 * Hook triggers — the thread events a hook can react to. `on_start` /
 * `on_completion` frame a generation turn; `on_tool_use` fires before a
 * model-emitted ToolUse is executed (prevented, can block); `on_tool_error`
 * fires after a tool invocation failed (LLM or hook origin). See
 * docs/architecture.spec.md.
 */
export type HookTrigger =
   | "on_start"
   | "on_completion"
   | "on_tool_use"
   | "on_tool_error"

/**
 * Optional local name carried by every hook variant. The fully qualified audit
 * name (`hooks:<owner>:<local>`) is built by the context that owns the
 * resource; the raw `name` here is only the local suffix. When omitted, a
 * default is derived from `type` + `ref` (e.g. `tooluse__echo__say`).
 */
const HookNameSchema = z.string().optional()

/**
 * Selector describing which tool names a guardrail or hook applies to. Three
 * forms: `"*"` (all tools), an explicit list of tool names, or a label
 * selector matched against the resource that publishes the tool (same
 * semantics as a toolset selector). See docs/concepts.md § "Composition, not
 * code". Defined here so both hook and guardrail schemas can reference
 * it without a forward temporal-dead-zone reference.
 */
export const GuardrailAppliesToSchema = z.union([
   z.literal("*"),
   z.array(z.string()),
   z
      .object({
         matchLabels: z.record(z.string(), z.string()).optional(),
      })
      .passthrough(),
])

export type GuardrailAppliesTo = z.infer<typeof GuardrailAppliesToSchema>

// `appliesTo` is optional on every hook variant and only meaningful for the
// tool-scoped triggers (`on_tool_use`, `on_tool_error`): it filters the hook
// by the LLM-emitted tool name (or the publishing resource's labels), using
// the same selector shape as guardrails. A hook without `appliesTo` matches
// every tool. Ignored for `on_start` / `on_completion` (no tool context).
const HookAppliesToSchema = GuardrailAppliesToSchema.optional()

export const TooluseHookSchema = z
   .object({
      name: HookNameSchema,
      type: z.literal("tooluse"),
      tool: z.string(),
      args: z.record(z.string(), z.any()).optional(),
      appliesTo: HookAppliesToSchema,
   })
   .passthrough()

export const RouteHookSchema = z
   .object({
      name: HookNameSchema,
      type: z.literal("route"),
      posture: z.string(),
      appliesTo: HookAppliesToSchema,
   })
   .passthrough()

export const ExitHookSchema = z
   .object({
      name: HookNameSchema,
      type: z.literal("exit"),
      appliesTo: HookAppliesToSchema,
   })
   .passthrough()

export const HookSchema = z.discriminatedUnion("type", [
   TooluseHookSchema,
   RouteHookSchema,
   ExitHookSchema,
])

export type HookEntry = z.infer<typeof HookSchema>

export const HooksSchema = z
   .object({
      on_start: z.array(HookSchema).optional(),
      on_completion: z.array(HookSchema).optional(),
      on_tool_use: z.array(HookSchema).optional(),
      on_tool_error: z.array(HookSchema).optional(),
   })
   .passthrough()

export type HooksDesc = z.infer<typeof HooksSchema>

/**
 * A single guardrail declaration. Inlined under `spec.guardrails[]` of an
 * owner resource (Agent / Posture / Skill / Preset). The fully qualified
 * audit name is `guardrails:<owner>:<name>`; the owner prefix is applied by
 * the context that owns the resource.
 */
export const GuardrailDeclSchema = z
   .object({
      name: z.string().min(1),
      description: z.string().optional(),
      appliesTo: GuardrailAppliesToSchema,
      assertion: z.string().optional(),
      message: z.string().optional(),
   })
   .passthrough()

export type GuardrailDecl = z.infer<typeof GuardrailDeclSchema>

export const GuardrailsSchema = z.array(GuardrailDeclSchema)

/**
 * Zod shape for a label selector entry used inside `toolset.selector`. Built as
 * a function so the surrounding `.passthrough()` object schema can embed it
 * without lifting a separate named export.
 */
function LabelSelectorPassthroughSchema() {
   return z
      .object({
         matchLabels: z.record(z.string(), z.string()).optional(),
      })
      .passthrough()
}
