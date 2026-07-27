import { z } from "zod"
import { DefaultAzureCredential } from "@azure/identity"
import {
   type ObjectLoadContext,
   type ObjectMeta,
   scheme,
   ObjectMetaSchema,
} from "../../blueprint/object-meta.ts"
import { type IThreadCompletionService } from "../../runtime/thread.ts"
import { BaseModelObject, env, OpenAIThreadCompletionService } from "./model-base.ts"
import { AGENT_API_VERSION } from "../../blueprint/api-version.ts"

/**
 * AzureFoundryModelSpec — the declarative payload of a model served by Azure AI
 * Foundry. `endpoint` targets the Foundry "models" inference endpoint
 * (OpenAI-compatible); `deployment` names the model deployment (passed as the
 * request model). Auth is either an API key (`apiKey`, default
 * `AZURE_OPENAI_API_KEY`) or a Microsoft Entra ID token resolved through
 * `@azure/identity` (`entraId`).
 */
export const AzureFoundryModelSpecSchema = z
   .object({
      description: z.string().optional(),
      endpoint: z.string(),
      deployment: z.string(),
      auth: z.enum(["apiKey", "entraId"]).default("apiKey"),
      apiKey: z.string().optional(),
   })
   .passthrough()

export type AzureFoundryModelSpec = z.infer<typeof AzureFoundryModelSpecSchema>

export const AzureFoundryModelManifestSchema = z
   .object({
      apiVersion: z.literal(AGENT_API_VERSION),
      kind: z.literal("AzureFoundryModel"),
      metadata: ObjectMetaSchema,
      spec: AzureFoundryModelSpecSchema,
   })
   .passthrough()

export type AzureFoundryModelManifest = z.infer<typeof AzureFoundryModelManifestSchema>

/** The Azure AI scope requested for Entra ID bearer tokens. */
const AZURE_AI_SCOPE = "https://ai.azure.com/.default"

/**
 * Resolve the bearer credential an AzureFoundryModel authenticates with. For
 * `entraId`, acquires a token through `@azure/identity`'s
 * `DefaultAzureCredential` (managed identity, env service principal, CLI, …).
 * The token is acquired once at load; long-lived sessions needing token
 * refresh should re-resolve — deferred for v1.
 */
async function resolveAzureCredential(spec: AzureFoundryModelSpec): Promise<string> {
   if (spec.auth === "entraId") {
      const credential = new DefaultAzureCredential()
      const token = await credential.getToken(AZURE_AI_SCOPE)
      if (!token) {
         throw new Error(
            `AzureFoundryModel: Entra ID credential returned no token. Check your @azure/identity environment (AZURE_TENANT_ID / AZURE_CLIENT_ID / managed identity / az login).`,
         )
      }
      return token.token
   }
   const key = spec.apiKey ?? env("AZURE_OPENAI_API_KEY")
   if (!key) {
      throw new Error(
         `AzureFoundryModel: no API key. Set spec.apiKey or the AZURE_OPENAI_API_KEY env var (or use auth: entraId).`,
      )
   }
   return key
}

/**
 * AzureFoundryModel resource — provides a thread completion service backed by
 * an Azure AI Foundry model, authenticating via API key or a Microsoft Entra ID
 * token (`@azure/identity`). The Foundry "models" endpoint is
 * OpenAI-compatible and accepts `Authorization: Bearer <key-or-token>`, so the
 * service reuses the OpenAI-compatible client. Inert for the tool surface.
 */
export class AzureFoundryModelObject extends BaseModelObject<AzureFoundryModelSpec> {
   readonly apiVersion = AGENT_API_VERSION
   readonly kind = "AzureFoundryModel" as const
   private readonly bearer: string

   private constructor(metadata: ObjectMeta, spec: AzureFoundryModelSpec, bearer: string) {
      super(metadata, spec)
      this.bearer = bearer
   }

   protected buildCompletion(): IThreadCompletionService {
      return new OpenAIThreadCompletionService({
         model: this.spec.deployment,
         baseURL: this.spec.endpoint,
         apiKey: this.bearer,
      })
   }

   static async fromManifest(
      manifest: AzureFoundryModelManifest,
      _ctx: ObjectLoadContext,
   ): Promise<AzureFoundryModelObject> {
      const bearer = await resolveAzureCredential(manifest.spec)
      return new AzureFoundryModelObject(manifest.metadata, manifest.spec, bearer)
   }
}

scheme.register({
   apiVersion: AGENT_API_VERSION,
   kind: "AzureFoundryModel",
   manifestSchema: AzureFoundryModelManifestSchema,
   factory: AzureFoundryModelObject.fromManifest,
   metadata: {
      role: "Service de complétion Azure AI Foundry (clé API ou Entra ID).",
      surface: "Aucune (service pur)",
      example: `apiVersion: agent/v1
kind: AzureFoundryModel
metadata: { name: azure-gpt4o }
spec:
  endpoint: https://myfoundry.models.ai.azure.com
  deployment: gpt-4o
  auth: apiKey`,
      notes: [
         "`auth: entraId` → `DefaultAzureCredential` (`@azure/identity`).",
         "`auth: apiKey` → défaut `AZURE_OPENAI_API_KEY`.",
      ],
      fieldDocs: {
         "spec.description": "Description humaine (intent exposé au LLM pour les skills).",
         "spec.endpoint": "Endpoint Foundry (OpenAI-compatible).",
         "spec.deployment": "Nom du deployment Foundry (passé comme `model`).",
         "spec.auth": "Mode d'authentification Foundry (`apiKey` ou `entraId`).",
         "spec.apiKey": "Clé API (requis si `auth=apiKey`, défaut `AZURE_OPENAI_API_KEY`).",
      },
   },
})
