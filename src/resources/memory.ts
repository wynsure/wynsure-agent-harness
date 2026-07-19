import { z } from "zod"
import {
   type ResourceObject,
   type ToolGuide,
   type ToolOutcome,
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
import type { AgentContext } from "../context.ts"
import { AGENT_API_VERSION } from "./agent.ts"

/**
 * `Memory` — resource exposing the per-context memorization tooling. The
 * resource itself is stateless: every operation is dispatched against the
 * `MemoryStore` owned by the caller's `AgentContext` (so two contexts of the
 * same agent have independent stores). See docs/resources.spec.md § "memory".
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
    * `<name>__set` writes a key and `<name>__get` reads it back. The state
    * lives on the `AgentContext.memory` store.
    */
   getTools(): ToolGuide[] {
      return [
         {
            name: `${this.name}__set`,
            intent: `Write a value to the "${this.name}" memory under a string key.`,
            input: z.object({
               key: z.string().describe("Memory key"),
               value: z.any().describe("Arbitrary JSON value to store"),
            }),
         },
         {
            name: `${this.name}__get`,
            intent: `Read a value from the "${this.name}" memory by key.`,
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
      id: string,
      params: Record<string, any>,
      context: AgentContext,
      _toolUseId?: string,
   ): Promise<ToolOutcome | undefined> {
      const action = id.startsWith(`${this.name}__`)
         ? id.slice(this.name.length + 2)
         : id

      if (action === "set") {
         const key = params?.key
         const value = params?.value
         if (typeof key !== "string") {
            return {
               result: { error: "memory.set requires a string `key`" },
               isError: true,
            }
         }
         // `remember` writes the value into the per-context store.
         context.remember(key, value)
         return { result: { ok: true } }
      }

      if (action === "get") {
         const key = params?.key
         if (typeof key !== "string") {
            return {
               result: { error: "memory.get requires a string `key`" },
               isError: true,
            }
         }
         const value = context.memory.get(key)
         return { result: { value: value ?? null } }
      }

      return {
         result: { error: `Unknown memory tool: ${id}` },
         isError: true,
      }
   }
}

scheme.register({
   apiVersion: AGENT_API_VERSION,
   kind: "Memory",
   manifestSchema: MemoryManifestSchema,
   factory: MemoryObject.fromManifest,
   metadata: {
      role: "Tooling de mémorisation volatile par AgentContext.",
      surface: "Permanent (sélectionné via `tools`)",
      example: `apiVersion: agent/v1
kind: Memory
metadata:
  name: pantry
spec: {}`,
      notes: [
         "Le `spec` est vide en v1 — l'état découle des appels au runtime.",
         "Tools publiés : `<name>__set` et `<name>__get`.",
         "Inerte pour la surface LLM tant qu'aucune entrée `toolset` ne le sélectionne.",
      ],
   },
})
