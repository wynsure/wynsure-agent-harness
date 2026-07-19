import type { ToolGuide } from "./blueprint.ts"
import type { Fragment, FragmentOfType, FragmentType } from "./fragment.ts"
import { defineService, type ServiceContract } from "./service.ts"

export interface TokenUsage {
   inputTokens: number
   cachedTokens: number
   outputTokens: number
}

export interface CompletionResult {
   fragments: Fragment[]
   usage?: TokenUsage
}

export interface IThreadCompletionService {
   /**
    * Produce the next completion for the given thread + tool surface. The
    * optional `signal` lets the host abort an in-flight request (steering
    * interrupt): providers that support cancellation should forward it to the
    * underlying client and reject with the platform's abort error on cancel.
    */
   complete(thread: Fragment[], tools: ToolGuide[], signal?: AbortSignal): Promise<CompletionResult>
}

/**
 * The single capability a `model` resource provides in v1. Resolved by name
 * from the agent's `spec.model` at context creation (see docs/resources.spec.md
 * § "model — service de complétion").
 */
export const ThreadCompletionService: ServiceContract<IThreadCompletionService> =
   defineService<IThreadCompletionService>("thread-completion")


export class AgentThread {
   private _fragments: Fragment[] = []

   get fragments(): Fragment[] {
      return this._fragments
   }

   append(fragment: Fragment): void {
      this._fragments.push(fragment)
   }

   emit(fragment: Fragment): void {
      this._fragments.push(fragment)
   }

   emitAll(fragments: Fragment[]): void {
      for (const f of fragments) {
         this._fragments.push(f)
      }
   }

   filterByType<T extends FragmentType>(type: T): FragmentOfType<T>[] {
      return this._fragments.filter((f) => f.type === type) as FragmentOfType<T>[]
   }

   last<T extends FragmentType>(type: T): FragmentOfType<T> | undefined {
      for (let i = this._fragments.length - 1; i >= 0; i--) {
         if (this._fragments[i].type === type) {
            return this._fragments[i] as FragmentOfType<T>
         }
      }
      return undefined
   }

   clear(): void {
      this._fragments = []
   }

   get length(): number {
      return this._fragments.length
   }

   toArray(): Fragment[] {
      return [...this._fragments]
   }
}
