import { readFileSync } from "fs"
import { dirname, resolve } from "path"
import { parseAllDocuments } from "yaml"
import { type ZodType, type ZodTypeAny, z, toJSONSchema } from "zod"
import type { AgentContext } from "../runtime/context.ts"
import type { StateCell } from "../state/leaf.ts"
import {
   type GuardrailDecl,
   type HookEntry,
   type HookTrigger,
   type ToolingEntry,
} from "./blueprint-schema.ts"

// Re-export the shared schema types so resource modules can import them from a
// single place (blueprint.ts) without reaching into blueprint-schema.ts.
export type {
   GuardrailDecl,
   GuardrailAppliesTo,
   HookEntry,
   HookTrigger,
   ToolingEntry,
} from "./blueprint-schema.ts"
import type { ServiceContract } from "./service.ts"
import {
   type ObjectManifest,
   type ObjectMeta,
   type ObjectLoadContext,
   scheme,
   validateManifest,
} from "./object-meta.ts"
import {
   type InstructionTemplate,
   InstructionTemplateCollection,
} from "./instruction.ts"
import type { ActivityId } from "../state/activity.ts"

export interface ToolGuide<TInput = any, TOutput = any> {
   readonly name: ToolName
   readonly intent?: string
   readonly input?: ZodType<TInput>
   readonly output?: ZodType<TOutput>
}

/** Name of a tool (a `ToolGuide.name`, matched against `ToolUse`/`ToolFeedback`). */
export type ToolName = string

export function defineTool<TInput>(
   name: string,
   intent: string,
   input?: ZodType<TInput>,
): ToolGuide<TInput> {
   return { name, intent, input }
}

const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/

export function validateToolGuideName(name: string): void {
   if (!TOOL_NAME_PATTERN.test(name)) {
      throw new Error(
         `Invalid tool name "${name}": must match pattern ^[a-zA-Z0-9_-]+$. ` +
            `Slashes, spaces, dots and other special characters are not allowed.`,
      )
   }
}

export function validateToolGuides(guides: ToolGuide[]): void {
   for (const g of guides) {
      validateToolGuideName(g.name)
   }
}

export interface AgentBehavior {
   persona?: InstructionTemplate
   guidelines?: InstructionTemplate[]
   skills?: InstructionTemplate[]
   tools?: ToolGuide[]
   maxToolRounds?: number
   /** Posture to auto-activate when an agent instance starts. Agent-only. */
   posture?: string
   /**
    * Guardrail declarations contributed by the agent (base behavior) and the
    * active posture (overlay). Each decl carries its local `name`; the
    * fully-qualified `guardrails:<owner>:<local>` audit name is built by the
    * context that owns the resource.
    */
   guardrails?: GuardrailDecl[]
}

/**
 * Read-only view of a `preset` object used by consumers (agent/posture/skill)
 * to merge its instruction/tooling/hooks at load time. Declared here (not on
 * ResourceObject) so the generic loader stays decoupled from concrete object
 * types and avoids an import cycle. See docs/resources.spec.md.
 */
export interface PresetView {
   readonly kind: "Preset"
   getTemplate(): InstructionTemplate | null
   getTooling(): ToolingEntry[]
   getHooks(trigger: HookTrigger): HookEntry[]
   /** Guardrail declarations the preset mutualises for its consumers. */
   getGuardrails(): GuardrailDecl[]
}

/**
 * ResourceObject — the live contract every loaded resource implements. The
 * manifest is the serializable form (see object-meta.ts); the object is the
 * typed in-memory instance produced by `fromManifest`. `metadata.name` is the
 * stable identifier; `name` is exposed as a shortcut for the many call sites
 * that look up resources by name.
 */
export interface ResourceObject {
   readonly apiVersion: string
   readonly kind: string
   readonly metadata: ObjectMeta
   /** Shortcut for `metadata.name`. */
   readonly name: string
   getTools(): ToolGuide[]
   getHooks(trigger: HookTrigger): HookEntry[]
   /**
    * Resolve a typed capability provided by this resource, or `undefined` when
    * the resource does not provide it. Lets a consumer obtain a service (e.g.
    * the thread completion service) from a resource by contract, without
    * coupling to the concrete kind. See docs/resources.spec.md § "Contrats de
    * service".
    */
    getService?<T>(contract: ServiceContract<T>): T | undefined
    /**
     * Typed discriminator: returns this resource as a `PresetView` when it is a
     * preset, else `undefined`. Used to collect presets without coupling to the
     * concrete class (and without string-kind comparisons). Optional; only
     * Preset implements it.
     */
    asPreset?(): PresetView
   /**
    * Guardrail declarations owned by this resource. Most resources return [];
    * only Agent / Posture / Skill / Preset carry guardrails (and Preset
    * folds them into consumers via `extends`). The resource's `name` is used
    * as the namespace prefix when building the audit identity.
    */
    getGuardrails(): GuardrailDecl[]
    applyTool(
       toolName: ToolName,
       params: Record<string, any>,
       context: AgentContext,
       deliveryId?: ActivityId,
    ): Promise<string | undefined>
   /** Release runtime resources (transports, connections). Optional. */
   close?(): Promise<void> | void
   /**
    * Project persistable instance state into a state cell (Pattern B). A
    * stateless resource whose state already lives in the leaf via
    * `Context.setState` (Pattern A) returns null. The cell's `kind` is set to
    * the resource name by the caller. See docs/state-tree.spec.md.
    */
   captureState?(scope: "session" | "context"): StateCell | null | undefined
   /**
    * Rehydrate persistable state and rebuild transient handles (Pattern B).
    * Called at restore, after the state leaf is in place; the cell (or
    * undefined) is the resource's own. Transient handles (sockets, caches)
    * reconnect/recompute lazily. Pattern A resources may no-op.
    */
   restoreState?(cell: StateCell | undefined, scope: "session" | "context"): Promise<void> | void
   /**
    * Bind this resource to a live session: subscribe to events, acquire
    * per-context leaves, register cleanup. Called once per resource after the
    * root context is constructed (so the session, its tree and its events are
    * ready). Optional; most resources don't need it. The harness core calls
    * no-ops on resources that don't implement it. This is the seam that lets
    * extensions own user-facing projection (e.g. InteractSurface) without the
    * runtime hard-wiring any of it.
    */
   bindToSession?(session: import("../runtime/session.ts").AgentSession): void
   /** Serialize back to the on-disk/wire form. */
   toManifest(): ObjectManifest
}

export class Blueprint {
   resources: ResourceObject[] = []
   instructions: InstructionTemplateCollection = new InstructionTemplateCollection(
      process.cwd(),
   )

   getResource(name: string): ResourceObject | undefined {
      return this.resources.find((r) => r.name === name)
   }

   /**
    * Resolve a typed service contract from the named resource. Throws if the
    * resource is missing or does not provide the contract. The single path for
    * any capability exposed via `ResourceObject.getService` (see
    * docs/resources.spec.md § "Contrats de service").
    */
   getService<T>(name: string, contract: ServiceContract<T>): T {
      const res = this.getResource(name)
      if (!res) {
         throw new Error(`Resource "${name}" not found.`)
      }
      const svc = res.getService?.(contract)
      if (!svc) {
         throw new Error(
            `Resource "${name}" (kind ${res.kind}) does not provide service "${contract.id}".`,
         )
      }
      return svc
   }
}

function toolingParamsToZod(params: unknown): ZodTypeAny {
   if (!params) return z.object({})
   if (Array.isArray(params)) {
      const shape: Record<string, z.ZodTypeAny> = {}
      for (let i = 0; i < params.length; i++) {
         const p = params[i]
         if (typeof p === "string") {
            shape[`arg${i}`] = z.string()
         } else if (p && typeof p === "object" && (p as any).name) {
            shape[(p as any).name] = (p as any).type === "string" ? z.string() : z.any()
         } else if (p && typeof p === "object") {
            shape[`arg${i}`] = z.any()
         }
      }
      return z.object(shape)
   }
   return z.any()
}

export function toolingToToolGuide(tooling: any[]): ToolGuide[] {
   const guides: ToolGuide[] = []
   for (const t of tooling) {
      if (t.type === "route") {
         guides.push({
            name: t.name,
            intent: t.description ?? `Route to posture ${t.posture}`,
            input: toolingParamsToZod(t.params),
         })
      }
   }
   return guides
}

export function toolGuideToJsonSchema(tool: ToolGuide): Record<string, any> {
   if (!tool.input) return { type: "object", properties: {} }
   return toJSONSchema(tool.input as ZodTypeAny) as Record<string, any>
}

export async function loadAgentBlueprintFrom(path: string): Promise<Blueprint> {
   const cwd = dirname(resolve(path))
   const content = readFileSync(path, "utf-8")
   const docs = parseAllDocuments(content)
   const rawDescs = docs.map((d) => d.toJS()).filter((d) => d != null)
   const manifests: ObjectManifest[] = rawDescs.map((raw, i) =>
      validateManifest(raw, i),
   )
   return createBlueprintFrom(manifests, cwd)
}

/**
 * Load and validate every manifest into resource objects, then resolve the
 * `extends` second pass. The harness injects no builtin manifests and owns no
 * reserved namespace: every tool surface and preset must be declared by the
 * blueprint (or by a host that registers kinds into the scheme before load).
 */
export async function createBlueprintFrom(
   manifests: ObjectManifest[],
   cwd: string,
): Promise<Blueprint> {
   // Validate every manifest against its kind-specific schema so structural
   // errors (unknown kind, missing required fields, superRefine cross-field
   // rules like `toolset.tools` vs `selector`) are caught regardless of the
   // entry point. `loadAgentBlueprintFrom` already does this; the call here
   // makes `createBlueprintFrom` safe to invoke with raw JS manifests too
   // (e.g. from tests or future programmatic builders).
   const validated = manifests.map((m, i) => validateManifest(m, i))

   const blueprint = new Blueprint()
   blueprint.instructions = new InstructionTemplateCollection(cwd)

   const ctx: ObjectLoadContext = { cwd, blueprint }

   for (const manifest of validated) {
      const entry = scheme.lookup(manifest.apiVersion, manifest.kind)
      if (!entry) {
         throw new Error(
            `No factory registered for kind "${manifest.apiVersion}/${manifest.kind}"`,
         )
      }
      const obj = await entry.factory(manifest, ctx)
      blueprint.resources.push(obj as ResourceObject)
   }

    resolveExtends(blueprint)

     return blueprint
}

/**
 * Second pass over the loaded objects: now that every preset exists, each
 * agent/posture/skill that declared `spec.extends: [...]` is rebuilt with
 * its presets merged into an immutable spec (instruction + tooling + hooks).
 * Done after loading so presets may be declared in any order relative to their
 * consumers. The merged object replaces the original in the resources list.
 */
function resolveExtends(blueprint: Blueprint): void {
    const presets = new Map<string, PresetView>()
    for (const r of blueprint.resources) {
       const preset = r.asPreset?.()
       if (preset) presets.set(r.name, preset)
    }
   for (let i = 0; i < blueprint.resources.length; i++) {
      const r = blueprint.resources[i]
      const withExtends = r as ResourceObject & {
         withExtends?(p: Map<string, PresetView>): ResourceObject
      }
      if (typeof withExtends.withExtends === "function") {
         blueprint.resources[i] = withExtends.withExtends(presets)
      }
   }
}
