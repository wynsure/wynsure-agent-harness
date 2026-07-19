import type {
   ResourceObject,
   ToolGuide,
   ToolOutcome,
   GuardrailDecl,
   HookEntry,
   HookTrigger,
} from "../blueprint.ts"
import type { ObjectManifest, ObjectMeta } from "../object-meta.ts"
import type { ServiceContract } from "../service.ts"
import {
   type IThreadCompletionService,
   ThreadCompletionService,
} from "../thread.ts"
import type { AgentContext } from "../context.ts"

/** Read a process environment variable (undefined outside Node). */
export function env(name: string): string | undefined {
   return typeof process !== "undefined" ? process.env?.[name] : undefined
}

/**
 * Observed model state — audit only, never the runtime source of truth.
 */
export interface ModelStatus {
   readonly kind: string
}

/**
 * BaseModelObject — the shared mechanics every model-kind resource reuses
 * (OpenAIModel, OllamaModel, AzureFoundryModel…). Each concrete kind turns its
 * spec into a live `IThreadCompletionService` via `buildCompletion`; the base
 * owns the capability dispatch (`getService`), the lazy build + cache, and the
 * inert tool surface.
 *
 * A model resource publishes no tools, hooks or fragments: it exists solely to
 * provide the `ThreadCompletionService` capability. The agent references it by
 * name via `spec.model`; resolution is contract-based (see
 * docs/resources.spec.md § "Contrats de service").
 */
export abstract class BaseModelObject<S = unknown> implements ResourceObject {
   abstract readonly apiVersion: string
   abstract readonly kind: string
   readonly metadata: ObjectMeta
   readonly name: string
   readonly spec: S
   private cached?: IThreadCompletionService

   protected constructor(metadata: ObjectMeta, spec: S) {
      this.metadata = metadata
      this.name = metadata.name
      this.spec = spec
   }

   get status(): ModelStatus {
      return { kind: this.kind }
   }

   getService<T>(contract: ServiceContract<T>): T | undefined {
      if (contract.id === ThreadCompletionService.id) {
         this.cached ??= this.buildCompletion()
         return this.cached as unknown as T
      }
      return undefined
   }

   /** Build the live completion service from the spec. Called once. */
   protected abstract buildCompletion(): IThreadCompletionService

   getTools(): ToolGuide[] {
      return []
   }
   getHooks(_trigger: HookTrigger): HookEntry[] {
      return []
   }
   getGuardrails(): GuardrailDecl[] {
      return []
   }
   async applyTool(
      _id: string,
      _params: Record<string, any>,
      _context: AgentContext,
   ): Promise<ToolOutcome | undefined> {
      return undefined
   }
   toManifest(): ObjectManifest {
      return {
         apiVersion: this.apiVersion,
         kind: this.kind,
         metadata: this.metadata,
         spec: this.spec as unknown,
      }
   }
}
