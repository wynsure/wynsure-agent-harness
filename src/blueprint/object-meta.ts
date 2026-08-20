import { z } from "zod"

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

/**
 * Parse a raw YAML document into a typed ObjectManifest envelope, validating
 * the TypeMeta + ObjectMeta shell. The kind-specific `spec` is left to the
 * kind registry (`runtime/scheme.ts`). Throws a human-readable error pointing
 * at the doc.
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
