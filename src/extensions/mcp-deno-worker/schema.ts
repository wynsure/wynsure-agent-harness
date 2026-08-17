import { z, type ZodTypeAny } from "zod"
import { logger } from "../../system/logger.ts"

/**
 * Convert a JSON-Schema node into a Zod type. Recursive over `items` (arrays)
 * and `properties` (objects). Honours `enum`, `const`, `oneOf` / `anyOf` /
 * `allOf`, `required`, `description`, and a small set of `format`s. Local
 * `$ref` ("#/.../path") is resolved against the root schema passed at the top
 * of the conversion. Anything we do not recognize falls back to `z.any()` and
 * emits a debug log so missing constructs surface without breaking tool
 * publication.
 *
 * Shared between McpStdio, McpDirect, McpServer and McpDenoWorker: when a tool
 * publishes a richer input schema, the harness reconstructs a best-effort Zod
 * shape that drives selection-time validation and the `--deep` listing.
 */
export function jsonSchemaToZod(
    node: any,
    root: any = node,
    refStack: string[] = [],
): ZodTypeAny {
    const converted = convertJsonSchemaNode(node, root, refStack)
    return typeof node.description === "string"
        ? converted.describe(node.description)
        : converted
}

function convertJsonSchemaNode(
    node: any,
    root: any,
    refStack: string[],
): ZodTypeAny {
    if (!node || typeof node !== "object") return z.any()

    // $ref resolution (local only, e.g. "#/definitions/Foo").
    if (typeof node.$ref === "string" && node.$ref.startsWith("#/")) {
        if (refStack.includes(node.$ref)) {
            logger.debug({ ref: node.$ref }, "json-schema: recursive $ref, fallback to z.any()")
            return z.any()
        }
        const target = resolveRef(root, node.$ref)
        if (!target) {
            logger.debug({ ref: node.$ref }, "json-schema: unresolvable $ref, fallback to z.any()")
            return z.any()
        }
        return jsonSchemaToZod(target, root, [...refStack, node.$ref])
    }

    // Union variants.
    if (Array.isArray(node.oneOf)) return z.union(node.oneOf.map((n) => jsonSchemaToZod(n, root, refStack)) as any)
    if (Array.isArray(node.anyOf)) return z.union(node.anyOf.map((n) => jsonSchemaToZod(n, root, refStack)) as any)
    if (Array.isArray(node.allOf)) {
        // Intersection: merge object schemas; otherwise fallback to first.
        const parts = node.allOf.map((n) => jsonSchemaToZod(n, root, refStack))
        const allObjects = node.allOf.every((n) => n && n.type === "object")
        if (allObjects) {
            const merged: Record<string, ZodTypeAny> = {}
            for (const p of parts as any[]) {
                if (p && typeof p === "object" && "_def" in p && p._def?.typeName === "ZodObject") {
                    Object.assign(merged, (p as any)._def.shape())
                }
            }
            return z.object(merged)
        }
        return parts[0] ?? z.any()
    }

    // const
    if ("const" in node) return z.literal(node.const)

    // enum (operates on the value regardless of `type`)
    if (Array.isArray(node.enum)) {
        // All-string enums must become a native z.enum: the LLM-facing schema
        // is re-serialized via toJSONSchema downstream, and z.enum is the only
        // form that round-trips back to a JSON-Schema `enum` (a union of
        // literals degrades to anyOf/const, which LLM APIs do not constrain).
        if (node.enum.length > 0 && node.enum.every((v) => typeof v === "string")) {
            return z.enum(node.enum as [string, ...string[]])
        }
        const variants = node.enum.map((v) => (v === null ? z.null() : z.literal(v))) as any
        return variants.length === 1 ? variants[0] : z.union(variants)
    }

    switch (node.type) {
        case "string": {
            const fmt = node.format
            if (fmt === "date-time") return z.string().datetime()
            if (fmt === "email") return z.string().email()
            if (fmt === "uri") return z.string().url()
            if (fmt === "uuid") return z.string().uuid()
            return z.string()
        }
        case "integer":
            return z.number().int()
        case "number":
            return z.number()
        case "boolean":
            return z.boolean()
        case "null":
            return z.null()
        case "array":
            return z.array(jsonSchemaToZod(node.items, root, refStack))
        case "object":
            return jsonSchemaObjectToZod(node, root, refStack)
        default:
            logger.debug({ type: node.type }, "json-schema: unknown type, fallback to z.any()")
            return z.any()
    }
}

/** Build `z.object(shape)` from a JSON-Schema object node with `properties` + `required`. */
export function jsonSchemaObjectToZod(
    node: any,
    root: any = node,
    refStack: string[] = [],
): ZodTypeAny {
    const properties: Record<string, any> = node.properties ?? {}
    const required: string[] = Array.isArray(node.required) ? node.required : []
    const shape: Record<string, ZodTypeAny> = {}
    for (const [key, val] of Object.entries(properties)) {
        const child = jsonSchemaToZod(val, root, refStack)
        shape[key] = required.includes(key) ? child : child.optional()
    }
    return z.object(shape).passthrough()
}

/** Resolve a local JSON-Pointer like "#/definitions/Foo" within the root schema. */
function resolveRef(root: any, ref: string): any {
    if (!root || typeof ref !== "string") return undefined
    const parts = ref.split("/").slice(1) // drop leading "#"
    let cur: any = root
    for (const p of parts) {
        if (cur == null) return undefined
        cur = cur[p]
    }
    return cur
}