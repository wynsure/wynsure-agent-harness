import type { ActivityId } from "./activity.ts"
import type { Tree } from "./tree.ts"

/**
 * Cell — the contract every element stored in a Leaf satisfies. Captures the
 * two notions the agent thread (Fragment), the user-interaction projection
 * (InteractionItem) and the resource state projection (StateCell) share:
 *  - `kind`        — the discriminator, meaningful within a single leaf
 *                    (a Fragment variant, an InteractionItem variant, or a
 *                    resource `metadata.name` inside a `state` leaf);
 *  - `activityId`  — the activity that produced / emits the cell (links to the
 *                    activity model), when applicable.
 *
 * The contract is intentionally narrow: fields that do not coincide across
 * projections stay on each specialization. Bringing the discriminator under one
 * name (`kind`) is what lets generic code branch over a `Leaf<Cell>` without
 * knowing which leaf it holds.
 *
 * The name echoes the kanopi Tree/Leaf/Cell vocabulary: a Leaf is a sequence
 * of Cells. A Cell is directly serializable (plain JSON).
 */
export interface Cell {
   kind: string
   activityId?: ActivityId
}

/**
 * StateCell — a Cell whose `payload` carries a resource's serialized state.
 * Lives in a scope's `state` leaf, keyed by `kind = resource.metadata.name`.
 * The owning resource is the sole typed reader/writer of `payload`.
 */
export interface StateCell extends Cell {
   payload: unknown
}

/**
 * Builds a leaf of a concrete cell type at a resolved path. Specializations
 * (e.g. `AgentThread`) pass their own factory so the Tree stores the typed
 * subclass rather than a plain `Leaf`. Defaults to a plain `Leaf`.
 */
export type LeafFactory<C extends Cell = Cell> = (path: string, tree: Tree) => Leaf<C>

export const defaultLeafFactory: LeafFactory = (path, tree) => new Leaf(path, tree)

/**
 * Leaf<Cell> — the shared, path-addressed container for an ordered set of
 * Cells. Unifies the projections of the system:
 *  - a context's agent thread (`AgentThread extends Leaf<Fragment>`) at
 *    `${contextPath}/thread` — the LLM's memory of fragments it produced;
 *  - a host's user-interaction projection (`Leaf<InteractionItem>`) at
 *    `${contextPath}/interact` — the user-facing conversation surface;
 *  - a scope's resource state (`Leaf<StateCell>`) at `${scopePath}/state` —
 *    per-resource state keyed by `kind = resource name`.
 *
 * The base owns the ordered storage, two mutation styles — append (ordered,
 * for threads) and upsert-by-kind (latest-wins, for state) — the snapshot/
 * restore boundary (a Leaf is the serializable unit), and sub-leaf navigation
 * rooted at `this.path`. Sub-leaf ops compose paths as
 * `${self_path}/${sub_name}` and delegate to the owning Tree; a detached leaf
 * (no Tree) throws on navigation. Specialized query/mutation lives on the
 * subclass (e.g. `AgentThread.filterByKind`).
 */
export class Leaf<C extends Cell> {
   readonly path: string
   protected readonly tree: Tree | undefined
   private _cells: C[] = []

   constructor(path = "/", tree?: Tree) {
      this.path = path
      this.tree = tree
   }

   get cells(): C[] {
      return this._cells
   }

   get length(): number {
      return this._cells.length
   }

   // ── Append style (ordered) ──────────────────────────────────────────

   append(cell: C): void {
      this._cells.push(cell)
   }

   appendAll(cells: readonly C[]): void {
      for (const c of cells) this._cells.push(c)
   }

   // ── Upsert-by-kind style (latest-wins, for state leaves) ────────────

   /** Insert or replace the Cell whose `kind` matches (state semantics). */
   upsert(cell: C): void {
      const idx = this._cells.findIndex((c) => c.kind === cell.kind)
      if (idx >= 0) this._cells[idx] = cell
      else this._cells.push(cell)
   }

   /** First Cell whose `kind` matches, or undefined. */
   get(kind: string): C | undefined {
      return this._cells.find((c) => c.kind === kind)
   }

   /** Remove and return the Cell whose `kind` matches (undefined if absent). */
   removeKind(kind: string): C | undefined {
      const idx = this._cells.findIndex((c) => c.kind === kind)
      return idx >= 0 ? this._cells.splice(idx, 1)[0] : undefined
   }

   // ── Index style (positional, e.g. updating an interaction card) ─────

   /** Replace the Cell at `index`. No-op when the index is out of bounds. */
   set(index: number, cell: C): void {
      if (index >= 0 && index < this._cells.length) {
         this._cells[index] = cell
      }
   }

   /** Insert `cell` at `index`, shifting the tail. */
   insert(index: number, cell: C): void {
      const at = index < 0 ? 0 : index > this._cells.length ? this._cells.length : index
      this._cells.splice(at, 0, cell)
   }

   /** Remove and return the Cell at `index` (undefined when out of bounds). */
   remove(index: number): C | undefined {
      if (index < 0 || index >= this._cells.length) return undefined
      return this._cells.splice(index, 1)[0]
   }

   toArray(): C[] {
      return [...this._cells]
   }

   clear(): void {
      this._cells = []
   }

   // ── Sub-leaf navigation (rooted at `this.path`) ─────────────────────

   /** Sub-leaf at `${this.path}/${sub}`, or undefined when absent. */
   findLeaf<C2 extends Cell>(sub: string): Leaf<C2> | undefined {
      return this.requireTree().findLeaf<C2>(`${this.path}/${sub}`)
   }

   /** Sub-leaf at `${this.path}/${sub}`, created on first access. */
   acquireLeaf<C2 extends Cell>(sub: string, factory?: LeafFactory): Leaf<C2> {
      return this.requireTree().acquireLeaf<C2>(`${this.path}/${sub}`, factory)
   }

   /** Remove the sub-leaf at `${this.path}/${sub}` and its descendants. */
   deleteLeaf(sub: string): void {
      this.requireTree().deleteLeaf(`${this.path}/${sub}`)
   }

   // ── Serde boundary ──────────────────────────────────────────────────

   /** Serializable projection of the leaf (a stable serde boundary). */
   snapshot(): C[] {
      return [...this._cells]
   }

   /** Replace the leaf's contents wholesale (the restore counterpart). */
   restore(cells: readonly C[]): void {
      this._cells = [...cells]
   }

   private requireTree(): Tree {
      if (!this.tree) {
         throw new Error(`Leaf "${this.path}" is detached from any Tree`)
      }
      return this.tree
   }
}
