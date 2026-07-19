import { type ZodType, z } from "zod"

/**
 * TypeMeta — the (apiVersion, kind) pair that identifies a resource's schema
 * contract. Replaces the old single `type` discriminator. `kind` is the
 * concrete type (PascalCase); `apiVersion` is the group/version, which opens a
 * non-breaking migration path (agent/v2 can coexist with agent/v1).
 */
export interface TypeMeta {
   readonly apiVersion: string
   readonly kind: string
}

export const TypeMetaSchema = z.object({
   apiVersion: z.string().min(1),
   kind: z.string().min(1),
})

/**
 * ObjectMeta — identity + cross-cutting relationships shared by every resource,
 * independent of its kind. Modeled after Kubernetes' ObjectMeta: `name` is the
 * stable identifier, `labels` make the resource selectable (toolset selectors,
 * future ownership) and `annotations` carry non-selectable config. Anything
 * kind-specific (including the `extends` overlay list, which each consumer
 * kind merges in its own way) lives in `spec`, not here.
 */
export interface ObjectMeta {
   readonly name: string
   readonly labels?: Record<string, string>
   readonly annotations?: Record<string, string>
}

export const ObjectMetaSchema = z
   .object({
      name: z.string().min(1),
      labels: z.record(z.string(), z.string()).optional(),
      annotations: z.record(z.string(), z.string()).optional(),
   })
   .passthrough()

/**
 * Per-field intent for the `ObjectMeta` shape, keyed by `<parent>.<field>`.
 * Shared by every kind (since every manifest carries an `ObjectMeta`); exposed
 * here so each kind's `KindMetadata.fieldDocs` only has to describe its own
 * `spec.*` fields. Consumed by introspection tools (`docs` command).
 *
 * Values are doc strings (French) — same tone as `docs/*.spec.md`.
 */
export const OBJECTMETA_FIELD_DOCS: Record<string, string> = {
   "metadata.name": "Identifiant unique de la ressource dans le blueprint.",
   "metadata.labels": "Labels sélectionnables via `toolset.selector.matchLabels`.",
   "metadata.annotations": "Annotations libres (non-sélectionnables).",
}

/**
 * ObjectManifest — the serializable form of any resource. The on-disk / wire
 * shape: TypeMeta + ObjectMeta + an opaque `spec` (typed per kind by the
 * concrete manifest schemas). This base only validates the envelope; the
 * kind-specific schema validates `spec`.
 */
export type ObjectManifest = TypeMeta & {
   readonly metadata: ObjectMeta
   readonly spec?: unknown
}

export const ObjectManifestEnvelopeSchema = TypeMetaSchema.extend({
   metadata: ObjectMetaSchema,
})

/**
 * LabelSelector — selects resources by their `metadata.labels`. v1 supports
 * `matchLabels` only (AND of equality: every requested key must be present
 * with the same value). `matchExpressions` is reserved for a concrete need.
 */
export interface LabelSelector {
   readonly matchLabels?: Record<string, string>
}

export const LabelSelectorSchema = z.object({
   matchLabels: z.record(z.string(), z.string()).optional(),
})

/** True iff every requested label is present on `labels` with the same value. */
export function labelSelectorMatches(
   selector: LabelSelector,
   labels: Record<string, string> | undefined,
): boolean {
   const want = selector.matchLabels
   if (!want) return true
   const have = labels ?? {}
   for (const [k, v] of Object.entries(want)) {
      if (have[k] !== v) return false
   }
   return true
}

/**
 * A Factory builds a live Object from a validated manifest, given the load
 * context (blueprint + cwd). Objects own their construction seam: each kind
 * exposes `static fromManifest`, and the Factory below is the type-erased form
 * the Scheme stores so it can dispatch without knowing concrete kinds.
 */
export type ObjectFactory<M extends ObjectManifest = ObjectManifest, O = unknown> = (
   manifest: M,
   ctx: ObjectLoadContext,
) => Promise<O> | O

export interface ObjectLoadContext {
   readonly cwd: string
   /** Resolved later; passed as `any` to avoid a circular type import. */
   readonly blueprint: unknown
}

/**
 * KindMetadata — the self-description each kind provides at registration time.
 * Drives auto-generated documentation (`docs` command) and any future
 * introspection surface. Values are doc strings (French) matching the tone of
 * `docs/*.spec.md`. The schema (Zod) already describes the shape; metadata
 * carries the intent the schema cannot express.
 *
 * `fieldDocs` is keyed by `<parent>.<field>` (e.g. `spec.model`) and covers
 * only the kind-specific `spec.*` fields — the common `metadata.*` fields are
 * centralized in `OBJECTMETA_FIELD_DOCS`.
 */
export interface KindMetadata {
   /** One-line role description. */
   readonly role: string
   /** Runtime surface summary (when this kind contributes tools / hooks). */
   readonly surface: string
   /** Minimal valid manifest example (YAML string). */
   readonly example?: string
   /** Runtime caveats specific to this kind. */
   readonly notes?: readonly string[]
   /** Per-field intent for `spec.*` fields, keyed by `<parent>.<field>`. */
   readonly fieldDocs?: Record<string, string>
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
 * Parse a raw YAML document into a typed ObjectManifest envelope, validating
 * the TypeMeta + ObjectMeta shell. The kind-specific `spec` is left for the
 * Scheme entry's schema. Throws a human-readable error pointing at the doc.
 */
export function parseObjectManifest(raw: unknown, index: number): ObjectManifest {
   const result = ObjectManifestEnvelopeSchema.safeParse(raw)
   if (!result.success) {
      throw new Error(
         `Blueprint document #${index} is not a valid object manifest:\n` +
            result.error.issues
               .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
               .join("\n"),
      )
   }
   return result.data as ObjectManifest
}

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
