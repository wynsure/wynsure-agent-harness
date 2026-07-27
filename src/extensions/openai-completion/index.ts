// OpenAI-compatible completion extension — the shared Chat Completions engine
// (`model-base.ts`) plus the three model kinds that wrap it: OpenAIModel,
// OllamaModel (local /v1), AzureFoundryModel (Entra ID or key). Every kind
// resolves the `ThreadCompletionService` capability consumed by AgentContext.
import "./openai-model.ts"
import "./ollama-model.ts"
import "./azure-foundry-model.ts"

export {
   BaseModelObject,
   OpenAIThreadCompletionService,
} from "./model-base.ts"
export type {
   ModelStatus,
   OpenAIThreadCompletionOptions,
   SkillPlacement,
} from "./model-base.ts"

export {
   OpenAIModelObject,
   OpenAIModelSpecSchema,
   OpenAIModelManifestSchema,
} from "./openai-model.ts"
export type {
   OpenAIModelSpec,
   OpenAIModelManifest,
} from "./openai-model.ts"

export {
   OllamaModelObject,
   OllamaModelSpecSchema,
   OllamaModelManifestSchema,
} from "./ollama-model.ts"
export type {
   OllamaModelSpec,
   OllamaModelManifest,
} from "./ollama-model.ts"

export {
   AzureFoundryModelObject,
   AzureFoundryModelSpecSchema,
   AzureFoundryModelManifestSchema,
} from "./azure-foundry-model.ts"
export type {
   AzureFoundryModelSpec,
   AzureFoundryModelManifest,
} from "./azure-foundry-model.ts"
