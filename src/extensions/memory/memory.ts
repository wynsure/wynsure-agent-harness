import { z } from "zod"
import {
   type ResourceObject,
   type ToolGuide,
   type ToolName,
   type GuardrailDecl,
   type HookEntry,
   type HookTrigger,
} from "../../blueprint/blueprint.ts"
import {
   type ObjectManifest,
   type ObjectMeta,
   type ObjectLoadContext,
   scheme,
   ObjectMetaSchema,
} from "../../blueprint/object-meta.ts"
import type { AgentContext } from "../../runtime/context.ts"
import type { ActivityId } from "../../state/activity.ts"
import { AGENT_API_VERSION } from "../../blueprint/api-version.ts"

/**
 * `Memory` — resource exposing the per-context memorization tooling. The
 * resource is stateless (Pattern A): every value lives in the context's
 * `state` leaf, keyed by `kind = metadata.name`. Two contexts of the same
 * agent therefore hold independent stores, and two distinct Memory resources
 * no longer share one bag. See docs/state-tree.spec.md, docs/resources.spec.md
 * § "memory".
 *
 * v1 exposes only `<name>__set` and `<name>__get`. Other operations
 * (delete / has / keys) can be added later without breaking the manifest.
 */
export const MemorySpecSchema = z.object({}).passthrough()

export type MemorySpec = z.infer<typeof MemorySpecSchema>

export const MemoryManifestSchema = z
   .object({
      apiVersion: z.literal(AGENT_API_VERSION),
      kind: z.literal("Memory"),
      metadata: ObjectMetaSchema,
      spec: MemorySpecSchema,
   })
   .passthrough()

export type MemoryManifest = z.infer<typeof MemoryManifestSchema>

export class MemoryObject implements ResourceObject {
   readonly apiVersion = AGENT_API_VERSION
   readonly kind = "Memory" as const
   readonly metadata: ObjectMeta
   readonly name: string
   readonly spec: MemorySpec

   constructor(metadata: ObjectMeta, spec: MemorySpec) {
      this.metadata = metadata
      this.name = metadata.name
      this.spec = spec
   }

    /**
     * Two tools prefixed with the resource name (same convention as McpStdio):
     * `<name>__set` writes a key and `<name>__get` reads it back. State is
     * stored in the context's `state` leaf as `{ kind: name, payload: <dict> }`.
     */
    getTools(): ToolGuide[] {
      return [
         {
            name: `${this.name}__set`,
             intent: `Store a value in the "${this.name}" memory under a string key. This memory is local to the current context and is lost when the session ends.`,
            input: z.object({
               key: z.string().describe("Memory key"),
               value: z.any().describe("Arbitrary JSON value to store"),
            }),
         },
         {
            name: `${this.name}__get`,
             intent: `Read a value from the "${this.name}" memory by key. Returns null if the key is unset. The memory is local to the current context.`,
            input: z.object({
               key: z.string().describe("Memory key"),
            }),
         },
      ]
   }

   getHooks(_trigger: HookTrigger): HookEntry[] {
      return []
   }

   getGuardrails(): GuardrailDecl[] {
      return []
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
      manifest: MemoryManifest,
      _ctx: ObjectLoadContext,
   ): Promise<MemoryObject> {
      return new MemoryObject(manifest.metadata, manifest.spec)
   }

    async applyTool(
       toolName: ToolName,
       params: Record<string, any>,
       context: AgentContext,
       deliveryId?: ActivityId,
    ): Promise<string | undefined> {
       const action = toolName.startsWith(`${this.name}__`)
          ? toolName.slice(this.name.length + 2)
          : toolName

        if (action === "set") {
           const key = params?.key
           const value = params?.value
           if (typeof key !== "string") {
              context.deliver(deliveryId, { error: "memory.set requires a string `key`" }, true)
              return undefined
           }
           const bag = this.readBag(context)
           bag[key] = value
           context.setState(this, { kind: this.name, payload: bag })
           context.deliver(deliveryId, { ok: true })
           return undefined
        }

        if (action === "get") {
           const key = params?.key
           if (typeof key !== "string") {
              context.deliver(deliveryId, { error: "memory.get requires a string `key`" }, true)
              return undefined
           }
           const value = this.readBag(context)[key] ?? null
           context.deliver(deliveryId, { value })
           return undefined
        }

        context.deliver(deliveryId, { error: `Unknown memory tool: ${toolName}` }, true)
        return undefined
    }

    /** Read this resource's state dict from the context state leaf. */
    private readBag(context: AgentContext): Record<string, unknown> {
       const payload = context.getState(this)?.payload
       return (payload && typeof payload === "object" ? { ...((payload as Record<string, unknown>)) } : {})
    }
}

scheme.register({
   apiVersion: AGENT_API_VERSION,
   kind: "Memory",
   manifestSchema: MemoryManifestSchema,
   factory: MemoryObject.fromManifest,
   metadata: {
      role: "Tooling de mÃ©morisation volatile par AgentContext.",
      surface: "Permanent (sÃ©lectionnÃ© via `tools`)",
      example: `apiVersion: agent/v1
kind: Memory
metadata:
  name: pantry
spec: {}`,
      notes: [
         "Le `spec` est vide en v1 â€” l'Ã©tat dÃ©coule des appels au runtime.",
         "Tools publiÃ©s : `<name>__set` et `<name>__get`.",
         "Inerte pour la surface LLM tant qu'aucune entrÃ©e `toolset` ne le sÃ©lectionne.",
      ],
   },
})
