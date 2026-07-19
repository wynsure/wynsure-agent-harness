import { z } from "zod"
import {
   type AgentBehavior,
   type Blueprint,
   type PresetView,
   type ResourceObject,
   type ToolGuide,
   type ToolOutcome,
   type ToolingEntry,
   type GuardrailDecl,
   type HookEntry,
   type HookTrigger,
} from "../blueprint.ts"
import {
   type InstructionTemplate,
   resolveInstructionTemplate,
   checkInstructionTemplate,
   resolveInstructionRef,
   mergeInstructionTemplates,
} from "../instruction.ts"
import {
   type ObjectManifest,
   type ObjectMeta,
   type ObjectLoadContext,
   type LabelSelector,
   scheme,
   ObjectMetaSchema,
   labelSelectorMatches,
} from "../object-meta.ts"
import {
   GuardrailsSchema,
   HooksSchema,
   InstructionRefSchema,
   ToolingSchema,
} from "../blueprint-schema.ts"
import type { AgentContext } from "../context.ts"
import {
   createSkillAttach,
   createPostureUse,
} from "../fragment.ts"
import { resolveBuiltinTool, listBuiltinToolNames } from "../builtin.ts"
import { AGENT_API_VERSION } from "./agent.ts"

function contextVariables(context: AgentContext): Record<string, unknown> {
   return {
      cwd: context.session.blueprint.instructions.cwd,
      sessionId: context.session.sessionId,
      agentName: context.session.agentName,
      currentPosture: context.currentPosture ?? "",
   }
}

function resolveAndCheck(
   template: InstructionTemplate,
   context: AgentContext,
   params: Record<string, any>,
): { resolved: string; check: ReturnType<typeof checkInstructionTemplate> } {
   const variables = { ...contextVariables(context), ...params }
   const resolved = resolveInstructionTemplate(template, variables)
   const check = checkInstructionTemplate(template, {
      availableTools: context.availableToolNames(),
      variables: Object.keys(variables),
   })
   return { resolved, check }
}

/** Virtual resource name exposing the harness-published builtin catalogue. */
const HARNESS_RESOURCE_NAME = "harness"

/**
 * Parse a `toolset.pattern` string `<resource>/<tools>` into its parts. `<tools>`
 * is either `*` (all) or a comma-separated list of tool names. Whitespace
 * around commas is ignored. Throws if the pattern is malformed.
 */
function parseToolsetPattern(pattern: string): {
   resourceName: string
   toolNames: string[] | null // null means "*"
} {
   const slash = pattern.indexOf("/")
   if (slash <= 0 || slash === pattern.length - 1) {
      throw new Error(
         `Invalid toolset pattern "${pattern}": expected "<resource>/<tools>" where <tools> is "*" or a comma-separated list`,
      )
   }
   const resourceName = pattern.slice(0, slash).trim()
   const tail = pattern.slice(slash + 1).trim()
   if (!resourceName) {
      throw new Error(`Invalid toolset pattern "${pattern}": empty resource name`)
   }
   if (tail === "*") return { resourceName, toolNames: null }
   const toolNames = tail
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
   if (toolNames.length === 0) {
      throw new Error(
         `Invalid toolset pattern "${pattern}": empty tool list (use "*" for all tools)`,
      )
   }
   return { resourceName, toolNames }
}

/**
 * True iff `tool` matches one of the requested names. The match accepts both
 * the full tool name (as exposed to the LLM) and the suffix after
 * `${resourceName}__`, so `pattern: "memory/set"` resolves the tool
 * `memory__set` published by resource `memory`.
 */
function toolMatches(tool: ToolGuide, resourceName: string, requested: string[]): boolean {
   const full = tool.name
   if (requested.includes(full)) return true
   const prefix = `${resourceName}__`
   if (full.startsWith(prefix)) {
      const suffix = full.slice(prefix.length)
      if (requested.includes(suffix)) return true
   }
   return false
}

/**
 * Resolve a single `tools` pattern (`<resource>/<tools>`) against the
 * blueprint, pushing the matching guides into `out`. Shared by every entry
 * of a `tools: string[]` (and the single-string form, normalized to `[str]`
 * by the caller). The virtual resource `harness` exposes the builtin
 * catalogue. Tool-name filtering matches either the full name or the suffix
 * after `${resource}__`.
 */
function resolveToolsPattern(
   pattern: string,
   blueprint: Blueprint,
   out: ToolGuide[],
): void {
   const { resourceName, toolNames } = parseToolsetPattern(pattern)
   if (resourceName === HARNESS_RESOURCE_NAME) {
      if (toolNames === null) {
         for (const name of listBuiltinToolNames()) {
            const guide = resolveBuiltinTool(name)
            if (guide) out.push(guide)
         }
      } else {
         for (const name of toolNames) {
            const guide = resolveBuiltinTool(name)
            // Load-time validation (validateBuiltinTooling) guarantees this
            // is defined; the throw is defensive.
            if (!guide) {
               throw new Error(`Unknown builtin tool: ${name}`)
            }
            out.push(guide)
         }
      }
      return
   }
   const res = blueprint.getResource(resourceName)
   if (res && res.kind === "Skill") {
      // Skill activation tool: same shape as before unification.
      out.push({
         name: res.name,
         intent:
            (res as { spec?: { description?: string } }).spec?.description ??
            res.name,
         input: z.object({}),
      })
      return
   }
   if (res) {
      const all = res.getTools()
      if (toolNames === null) {
         out.push(...all)
      } else {
         out.push(...all.filter((g) => toolMatches(g, resourceName, toolNames)))
      }
      return
   }
   // Legacy inline skill: the resource name resolves to a plain instruction
   // template registered on the collection.
   if (blueprint.instructions.has(resourceName)) {
      const skillTemplate = blueprint.instructions.get(resourceName)
      out.push({
         name: skillTemplate.name,
         intent: skillTemplate.description ?? "",
         input: z.object({}),
      })
      return
   }
   throw new Error(
      `toolset tools "${pattern}" references unknown resource "${resourceName}"`,
   )
}

/**
 * Materializes the live tool surface from a list of tooling entries against the
 * loaded blueprint. Shared by postures, skills, and the agent's permanent
 * tooling. A `type: "toolset"` entry selects tools in one of two modes:
 *
 *   - `tools: "<resource>/<tools>"` (string or string[]) — one or more named
 *     resources. The virtual resource `harness` exposes the builtin catalogue.
 *   - `selector.matchLabels` — multi-resource by label equality AND.
 *
 * A `type: "subagent"` entry exposes a `subagent_<id>` tool with a fixed
 * `task: string` argument. Presets are never selectable.
 */
export function resolveToolingGuides(
   tooling: ToolingEntry[],
   blueprint: Blueprint,
): ToolGuide[] {
   const guides: ToolGuide[] = []
   for (const t of tooling) {
      if (t.type === "toolset") {
         if (t.tools !== undefined) {
            const patterns = Array.isArray(t.tools) ? t.tools : [t.tools]
            for (const p of patterns) {
               resolveToolsPattern(p, blueprint, guides)
            }
            continue
         }
         // selector.matchLabels path (multi-resource).
         const selector = t.selector as LabelSelector
         for (const res of blueprint.resources) {
            if (res.kind === "Preset") continue
            if (labelSelectorMatches(selector, res.metadata.labels)) {
               guides.push(...res.getTools())
            }
         }
      } else if (t.type === "subagent") {
         guides.push({
            name: `subagent_${t.agent_id}`,
            intent: `Delegate to subagent: ${t.agent_id}`,
            input: z.object({
               task: z.string().describe("The task to delegate to the subagent"),
            }),
         })
      }
   }
   return guides
}


export const PostureSpecSchema = z
   .object({
      extends: z.array(z.string()).optional(),
      instruction: InstructionRefSchema,
      tooling: z.array(ToolingSchema).default([]),
      hooks: HooksSchema.optional(),
      guardrails: GuardrailsSchema.optional(),
   })
   .passthrough()

export type PostureSpec = z.infer<typeof PostureSpecSchema>

export interface PostureStatus {
   mergedFrom: string[]
}

export const PostureManifestSchema = z
   .object({
      apiVersion: z.literal(AGENT_API_VERSION),
      kind: z.literal("Posture"),
      metadata: ObjectMetaSchema,
      spec: PostureSpecSchema,
   })
   .passthrough()

export type PostureManifest = z.infer<typeof PostureManifestSchema>

export interface PostureRuntime {
   template: InstructionTemplate
   tooling: ToolingEntry[]
   onStartHooks: HookEntry[]
   onCompletionHooks: HookEntry[]
   onToolUseHooks: HookEntry[]
   onToolErrorHooks: HookEntry[]
   guardrails: GuardrailDecl[]
}

export class PostureObject implements ResourceObject {
   readonly apiVersion = AGENT_API_VERSION
   readonly kind = "Posture" as const
   readonly metadata: ObjectMeta
   readonly name: string
   readonly spec: PostureSpec
   status: PostureStatus = { mergedFrom: [] }
   private readonly runtime: PostureRuntime
   private readonly blueprint: Blueprint

   constructor(
      metadata: ObjectMeta,
      spec: PostureSpec,
      runtime: PostureRuntime,
      blueprint: Blueprint,
   ) {
      this.metadata = metadata
      this.name = metadata.name
      this.spec = spec
      this.runtime = runtime
      this.blueprint = blueprint
   }

    getTools(): ToolGuide[] {
        // A posture contributes nothing to the global tool surface on its own.
        // Routes and tooling entries are exposed only while the posture is
        // active (see getActiveTooling). Inactive postures are inert.
        return []
    }

   getBehavior(base?: AgentBehavior): AgentBehavior {
      // A posture overlays the agent; it cannot stand alone. It requires a
      // base behavior (produced by an agent object) and throws if none has
      // been established yet. Guardrails from base + posture are unioned
      // (deduplicated by qualified name, base first then posture).
      if (!base) {
         throw new Error(
            `Posture "${this.name}" cannot patch the agent behavior: no base behavior was produced. ` +
               `Declare an "agent" resource before postures in the blueprint.`,
         )
      }
      const combinedGuardrails = dedupGuardrails([
         ...(base.guardrails ?? []),
         ...this.runtime.guardrails,
      ])
      return {
         ...base,
         guardrails: combinedGuardrails,
      }
   }

   getHooks(trigger: HookTrigger): HookEntry[] {
      switch (trigger) {
         case "on_start": return this.runtime.onStartHooks
         case "on_completion": return this.runtime.onCompletionHooks
         case "on_tool_use": return this.runtime.onToolUseHooks
         case "on_tool_error": return this.runtime.onToolErrorHooks
      }
   }

   getGuardrails(): GuardrailDecl[] {
      return this.runtime.guardrails
   }

    getActiveTooling(): ToolGuide[] {
        // The active posture exposes its full declared tool surface: resolved
        // entries (toolset/skill/subagent/builtin) AND local `type: route`
        // entries. Inactive postures contribute nothing (getTools returns []).
        return [
           ...resolveToolingGuides(this.runtime.tooling, this.blueprint),
           ...toolingToToolGuideLocal(this.runtime.tooling),
        ]
    }

    /**
     * Rebuilds this posture with each extended preset (instruction + tooling +
     * hooks) folded into a fresh runtime bundle. Preset tooling is layered
     * before the posture's own; preset instructions are folded into the
     * posture's single template (presets first, own last). Returns a NEW
     * object; the spec stays immutable.
     */
     withExtends(presets: Map<string, PresetView>): PostureObject {
         const extendsNames = this.spec.extends ?? []
         if (extendsNames.length === 0) return this
        const templates: (InstructionTemplate | null)[] = []
        const tooling = [...this.runtime.tooling]
        const onStartHooks = [...this.runtime.onStartHooks]
        const onCompletionHooks = [...this.runtime.onCompletionHooks]
        const onToolUseHooks = [...this.runtime.onToolUseHooks]
        const onToolErrorHooks = [...this.runtime.onToolErrorHooks]
        const guardrails = [...this.runtime.guardrails]
        const mergedFrom: string[] = []
        for (const name of extendsNames) {
           const p = presets.get(name)
           if (!p) {
              throw new Error(`posture "${this.name}" extends unknown preset "${name}"`)
           }
           templates.push(p.getTemplate())
           // Preset tooling goes before the posture's own.
           tooling.unshift(...p.getTooling())
           onStartHooks.push(...p.getHooks("on_start"))
           onCompletionHooks.push(...p.getHooks("on_completion"))
           onToolUseHooks.push(...p.getHooks("on_tool_use"))
           onToolErrorHooks.push(...p.getHooks("on_tool_error"))
           guardrails.push(...p.getGuardrails())
           mergedFrom.push(name)
        }
        const merged = mergeInstructionTemplates([...templates, this.runtime.template])
        const next = new PostureObject(
           this.metadata,
           this.spec,
           {
              template: merged ?? this.runtime.template,
              tooling,
              onStartHooks,
              onCompletionHooks,
              onToolUseHooks,
              onToolErrorHooks,
              guardrails,
           },
           this.blueprint,
        )
        next.status = { mergedFrom }
        return next
     }

   toManifest(): ObjectManifest {
      return {
         apiVersion: this.apiVersion,
         kind: this.kind,
         metadata: this.metadata,
         spec: this.spec,
      }
   }

    static async fromManifest(
       manifest: PostureManifest,
       ctx: ObjectLoadContext,
    ): Promise<PostureObject> {
       const blueprint = ctx.blueprint as Blueprint
       const spec = manifest.spec
       const template = resolveInstructionRef(spec.instruction, blueprint.instructions, {
          defaultName: manifest.metadata.name,
       })
       return new PostureObject(
          manifest.metadata,
          spec,
          {
             template,
             tooling: spec.tooling ?? [],
             onStartHooks: spec.hooks?.on_start ?? [],
             onCompletionHooks: spec.hooks?.on_completion ?? [],
             onToolUseHooks: spec.hooks?.on_tool_use ?? [],
             onToolErrorHooks: spec.hooks?.on_tool_error ?? [],
             guardrails: spec.guardrails ?? [],
          },
          blueprint,
       )
    }


   async applyTool(
      _id: string,
      params: Record<string, any>,
      context: AgentContext,
      _toolUseId?: string,
   ): Promise<ToolOutcome | undefined> {
      // A posture always activates — it is the structural backbone of the
      // agent. Requirement checks only apply to skills (optional attachments).
      const variables = { ...contextVariables(context), ...params }
      const resolved = resolveInstructionTemplate(this.runtime.template, variables)
      context.emit(createPostureUse(this.name, resolved))

      return {
         result: {
            posture: this.name,
            status: "active",
            message: `Posture instruction and tooling loaded`,
         },
      }
   }

   /**
    * Resolves a `type: route` tooling entry by its tool name to the target
    * posture name. Used by `AgentContext.runTool` to dispatch an LLM route
    * call to the target posture's `applyTool`. Returns null when no route
    * with this name is declared on this posture.
    */
   resolveRouteTarget(toolName: string): string | null {
      for (const t of this.runtime.tooling) {
         if (t.type === "route" && t.name === toolName) {
            return t.posture
         }
      }
      return null
   }

   /**
    * Resolves an inline-skill tooling entry (legacy form) by the exposed tool
    * name. Inline skills are declared via `type: toolset, tools: "<ref>/*"`
    * where `<ref>` is not a registered resource but a key into the
    * `InstructionTemplateCollection`. The template's own `name` becomes the
    * tool name exposed to the LLM; this lookup finds the template back from
    * that name so `activateSkill` can run. Returns undefined when no inline
    * skill template matches.
    */
   resolveSkillTemplate(name: string): InstructionTemplate | undefined {
      for (const t of this.runtime.tooling) {
         if (t.type !== "toolset" || t.tools === undefined) continue
         const patterns = Array.isArray(t.tools) ? t.tools : [t.tools]
         for (const p of patterns) {
            const { resourceName } = parseToolsetPattern(p)
            if (!this.blueprint.instructions.has(resourceName)) continue
            const tmpl = this.blueprint.instructions.get(resourceName)
            if (tmpl.name === name) return tmpl
         }
      }
      return undefined
   }

   async activateSkill(
      name: string,
      params: Record<string, any>,
      context: AgentContext,
      _toolUseId?: string,
   ): Promise<ToolOutcome | undefined> {
      const template = this.resolveSkillTemplate(name)
      if (!template) {
         return {
            result: { error: `Skill not found: ${name}` },
            isError: true,
         }
      }

      const { resolved, check } = resolveAndCheck(template, context, params)

      if (!check.ok) {
         return {
            result: {
               skill: name,
               status: "requirements_not_met",
               missingTools: check.missingTools,
               missingVariables: check.missingVariables,
            },
            isError: true,
         }
      }

      context.emit(createSkillAttach(template.name, resolved))

      return {
         result: {
            skill: name,
            status: "activated",
         },
      }
   }
}

/**
 * Local copy of toolingToToolGuide to avoid a circular import with blueprint.ts
 * (the helper there is fine, but posture needs it without forcing the whole
 * blueprint module to load posture's types first).
 */
function toolingToToolGuideLocal(tooling: any[]): ToolGuide[] {
   const guides: ToolGuide[] = []
   for (const t of tooling) {
      if (t.type === "route") {
         const params = t.params
         let input: z.ZodTypeAny = z.object({})
         if (Array.isArray(params)) {
            const shape: Record<string, z.ZodTypeAny> = {}
            for (let i = 0; i < params.length; i++) {
               const p = params[i]
               if (typeof p === "string") {
                  shape[`arg${i}`] = z.string()
               } else if (p && typeof p === "object" && (p as any).name) {
                  shape[(p as any).name] =
                     (p as any).type === "string" ? z.string() : z.any()
               } else if (p && typeof p === "object") {
                  shape[`arg${i}`] = z.any()
               }
            }
            input = z.object(shape)
         }
         guides.push({
            name: t.name,
            intent: t.description ?? `Route to posture ${t.posture}`,
            input,
         })
      }
   }
   return guides
}

scheme.register({
   apiVersion: AGENT_API_VERSION,
   kind: "Posture",
   manifestSchema: PostureManifestSchema,
   factory: PostureObject.fromManifest,
   metadata: {
      role: "État actif avec instruction + tooling + hooks ; activable via une route.",
      surface: "Active uniquement",
      example: `apiVersion: agent/v1
kind: Posture
metadata:
  name: plan_meal
spec:
  extends: [kitchen_base]
  instruction: { $ref: ./instructions/plan-meal.md }
  tooling:
    - type: toolset
      tools: pantry/*`,
      notes: [
         "Inactive, une posture ne contribue rien à la surface LLM.",
         "Les transitions inter-postures passent par une entrée `type: route` explicite.",
      ],
      fieldDocs: {
         "spec.extends": "Presets fusionnés au load (mécanique kind-spécifique).",
         "spec.instruction": "Instruction (`{ $ref }`, `{ content }`, ou chemin de fichier).",
         "spec.tooling": "Surface d'outils — entries `toolset` / `route` / `subagent`.",
         "spec.hooks": "Automations par trigger (`on_start` / `on_completion` / `on_tool_use` / `on_tool_error`).",
         "spec.guardrails": "Assertions appliquées sur les tool calls.",
      },
   },
})

/**
 * Deduplicate guardrail declarations by local `name`. The owner prefix is
 * applied later by the context (a posture may merge guardrails from multiple
 * owners: its own, the agent base, presets); only the local name matters for
 * dedup at this level — the same local name on the same owner is a duplicate.
 * First occurrence wins.
 */
export function dedupGuardrails(decls: GuardrailDecl[]): GuardrailDecl[] {
   const seen = new Set<string>()
   const out: GuardrailDecl[] = []
   for (const d of decls) {
      if (seen.has(d.name)) continue
      seen.add(d.name)
      out.push(d)
   }
   return out
}
