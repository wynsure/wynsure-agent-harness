import { z } from "zod"
import type {
   PresetView,
   ResourceObject,
} from "../resource.ts"
import type {
   ToolGuide,
   ToolName,
} from "../tool.ts"
import type { AgentContext } from "../context.ts"
import type { AgentSession } from "../session.ts"
import {
   type InstructionTemplate,
   resolveInstructionTemplate,
   checkInstructionTemplate,
   resolveInstructionRef,
   mergeInstructionTemplates,
} from "../../blueprint/instruction.ts"
import {
   type ObjectManifest,
   type ObjectMeta,
   ObjectMetaSchema,
} from "../../blueprint/object-meta.ts"
import {
   type ObjectLoadContext,
   scheme,
} from "../scheme.ts"
import {
   GuardrailsSchema,
   HooksSchema,
   InstructionRefSchema,
   ToolingSchema,
} from "../../blueprint/blueprint-schema.ts"
import type {
   GuardrailDecl,
   HookEntry,
   HookTrigger,
   ToolingEntry,
} from "../../blueprint/blueprint-schema.ts"
import type { ActivityId } from "../../state/activity.ts"
import { createSkillAttach } from "../../state/fragment.ts"
import { resolveToolingGuides, dedupGuardrails } from "./tooling.ts"
import { AGENT_API_VERSION } from "../../blueprint/api-version.ts"

function contextVariables(context: AgentContext): Record<string, unknown> {
   return {
      cwd: context.session.blueprint.instructions.cwd,
      sessionId: context.session.sessionId,
      agentName: context.session.agentName,
      currentPosture: context.currentPosture ?? "",
   }
}

/**
 * A first-class activatable bundle of {instruction, tooling, hooks}, shaped like
 * a posture but dedicated to being linked from an agent/posture tooling list and
 * toggled at runtime. Linking uses the existing `type: skill, ref: <name>`
 * tooling entry: when a skill object exists under that name it is exposed as
 * an activatable tool; otherwise the entry falls back to a plain instruction
 * template (legacy inline skill).
 *
 * Activation (bundle complet): emits SkillAttach with the resolved instruction,
 * and — while the skill stays attached — its tooling joins the context's
 * available tools and its on_completion hooks fire at end of turn. See
 * docs/resources.md.
 */
export const SkillSpecSchema = z
   .object({
      extends: z.array(z.string()).optional(),
      description: z.string().optional(),
      instruction: InstructionRefSchema.optional(),
      tooling: z.array(ToolingSchema).default([]),
      hooks: HooksSchema.optional(),
      guardrails: GuardrailsSchema.optional(),
   })
   .passthrough()

export type SkillSpec = z.infer<typeof SkillSpecSchema>

export interface SkillStatus {
   mergedFrom: string[]
}

export const SkillManifestSchema = z
   .object({
      apiVersion: z.literal(AGENT_API_VERSION),
      kind: z.literal("Skill"),
      metadata: ObjectMetaSchema,
      spec: SkillSpecSchema,
   })
   .passthrough()

export type SkillManifest = z.infer<typeof SkillManifestSchema>

export interface SkillRuntime {
   template: InstructionTemplate | null
   tooling: ToolingEntry[]
   onStartHooks: HookEntry[]
   onCompletionHooks: HookEntry[]
   onToolUseHooks: HookEntry[]
   onToolErrorHooks: HookEntry[]
   guardrails: GuardrailDecl[]
}

export class SkillObject implements ResourceObject {
   readonly apiVersion = AGENT_API_VERSION
   readonly kind = "Skill" as const
   readonly metadata: ObjectMeta
   readonly name: string
   readonly spec: SkillSpec
   status: SkillStatus = { mergedFrom: [] }
   private readonly runtime: SkillRuntime
   private readonly session: AgentSession

   constructor(
      metadata: ObjectMeta,
      spec: SkillSpec,
      runtime: SkillRuntime,
      session: AgentSession,
   ) {
      this.metadata = metadata
      this.name = metadata.name
      this.spec = spec
      this.runtime = runtime
      this.session = session
   }

   /** Skill description (intent exposed when linked via a tooling entry). */
   get description(): string | undefined {
      return this.spec.description
   }

   /**
    * A skill never contributes tools to the static surface on its own — it is
    * only callable once linked via a `type: skill` tooling entry, which the
    * active posture resolves through resolveToolingGuides.
    */
   getTools(): ToolGuide[] {
      return []
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

   /** Tooling live while the skill is attached (see AgentContext.collectTools). */
   getActiveTooling(): ToolGuide[] {
      return resolveToolingGuides(this.runtime.tooling, this.session)
   }

   withExtends(presets: Map<string, PresetView>): SkillObject {
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
            throw new Error(`skill "${this.name}" extends unknown preset "${name}"`)
         }
         templates.push(p.getTemplate())
         tooling.unshift(...p.getTooling())
         onStartHooks.push(...p.getHooks("on_start"))
         onCompletionHooks.push(...p.getHooks("on_completion"))
         onToolUseHooks.push(...p.getHooks("on_tool_use"))
         onToolErrorHooks.push(...p.getHooks("on_tool_error"))
         guardrails.push(...p.getGuardrails())
         mergedFrom.push(name)
      }
      const merged = mergeInstructionTemplates([...templates, this.runtime.template])
      const next = new SkillObject(
         this.metadata,
         this.spec,
         {
            template: merged ?? this.runtime.template,
            tooling,
            onStartHooks,
            onCompletionHooks,
            onToolUseHooks,
            onToolErrorHooks,
            guardrails: dedupGuardrails(guardrails),
         },
         this.session,
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
      manifest: SkillManifest,
      ctx: ObjectLoadContext,
   ): Promise<SkillObject> {
      const spec = manifest.spec
      const template: InstructionTemplate | null = spec.instruction
         ? resolveInstructionRef(
              spec.instruction,
              ctx.session.blueprint.instructions,
              { defaultName: manifest.metadata.name },
           )
         : null
      return new SkillObject(
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
         ctx.session,
      )
   }

   /**
    * Activation path (bundle complet): resolve + requirement-check the
    * instruction, then emit SkillAttach so the thread records the attachment.
    * The result is delivered to the invocation's delivery; the context takes
    * care of exposing the skill's tooling/hooks while it stays attached.
    */
   async activate(
      name: ToolName,
      params: Record<string, any>,
      context: AgentContext,
      deliveryId?: ActivityId,
   ): Promise<string | undefined> {
      if (!this.runtime.template) {
         context.deliver(deliveryId, { error: `Skill has no instruction to attach: ${name}` }, true)
         return undefined
      }
      const variables = { ...contextVariables(context), ...params }
      const resolved = resolveInstructionTemplate(this.runtime.template, variables)
      const check = checkInstructionTemplate(this.runtime.template, {
         availableTools: context.availableToolNames(),
         variables: Object.keys(variables),
      })
      if (!check.ok) {
         context.deliver(deliveryId, {
            skill: name,
            status: "requirements_not_met",
            missingTools: check.missingTools,
            missingVariables: check.missingVariables,
         }, true)
         return undefined
      }
      context.emit(createSkillAttach(this.runtime.template.name, resolved))
      context.deliver(deliveryId, {
         skill: name,
         status: "activated",
      })
      return undefined
   }

   async applyTool(
      toolName: ToolName,
      params: Record<string, any>,
      context: AgentContext,
      deliveryId?: ActivityId,
   ): Promise<string | undefined> {
      return this.activate(toolName, params, context, deliveryId)
   }
}

scheme.register({
   apiVersion: AGENT_API_VERSION,
   kind: "Skill",
   manifestSchema: SkillManifestSchema,
   factory: SkillObject.fromManifest,
   metadata: {
      role: "Bundle toggable (instruction + tooling + hooks) attaché au runtime.",
      surface: "Attachée uniquement",
      example: `apiVersion: agent/v1
kind: Skill
metadata:
  name: substitutions
spec:
  description: Suggest ingredient substitutions for dietary needs.
  instruction: { $ref: ./instructions/substitutions.md }
  tooling:
    - type: toolset
      tools: pantry/*`,
      notes: [
         "Activation via une entrée `toolset tools: <name>/*` dans une posture ou skill.",
         "Désactivation automatique au changement de posture ou à la fermeture du context.",
      ],
      fieldDocs: {
         "spec.extends": "Presets fusionnés à la création de session (mécanique kind-spécifique).",
         "spec.description": "Description humaine (intent exposé au LLM pour les skills).",
         "spec.instruction": "Instruction (`{ $ref }`, `{ content }`, ou chemin de fichier).",
         "spec.tooling": "Surface d'outils — entries `toolset` / `route` / `subagent`.",
         "spec.hooks": "Automations par trigger (`on_start` / `on_completion` / `on_tool_use` / `on_tool_error`).",
         "spec.guardrails": "Assertions appliquées sur les tool calls.",
      },
   },
})
