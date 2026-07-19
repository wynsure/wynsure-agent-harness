/**
 * Per-context volatile memory store. Owned by an `AgentContext`, never shared
 * with sibling or child contexts. The store is the runtime backing for any
 * `Memory` resource attached to the blueprint: the resource exposes the
 * tooling (`<name>__set`, `<name>__get`), this class holds the actual values.
 *
 * Writes go through `AgentContext.remember(key, value)`. Guardrails read a
 * frozen snapshot via the `memory` variable in their evaluation scope (see
 * docs/hooks-guardrails.spec.md). See docs/resources.spec.md § "memory".
 */
export class MemoryStore {
   private readonly values = new Map<string, unknown>()

   set(key: string, value: unknown): void {
      this.values.set(key, value)
   }

   get<T = unknown>(key: string): T | undefined {
      return this.values.get(key) as T | undefined
   }

   has(key: string): boolean {
      return this.values.has(key)
   }

   delete(key: string): boolean {
      return this.values.delete(key)
   }

   keys(): string[] {
      return [...this.values.keys()]
   }

   /**
    * Frozen snapshot of the current memory, exposed to guardrail evaluation
    * scopes as the `memory` variable. A snapshot (vs a live view) prevents a
    * guardrail's expression from mutating state and keeps each evaluation
    * self-contained.
    */
   snapshot(): Record<string, unknown> {
      return Object.freeze({ ...Object.fromEntries(this.values) })
   }
}
