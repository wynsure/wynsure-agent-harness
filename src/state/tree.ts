import { Leaf, defaultLeafFactory, type Cell, type LeafFactory } from "./leaf.ts"

/**
 * Tree — the root container that owns every Leaf of a session and resolves
 * their lexical paths. One Tree per session; it is the serializable unit a
 * session snapshots/restores as a whole.
 *
 * Paths are POSIX-style and relative to the tree root `/`, which coincides
 * with the root context. Hierarchy is purely lexical (no stored parent link):
 * a sub-leaf lives at `${self_path}/${sub}`, and listing is a one-level prefix
 * match. The reserved path `/.session` hosts session-scoped state so it never
 * collides with a context id (ids are opaque). See docs/architecture.spec.md.
 */
export class Tree {
   private readonly leaves = new Map<string, Leaf<Cell>>()

   hasLeaf(path: string): boolean {
      return this.leaves.has(normalizeLeafPath(path))
   }

   findLeaf<C extends Cell>(path: string): Leaf<C> | undefined {
      return this.leaves.get(normalizeLeafPath(path)) as Leaf<C> | undefined
   }

   /**
    * Return the leaf at `path`, building it with `factory` (default: a plain
    * `Leaf`) on first access. Subsequent calls return the same instance,
    * ignoring the factory — the typed subclass is established by the first
    * caller (e.g. the context acquires `/thread` as an `AgentThread`).
    */
   acquireLeaf<C extends Cell>(
      path: string,
      factory: LeafFactory = defaultLeafFactory,
   ): Leaf<C> {
      const norm = normalizeLeafPath(path)
      const existing = this.leaves.get(norm)
      if (existing) return existing as Leaf<C>
      const leaf = factory(norm, this) as Leaf<Cell>
      this.leaves.set(norm, leaf)
      return leaf as Leaf<C>
   }

   /** Remove the leaf at `path` and every descendant beneath it. */
   deleteLeaf(path: string): void {
      const norm = normalizeLeafPath(path)
      for (const key of [...this.leaves.keys()]) {
         if (norm === "/" || key === norm || key.startsWith(`${norm}/`)) {
            this.leaves.delete(key)
         }
      }
   }

   /** All stored leaf paths (sorted, for deterministic snapshots). */
   listPaths(): string[] {
      return [...this.leaves.keys()].sort()
   }

   snapshot(): TreeSnapshot {
      const leaves: Record<string, Cell[]> = {}
      for (const path of this.listPaths()) {
         leaves[path] = this.leaves.get(path)!.snapshot()
      }
      return { leaves }
   }

   /**
    * Apply a snapshot to the tree. For each path, cells are restored INTO an
    * existing leaf when one is present (so a typed subclass already acquired
    * by its owner — e.g. the root context's `AgentThread` at `/thread` — keeps
    * its identity and just receives its cells); otherwise a plain `Leaf` is
    * created. Paths absent from the snapshot are left untouched.
    */
   restore(snapshot: TreeSnapshot): void {
      for (const [rawPath, cells] of Object.entries(snapshot.leaves)) {
         const path = normalizeLeafPath(rawPath)
         const existing = this.leaves.get(path)
         if (existing) {
            existing.restore(cells)
         } else {
            const leaf = new Leaf<Cell>(path, this)
            leaf.restore(cells)
            this.leaves.set(path, leaf)
         }
      }
   }
}

/** Serialized form of a Tree: each stored path mapped to its Cell array. */
export interface TreeSnapshot {
   leaves: Record<string, Cell[]>
}

/** Reserved path prefix under which session-scoped leaves live. */
export const SESSION_SCOPE_PATH = "/.session"

/** Normalize a leaf path: leading slash, collapsed duplicates, no trailing slash. */
export function normalizeLeafPath(p: string): string {
   if (!p || p === ".") return "/"
   let s = p.startsWith("/") ? p : `/${p}`
   s = s.replace(/\/+/g, "/")
   if (s.length > 1 && s.endsWith("/")) s = s.slice(0, -1)
   return s
}

/** Join a parent path with a relative segment. An absolute `sub` overrides. */
export function joinLeafPath(parent: string, sub: string): string {
   if (sub.startsWith("/")) return normalizeLeafPath(sub)
   if (!sub || sub === ".") return normalizeLeafPath(parent)
   return normalizeLeafPath(`${parent}/${sub}`)
}
