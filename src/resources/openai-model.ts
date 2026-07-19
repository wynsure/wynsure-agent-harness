import { z } from "zod"
import { type ObjectLoadContext, scheme, ObjectMetaSchema } from "../object-meta.ts"
import { type IThreadCompletionService } from "../thread.ts"
import {
   OpenAIThreadCompletionService,
   type SkillPlacement,
} from "../providers/openai.ts"
import { AGENT_API_VERSION } from "../api-version.ts"
import { BaseModelObject, env } from "./model-base.ts"

/**
 * OpenAIModelSpec — the declarative payload of an OpenAI-backed model resource.
 * Unset provider fields default to the `OPENAI_*` environment variables at
 * resolution time, so an identical manifest works across environments without
 * any host-side wiring. `apiKey` defaults to `OPENAI_API_KEY` via the provider.
 */
export const OpenAIModelSpecSchema = z
   .object({
      description: z.string().optional(),
      model: z.string().optional(),
      baseURL: z.string().optional(),
      apiKey: z.string().optional(),
      skillPlacement: z.enum(["system", "user"]).optional(),
   })
   .passthrough()

export type OpenAIModelSpec = z.infer<typeof OpenAIModelSpecSchema>

export const OpenAIModelManifestSchema = z
   .object({
      apiVersion: z.literal(AGENT_API_VERSION),
      kind: z.literal("OpenAIModel"),
      metadata: ObjectMetaSchema,
      spec: OpenAIModelSpecSchema,
   })
   .passthrough()

export type OpenAIModelManifest = z.infer<typeof OpenAIModelManifestSchema>

/**
 * OpenAIModel resource — provides a thread completion service backed by the
 * OpenAI Chat Completions API. Inline credentials (spec or `OPENAI_*`); for
 * managed-identity auth use `AzureFoundryModel` instead. Inert for the tool
 * surface. See docs/resources.spec.md § "Modèles".
 */
export class OpenAIModelObject extends BaseModelObject<OpenAIModelSpec> {
   readonly apiVersion = AGENT_API_VERSION
   readonly kind = "OpenAIModel" as const

   protected buildCompletion(): IThreadCompletionService {
      const skillPlacement = this.spec.skillPlacement
      return new OpenAIThreadCompletionService({
         model: this.spec.model ?? env("OPENAI_MODEL"),
         baseURL: this.spec.baseURL ?? env("OPENAI_BASE_URL"),
         apiKey: this.spec.apiKey,
         ...(skillPlacement ? { skillPlacement: skillPlacement as SkillPlacement } : {}),
      })
   }

   static fromManifest(
      manifest: OpenAIModelManifest,
      _ctx: ObjectLoadContext,
   ): OpenAIModelObject {
      return new OpenAIModelObject(manifest.metadata, manifest.spec)
   }
}

scheme.register({
   apiVersion: AGENT_API_VERSION,
   kind: "OpenAIModel",
   manifestSchema: OpenAIModelManifestSchema,
   factory: OpenAIModelObject.fromManifest,
   metadata: {
      role: "Service de complétion OpenAI (clé inline ou `OPENAI_*`).",
      surface: "Aucune (service pur)",
      example: `apiVersion: agent/v1
kind: OpenAIModel
metadata: { name: model-default }
spec:
  model: gpt-4o-mini`,
      notes: ["Auth via `OPENAI_API_KEY` (env) ou `spec.apiKey`."],
      fieldDocs: {
         "spec.description": "Description humaine (intent exposé au LLM pour les skills).",
         "spec.model": "Nom du modèle OpenAI (défaut `OPENAI_MODEL`).",
         "spec.baseURL": "URL de base (défaut `OPENAI_BASE_URL`).",
         "spec.apiKey": "Clé API (défaut `OPENAI_API_KEY`).",
         "spec.skillPlacement": "Placement des fragments SkillAttach (`system` ou `user`).",
      },
   },
})
