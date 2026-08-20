import { z } from "zod"
import { ObjectMetaSchema } from "../../blueprint/object-meta.ts"
import { type ObjectLoadContext, scheme } from "../../runtime/scheme.ts"
import { type IThreadCompletionService } from "../../runtime/thread.ts"
import { BaseModelObject, env, OpenAIThreadCompletionService } from "./model-base.ts"
import { AGENT_API_VERSION } from "../../blueprint/api-version.ts"

/**
 * OllamaModelSpec — the declarative payload of an Ollama-served model resource.
 * Ollama is local-first: no auth by default. A bearer token may be set for a
 * remote/gateway deployment. `baseURL` defaults to the local daemon and the
 * `OLLAMA_*` env vars.
 */
export const OllamaModelSpecSchema = z
   .object({
      description: z.string().optional(),
      model: z.string(),
      baseURL: z.string().optional(),
      apiKey: z.string().optional(),
   })
   .passthrough()

export type OllamaModelSpec = z.infer<typeof OllamaModelSpecSchema>

export const OllamaModelManifestSchema = z
   .object({
      apiVersion: z.literal(AGENT_API_VERSION),
      kind: z.literal("OllamaModel"),
      metadata: ObjectMetaSchema,
      spec: OllamaModelSpecSchema,
   })
   .passthrough()

export type OllamaModelManifest = z.infer<typeof OllamaModelManifestSchema>

const OLLAMA_DEFAULT_BASE_URL = "http://localhost:11434/v1"
// The OpenAI client requires a non-empty apiKey; Ollama ignores it for local
// daemons, so a placeholder stands in when none is configured.
const OLLAMA_PLACEHOLDER_KEY = "ollama"

/**
 * OllamaModel resource — provides a thread completion service backed by an
 * Ollama daemon through its OpenAI-compatible `/v1/chat/completions` endpoint.
 * Local by default; a bearer token (`apiKey` or `OLLAMA_API_KEY`) authenticates
 * a remote deployment. Inert for the tool surface.
 */
export class OllamaModelObject extends BaseModelObject<OllamaModelSpec> {
   readonly apiVersion = AGENT_API_VERSION
   readonly kind = "OllamaModel" as const

   protected buildCompletion(): IThreadCompletionService {
      const apiKey =
         this.spec.apiKey ?? env("OLLAMA_API_KEY") ?? OLLAMA_PLACEHOLDER_KEY
      return new OpenAIThreadCompletionService({
         model: this.spec.model,
         baseURL: this.spec.baseURL ?? env("OLLAMA_BASE_URL") ?? OLLAMA_DEFAULT_BASE_URL,
         apiKey,
      })
   }

   static fromManifest(
      manifest: OllamaModelManifest,
      _ctx: ObjectLoadContext,
   ): OllamaModelObject {
      return new OllamaModelObject(manifest.metadata, manifest.spec)
   }
}

scheme.register({
   apiVersion: AGENT_API_VERSION,
   kind: "OllamaModel",
   manifestSchema: OllamaModelManifestSchema,
   factory: OllamaModelObject.fromManifest,
   metadata: {
      role: "Service de complétion via un daemon Ollama (OpenAI-compatible).",
      surface: "Aucune (service pur)",
      example: `apiVersion: agent/v1
kind: OllamaModel
metadata: { name: local }
spec:
  model: llama3.1`,
      notes: [
         "Local-first ; `OLLAMA_API_KEY` optionnel pour un daemon distant.",
         "`baseURL` défaut : `http://localhost:11434/v1`.",
      ],
      fieldDocs: {
         "spec.description": "Description humaine (intent exposé au LLM pour les skills).",
         "spec.model": "Nom du modèle Ollama (requis).",
         "spec.baseURL": "URL de base (défaut `OLLAMA_BASE_URL` ou `http://localhost:11434/v1`).",
         "spec.apiKey": "Bearer optionnel pour un daemon distant (défaut `OLLAMA_API_KEY`).",
      },
   },
})
