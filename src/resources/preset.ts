import { z } from "zod"
import {
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
   type ObjectManifest,
   type ObjectMeta,
   type ObjectLoadContext,
   scheme,
   ObjectMetaSchema,
} from "../object-meta.ts"
import {
   GuardrailsSchema,
   HooksSchema,
   InstructionRefSchema,
   ToolingSchema,
} from "../blueprint-schema.ts"
import {
   type InstructionTemplate,
   resolveInstructionRef,
} from "../instruction.ts"
import type { AgentContext } from "../context.ts"
import { AGENT_API_VERSION } from "./agent.ts"

/**
 * A reusable bundle of {instruction, tooling, hooks, guardrails} consumed at
 * load time by other objects (agent/posture/skill) via `spec.extends`. A preset
 * has NO runtime footprint of its own — it never exposes tools, never
 * activates, and never emits fragments. It only mutualizes configuration. See
 * docs/resources.spec.md.
 */
export const PresetSpecSchema = z
   .object({
      instruction: InstructionRefSchema.optional(),
      tooling: z.array(ToolingSchema).default([]),
      hooks: HooksSchema.optional(),
      guardrails: GuardrailsSchema.optional(),
   })
   .passthrough()

export type PresetSpec = z.infer<typeof PresetSpecSchema>

export const PresetManifestSchema = z
   .object({
      apiVersion: z.literal(AGENT_API_VERSION),
      kind: z.literal("Preset"),
      metadata: ObjectMetaSchema,
      spec: PresetSpecSchema,
   })
   .passthrough()

export type PresetManifest = z.infer<typeof PresetManifestSchema>

export interface PresetRuntime {
   template: InstructionTemplate | null
   tooling: ToolingEntry[]
   onStartHooks: HookEntry[]
   onCompletionHooks: HookEntry[]
   onToolUseHooks: HookEntry[]
   onToolErrorHooks: HookEntry[]
   guardrails: GuardrailDecl[]
}

export class PresetObject implements ResourceObject, PresetView {
   readonly apiVersion = AGENT_API_VERSION
   readonly kind = "Preset" as const
   readonly metadata: ObjectMeta
   readonly name: string
   readonly spec: PresetSpec
   private readonly runtime: PresetRuntime

   constructor(metadata: ObjectMeta, spec: PresetSpec, runtime: PresetRuntime) {
      this.metadata = metadata
      this.name = metadata.name
      this.spec = spec
      this.runtime = runtime
   }

   /** A preset never contributes its own tools to a context's tool surface. */
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

    getTemplate(): InstructionTemplate | null {
       return this.runtime.template
    }

    getTooling(): ToolingEntry[] {
       return this.runtime.tooling
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
       manifest: PresetManifest,
       ctx: ObjectLoadContext,
    ): Promise<PresetObject> {
       const blueprint = ctx.blueprint as Blueprint
       const spec = manifest.spec
       const template: InstructionTemplate | null = spec.instruction
          ? resolveInstructionRef(spec.instruction, blueprint.instructions, {
               defaultName: manifest.metadata.name,
            })
          : null
       return new PresetObject(manifest.metadata, spec, {
          template,
          tooling: spec.tooling ?? [],
          onStartHooks: spec.hooks?.on_start ?? [],
          onCompletionHooks: spec.hooks?.on_completion ?? [],
          onToolUseHooks: spec.hooks?.on_tool_use ?? [],
          onToolErrorHooks: spec.hooks?.on_tool_error ?? [],
          guardrails: spec.guardrails ?? [],
       })
    }

   async applyTool(): Promise<ToolOutcome | undefined> {
      return undefined
   }
}

scheme.register({
   apiVersion: AGENT_API_VERSION,
   kind: "Preset",
   manifestSchema: PresetManifestSchema,
   factory: PresetObject.fromManifest,
   metadata: {
      role: "Conteneur de mutualisation ; inert tant qu'il n'est pas étendu via `extends`.",
      surface: "Aucune (inert hors `extends`)",
      example: `apiVersion: agent/v1
kind: Preset
metadata:
  name: kitchen_base
spec:
  instruction: { content: "Be warm, concise and practical." }
  hooks:
    on_completion:
      - type: tooluse
        tool: interact__message`,
      notes: [
         "Un `Preset` n'accepte pas `extends` (réservé v1).",
         "Aucune surface runtime tant qu'il n'est pas étendu via `extends`.",
      ],
      fieldDocs: {
         "spec.instruction": "Instruction (`{ $ref }`, `{ content }`, ou chemin de fichier).",
         "spec.tooling": "Surface d'outils — entries `toolset` / `route` / `subagent`.",
         "spec.hooks": "Automations par trigger (`on_start` / `on_completion` / `on_tool_use` / `on_tool_error`).",
         "spec.guardrails": "Assertions appliquées sur les tool calls.",
      },
   },
})
