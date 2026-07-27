import { z } from "zod"
import {
   type AgentBehavior,
   type PresetView,
   type ResourceObject,
   type ToolGuide,
   type ToolName,
   type ToolingEntry,
   type GuardrailDecl,
   type HookEntry,
   type HookTrigger,
   Blueprint,
} from "../blueprint.ts"
import type { ActivityId } from "../../state/activity.ts"
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
import type { AgentContext } from "../../runtime/context.ts"
import {
   resolveToolingGuides,
} from "./posture.ts"
import {
   toolingToToolGuide,
} from "../blueprint.ts"
import { AGENT_API_VERSION } from "../api-version.ts"

// Re-exported for back-compat: callers historically import the apiVersion
// constant from this module. The canonical definition lives in
// `src/api-version.ts` to avoid import cycles.
export { AGENT_API_VERSION } from "../api-version.ts"

/**
 * AgentSpec — the declarative payload of an agent. Excludes identity (in
 * `metadata`) but owns its own `extends` list: each consumer kind implements
 * its own `withExtends` merge, so the overlay declaration lives in `spec`
 * alongside the kind-specific fields. The instruction is kept as the raw
 * InstructionRef so the manifest round-trips losslessly; resolution to an
 * InstructionTemplate happens once at load.
 *
 * `tooling` is the agent's permanent tool surface (live for the whole context
 * regardless of posture). It accepts the same entries as a posture / skill /
 * preset (`toolset`, `route`, `subagent`); `route` entries exposed here are
 * always reachable, even from no posture (entry/back-to-root navigation).
 */
export const AgentSpecSchema = z
   .object({
      extends: z.array(z.string()).optional(),
      description: z.string().optional(),
   /**
    * Name of the `model` resource that provides this agent's completion
    * service. Required: an agent without a model cannot reason.
    */
   model: z.string().min(1),
      initial_posture: z.string().optional(),
      instruction: InstructionRefSchema,
      tooling: z.array(ToolingSchema).default([]),
      max_tool_rounds: z.number().int().positive().optional(),
      hooks: HooksSchema.optional(),
      guardrails: GuardrailsSchema.optional(),
   })
   .passthrough()

export type AgentSpec = z.infer<typeof AgentSpecSchema>

/**
 * AgentStatus — observed state, populated by the system (never by the user).
 * `mergedFrom` records which presets were folded into this agent during the
 * `extends` pass, for auditability.
 */
export interface AgentStatus {
   mergedFrom: string[]
}

export const AgentManifestSchema = z
   .object({
      apiVersion: z.literal(AGENT_API_VERSION),
      kind: z.literal("Agent"),
      metadata: ObjectMetaSchema,
      spec: AgentSpecSchema,
   })
   .passthrough()

export type AgentManifest = z.infer<typeof AgentManifestSchema>

/** Runtime-resolved artifacts derived from the spec at load time. */
export interface AgentRuntime {
   persona: InstructionTemplate
   guidelines: InstructionTemplate[]
    /**
     * Permanent tooling effective for the whole life of the context, regardless
     * of the active posture. Composed of the agent's `spec.tooling` followed by
     * the tooling contributed by `extends` presets (presets prepended at load
     * time). Supports `toolset`, `route`, and `subagent` entries.
     */
    tooling: ToolingEntry[]
   onStartHooks: HookEntry[]
   onCompletionHooks: HookEntry[]
   onToolUseHooks: HookEntry[]
   onToolErrorHooks: HookEntry[]
   /** Inline guardrail declarations contributed by this agent + its presets. */
   guardrails: GuardrailDecl[]
}

export class AgentObject implements ResourceObject {
   readonly apiVersion = AGENT_API_VERSION
   readonly kind = "Agent" as const
   readonly metadata: ObjectMeta
   readonly name: string
   readonly spec: AgentSpec
   status: AgentStatus = { mergedFrom: []}
   private readonly runtime: AgentRuntime
   private readonly blueprint: Blueprint

   constructor(
      metadata: ObjectMeta,
      spec: AgentSpec,
      runtime: AgentRuntime,
      blueprint?: Blueprint,
   ) {
      this.metadata = metadata
      this.name = metadata.name
      this.spec = spec
      this.runtime = runtime
      this.blueprint = blueprint ?? ({} as Blueprint)
   }

    /**
     * Permanent tool surface, contributed by the agent's own `spec.tooling`
     * plus the presets it `extends`. Live for the whole context regardless of
     * posture. Returns guides resolved against the blueprint (toolset/skill/
     * subagent/builtin) AND local `type: route` entries — the latter are
     * always reachable, even from no posture (entry / back-to-root).
     */
    getTools(): ToolGuide[] {
       if (!this.blueprint?.resources) return []
       return [
          ...resolveToolingGuides(this.runtime.tooling, this.blueprint),
          ...toolingToToolGuide(this.runtime.tooling),
       ]
    }

    /**
     * Resolves a `type: route` tooling entry declared on this agent by its
     * tool name to the target posture name. Used by `AgentContext.runTool`
     * as a permanent fallback (the active posture's routes are consulted
     * first). Returns null when no route with this name is declared here.
     */
    resolveRouteTarget(toolName: string): string | null {
       for (const t of this.runtime.tooling) {
          if (t.type === "route" && t.name === toolName) {
             return t.posture
          }
       }
       return null
    }

    getBehavior(): AgentBehavior {
       const behavior: AgentBehavior = {
          persona: this.runtime.persona,
          guidelines: this.runtime.guidelines,
          maxToolRounds: this.spec.max_tool_rounds,
          posture: this.spec.initial_posture,
          guardrails: this.runtime.guardrails,
       }
       return behavior
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

    /**
     * Rebuilds this agent with its declared presets merged in: their
     * instructions become additional guidelines (emitted alongside the persona
     * at init), their tooling becomes the agent's permanent tool surface, and
     * their hooks join the agent's hook lists. Returns a NEW object; the spec
     * stays immutable.
     */
     withExtends(presets: Map<string, PresetView>): AgentObject {
         const extendsNames = this.spec.extends ?? []
         if (extendsNames.length === 0) return this
       const guidelines = [...this.runtime.guidelines]
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
             throw new Error(`agent "${this.name}" extends unknown preset "${name}"`)
          }
          const t = p.getTemplate()
          if (t) guidelines.push(t)
          // Preset tooling is prepended to the agent's own (which now reads
          // from `spec.tooling`), so the agent's own entries override by
          // ordering last if a dedup pass is added later.
          tooling.unshift(...p.getTooling())
          onStartHooks.push(...p.getHooks("on_start"))
          onCompletionHooks.push(...p.getHooks("on_completion"))
          onToolUseHooks.push(...p.getHooks("on_tool_use"))
          onToolErrorHooks.push(...p.getHooks("on_tool_error"))
          guardrails.push(...p.getGuardrails())
          mergedFrom.push(name)
       }
       const next = new AgentObject(this.metadata, this.spec, {
          persona: this.runtime.persona,
          guidelines,
          tooling,
          onStartHooks,
          onCompletionHooks,
          onToolUseHooks,
          onToolErrorHooks,
          guardrails,
       }, this.blueprint)
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
       manifest: AgentManifest,
       ctx: ObjectLoadContext,
    ): Promise<AgentObject> {
       const blueprint = ctx.blueprint as Blueprint
       const spec = manifest.spec
       const persona = resolveInstructionRef(spec.instruction, blueprint.instructions, {
          defaultName: manifest.metadata.name,
       })
       return new AgentObject(
          manifest.metadata,
          spec,
          {
             persona,
             guidelines: [],
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
      _toolName: ToolName,
      _params: Record<string, any>,
      _context: AgentContext,
      _deliveryId?: ActivityId,
   ): Promise<string | undefined> {
      return undefined
   }
}

scheme.register({
   apiVersion: AGENT_API_VERSION,
   kind: "Agent",
   manifestSchema: AgentManifestSchema,
   factory: AgentObject.fromManifest,
   metadata: {
      role: "Persona + behavior racine ; délègue à des postures.",
      surface: "Permanent (`spec.tooling` + presets étendus)",
       example: `apiVersion: agent/v1
kind: Agent
metadata:
  name: pantri_chef
  labels: { app: cooking }
spec:
  model: model-default
  initial_posture: greet
  instruction: { $ref: ./instructions/pantri.persona.md }
  tooling:
    - type: toolset
      tools: user/*            # une ressource InteractSurface déclarée dans le blueprint
    - type: route
      name: greet
      posture: greet`,
       notes: [
          "Le tooling permanent de l'agent vit toute la durée du context.",
          "Les surfaces d'interaction (interact__*) sont publiées par une ressource `InteractSurface` déclarée dans le blueprint et sélectionnées via `tools: \"<name>/*\"`.",
       ],
      fieldDocs: {
         "spec.extends": "Presets fusionnés au load (mécanique kind-spécifique).",
         "spec.description": "Description humaine (intent exposé au LLM pour les skills).",
         "spec.model": "Nom de la ressource de modèle fournissant le `ThreadCompletionService`.",
         "spec.initial_posture": "Posture active à l'init de l'AgentContext.",
         "spec.instruction": "Instruction (`{ $ref }`, `{ content }`, ou chemin de fichier).",
         "spec.tooling": "Surface d'outils — entries `toolset` / `route` / `subagent`.",
         "spec.hooks": "Automations par trigger (`on_start` / `on_completion` / `on_tool_use` / `on_tool_error`).",
         "spec.guardrails": "Assertions appliquées sur les tool calls.",
         "spec.max_tool_rounds": "Limite de tours outil/complétion.",
      },
   },
})
