import type { ToolGuide } from "../blueprint/blueprint.ts"
import type { Fragment, FragmentOfKind, FragmentKind } from "../state/fragment.ts"
import { Leaf } from "../state/leaf.ts"
import type { Tree } from "../state/tree.ts"
import { defineService, type ServiceContract } from "../blueprint/service.ts"

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


/**
 * AgentThread — a context's generation plan at `${contextPath}/thread`: the
 * ordered fragments the agent produced (its memory). A `Leaf<Fragment>`
 * specialized with Fragment query helpers. Aliases (`fragments`/`emit`/
 * `emitAll`) keep the domain vocabulary; `append`/`cells`/`snapshot`/`restore`
 * and sub-leaf navigation come from the Leaf base.
 */
export class AgentThread extends Leaf<Fragment> {
   constructor(path = "/", tree?: Tree) {
      super(path, tree)
   }

   get fragments(): Fragment[] {
      return this.cells
   }

   emit(fragment: Fragment): void {
      this.append(fragment)
   }

   emitAll(fragments: readonly Fragment[]): void {
      this.appendAll(fragments)
   }

   filterByKind<K extends FragmentKind>(kind: K): FragmentOfKind<K>[] {
      return this.cells.filter((f) => f.kind === kind) as FragmentOfKind<K>[]
   }

   last<K extends FragmentKind>(kind: K): FragmentOfKind<K> | undefined {
      for (let i = this.cells.length - 1; i >= 0; i--) {
         if (this.cells[i].kind === kind) {
            return this.cells[i] as FragmentOfKind<K>
         }
      }
      return undefined
   }
}
