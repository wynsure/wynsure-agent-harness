import { type ZodType } from "zod"
import {
   type KindMetadata,
   type ObjectManifest,
   parseObjectManifest,
} from "../blueprint/object-meta.ts"
import type { ResourceObject } from "./resource.ts"
import type { AgentSession } from "./session.ts"

/**
 * A Factory builds a live resource object from a validated manifest, bound to
 * the session under construction. Objects own their construction seam: each
 * kind exposes `static fromManifest`, and the Factory below is the type-erased
 * form the Scheme stores so it can dispatch without knowing concrete kinds.
 */
export type ObjectFactory<M extends ObjectManifest = ObjectManifest, O = unknown> = (
   manifest: M,
   ctx: ObjectLoadContext,
) => Promise<O> | O

/**
 * The load context handed to every factory: the session being created. `cwd`
 * (the blueprint's instruction root) is passed alongside because nearly every
 * filesystem-anchoring factory resolves relative paths against it; everything
 * else — peers, instructions, tree — derives from the session. The session's
 * root context does NOT exist yet while factories run: construction-time code
 * must not subscribe to events or acquire context-scoped leaves (that is what
 * `bindToSession` is for).
 */
export interface ObjectLoadContext {
   readonly cwd: string
   readonly session: AgentSession
}

export interface SchemeEntry {
   readonly apiVersion: string
   readonly kind: string
   readonly manifestSchema: ZodType
   readonly factory: ObjectFactory
   readonly metadata: KindMetadata
}

/**
 * Scheme — the single registry binding (apiVersion, kind) to its manifest
 * schema, object factory, and self-description. Replaces the two parallel
 * registries (validation + loader) that had to be kept in sync by convention.
 * Each concrete resource module registers itself once via `scheme.register(...)`.
 */
export class Scheme {
   private readonly entries = new Map<string, SchemeEntry>()

   private key(apiVersion: string, kind: string): string {
      return `${apiVersion}/${kind}`
   }

   register(opts: {
      apiVersion: string
      kind: string
      manifestSchema: ZodType
      factory: ObjectFactory
      metadata: KindMetadata
   }): void {
      const k = this.key(opts.apiVersion, opts.kind)
      if (this.entries.has(k)) {
         throw new Error(
            `Scheme: (${opts.apiVersion}, ${opts.kind}) already registered`,
         )
      }
      this.entries.set(k, {
         apiVersion: opts.apiVersion,
         kind: opts.kind,
         manifestSchema: opts.manifestSchema,
         factory: opts.factory,
         metadata: opts.metadata,
      })
   }

   lookup(apiVersion: string, kind: string): SchemeEntry | undefined {
      return this.entries.get(this.key(apiVersion, kind))
   }

   /** All registered entries — used for introspection (e.g. check command). */
   entries_list(): SchemeEntry[] {
      return [...this.entries.values()]
   }
}

/** The shared, process-wide scheme. Resource modules register into it. */
export const scheme = new Scheme()

/**
 * Validate a raw document fully (envelope + kind-specific spec) and return the
 * parsed manifest. The single entry point used by the loader and by `check`.
 */
export function validateManifest(raw: unknown, index: number): ObjectManifest {
   const envelope = parseObjectManifest(raw, index)
   const entry = scheme.lookup(envelope.apiVersion, envelope.kind)
   if (!entry) {
      throw new Error(
         `Blueprint document #${index} has unknown kind ` +
            `"${envelope.apiVersion}/${envelope.kind}" ` +
            `(name="${envelope.metadata.name}").`,
      )
   }
   const result = entry.manifestSchema.safeParse(raw)
   if (!result.success) {
      throw new Error(
         `Blueprint document #${index} (${envelope.apiVersion}/${envelope.kind}, ` +
            `name="${envelope.metadata.name}") failed validation:\n` +
            result.error.issues
               .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
               .join("\n"),
      )
   }
   return result.data as ObjectManifest
}
