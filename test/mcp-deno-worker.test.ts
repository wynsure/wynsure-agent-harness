/**
 * Smoke tests for the McpDenoWorker extension. The live Worker transport
 * requires Deno, so under Node we exercise:
 *  - the JSON-Schema → Zod converter (`schema.ts`)
 *  - the `denoPermissionsObject` semantics (allowlist + env special case)
 *  - the runtime firewall: `WorkerChannel` and `McpDenoWorkerObject` factory
 *    both refuse outside Deno (`detectRuntime()` is real; stubs in this file
 *    exercise the firewall paths explicitly).
 *
 * Live Worker spawn/handshake runs under a Deno parent runtime — out of scope
 * for `npm test`.
 */
import { describe, it, assert, eq } from "./runner.ts"
import { resolve as pathResolve } from "path"
import { z } from "zod"
import {
    jsonSchemaToZod,
    jsonSchemaObjectToZod,
    denoPermissionsObject,
    detectRuntime,
    HANDSHAKE_SIGNAL,
    isRemoteEntrypoint,
    WorkerChannel,
    McpDenoWorkerObject,
    type McpDenoWorkerSpec,
} from "../src/extensions/mcp-deno-worker/index.ts"
import {
    scheme,
    type ObjectLoadContext,
} from "../src/blueprint/object-meta.ts"
import type { ObjectMeta } from "../src/blueprint/object-meta.ts"
// Side-effect import to ensure the kind is registered.
import "../src/extensions"

describe("mcp-deno-worker schema mapper", () => {
    it("primitives map to the expected Zod types", () => {
        assert(jsonSchemaToZod({ type: "string" }) instanceof z.ZodString, "string")
        assert(jsonSchemaToZod({ type: "number" }) instanceof z.ZodNumber, "number")
        assert(jsonSchemaToZod({ type: "integer" }) instanceof z.ZodNumber, "integer is z.number")
        assert(jsonSchemaToZod({ type: "boolean" }) instanceof z.ZodBoolean, "boolean")
        assert(jsonSchemaToZod({ type: "null" }) instanceof z.ZodNull, "null")
    })

    it("format:w maps to refined string validators", () => {
        const dt = jsonSchemaToZod({ type: "string", format: "date-time" })
        assert(dt instanceof z.ZodString, "date-time is a z.string")
        assert(dt.safeParse("2024-01-01T00:00:00Z").success, "date-time accepts ISO datetime")
        const email = jsonSchemaToZod({ type: "string", format: "email" })
        assert(email instanceof z.ZodString, "email is a z.string")
        assert(email.safeParse("a@b.com").success, "email validator accepts valid email")
    })

    it("enum produces a union of literals", () => {
        const u = jsonSchemaToZod({ type: "string", enum: ["a", "b", "c"] })
        assert(u instanceof z.ZodUnion, "enum → z.union")
    })

    it("const produces a single literal", () => {
        const c = jsonSchemaToZod({ const: 42 })
        assert(c instanceof z.ZodLiteral, "const → z.literal")
        eq((c as z.ZodLiteral<number>).value, 42, "literal value")
    })

    it("array recurses over items", () => {
        const a = jsonSchemaToZod({ type: "array", items: { type: "string" } })
        assert(a instanceof z.ZodArray, "array")
        assert((a as z.ZodArray<any>).element instanceof z.ZodString, "items recursively mapped")
    })

    it("object: required props mandatory, others optional", () => {
        const o = jsonSchemaObjectToZod({
            type: "object",
            properties: {
                to: { type: "string" },
                subject: { type: "string" },
                body: { type: "string" },
                dry_run: { type: "boolean" },
            },
            required: ["to", "subject", "body"],
        }) as z.ZodObject<any>
        o.parse({ to: "a@b", subject: "s", body: "x" })
        let threw = false
        try { o.parse({ subject: "s", body: "x" }) } catch { threw = true }
        assert(threw, "missing required throws")
        o.parse({ to: "a@b", subject: "s", body: "x" })
    })

    it("oneOf / anyOf produce a union", () => {
        const one = jsonSchemaToZod({ oneOf: [{ type: "string" }, { type: "number" }] })
        assert(one instanceof z.ZodUnion, "oneOf → z.union")
        const any = jsonSchemaToZod({ anyOf: [{ type: "string" }, { type: "boolean" }] })
        assert(any instanceof z.ZodUnion, "anyOf → z.union")
    })

    it("local $ref resolves within the same schema", () => {
        const root = {
            type: "object",
            properties: { self: { $ref: "#/definitions/Email" } },
            definitions: { Email: { type: "string", format: "email" } },
        }
        const o = jsonSchemaObjectToZod(root) as z.ZodObject<any>
        const selfType = o.shape.self
        assert(selfType.safeParse("a@b.com").success, "$ref resolved: accepts a valid email")
        assert(!selfType.safeParse("not-an-email").success, "$ref resolved: rejects a non-email")
    })

    it("local $ref cycle does not infinite-loop (returns any())", () => {
        const cycleRoot = {
            type: "object",
            properties: { a: { $ref: "#/definitions/X" } },
            definitions: { X: { $ref: "#/definitions/X" } },
        }
        const tree = jsonSchemaObjectToZod(cycleRoot) as z.ZodObject<any>
        assert(tree.shape.a !== undefined, "cycle returned a non-undefined shape entry")
        assert(tree.shape.a.safeParse({ nested: 42 }).success, "cycle fallback accepts any value")
    })

    it("unknown type falls back to z.any() without throwing", () => {
        const a = jsonSchemaToZod({ type: "weird" })
        assert(a instanceof z.ZodAny, "unknown → z.any()")
    })
})

describe("mcp-deno-worker permission object", () => {
    it("empty env allowlist → permissions.env = false", () => {
        const p = denoPermissionsObject(["net", "write=./outbox"], [])
        eq(p.env, false, "env = false when allowlist is empty")
        eq(p.net, true, "bare `net` → true")
        eq(p.write, ["./outbox"], "valued `write=./outbox` → allowlist array")
    })

    it("explicit env allowlist → permissions.env = [keys]", () => {
        const p = denoPermissionsObject([], ["SMTP_HOST", "MAIL_FROM"])
        eq(p.env, ["SMTP_HOST", "MAIL_FROM"], "env = explicit allowlist")
    })

    it("allow: env alone (without env allowlist) is a no-op", () => {
        const p = denoPermissionsObject(["env"], [])
        eq(p.env, false, "`env` in allow does not unlock env access in v1")
    })

    it("multiple <cap>=<value> entries merge into a single allowlist array", () => {
        const p = denoPermissionsObject(["net=127.0.0.1", "net=10.0.0.1"], []) as any
        assert(Array.isArray(p.net), "net is an array after multiple value entries")
        assert(p.net.includes("127.0.0.1") && p.net.includes("10.0.0.1"), "both values merged")
    })

    it("bare `cap` followed by `cap=value` upgrades to allowlist", () => {
        const p = denoPermissionsObject(["net", "net=127.0.0.1"], []) as any
        assert(Array.isArray(p.net), "net upgraded to array")
        assert(p.net.includes("127.0.0.1"), "value retained")
    })

    it("empty allow entries are skipped", () => {
        const p = denoPermissionsObject(["", "ffi"], []) as any
        eq(p.ffi, true, "blank entries filtered")
        assert(!("undefined" in p), "no empty-key entries")
    })
})

describe("mcp-deno-worker remote entrypoint detection", () => {
    it("isRemoteEntrypoint: variations", () => {
        assert(isRemoteEntrypoint("https://deno.land/x/mod.ts"), "https")
        assert(isRemoteEntrypoint("npm:@scope/pkg/mod.ts"), "npm")
        assert(isRemoteEntrypoint("jsr:@scope/pkg/mod.ts"), "jsr")
        assert(isRemoteEntrypoint("file:///abs/mod.ts"), "file URL")
        assert(!isRemoteEntrypoint("./mailer/mod.ts"), "relative is not remote")
        assert(!isRemoteEntrypoint("C:\\dev\\mod.ts"), "absolute path is not remote")
    })
})

describe("mcp-deno-worker runtime firewall", () => {
    it("WorkerChannel constructor throws outside Deno", () => {
        if (detectRuntime() === "deno") {
            // On a Deno parent runtime the constructor would proceed — skip
            // this firewall assertion, the test lives in the Deno suite.
            return
        }
        let threw = false
        let msg = ""
        try {
            new WorkerChannel({
                specifier: "file:///dev/null",
                permissions: {},
                handshakeTimeoutMs: 1000,
                channelId: "test",
            })
        } catch (err) {
            threw = true
            msg = (err as Error).message
        }
        assert(threw, "WorkerChannel refused outside Deno")
        assert(/Deno parent runtime/.test(msg), `error message mentions Deno: ${msg}`)
    })

    it("McpDenoWorkerObject.fromManifest refuses outside Deno", async () => {
        if (detectRuntime() === "deno") {
            return
        }
        const manifest = {
            apiVersion: "agent/v1",
            kind: "McpDenoWorker",
            metadata: { name: "mailer" },
            spec: {
                entrypoint: "./mailer/mod.ts",
                allow: ["net=127.0.0.1"],
                env: ["SMTP_HOST"],
            },
        } as any
        const ctx: ObjectLoadContext = { cwd: ".", blueprint: undefined }
        let threw = false
        let msg = ""
        try {
            // Reach into the registry to call the factory directly so the
            // firewall is exercised without spawning a Worker.
            const entry = scheme.lookup("agent/v1", "McpDenoWorker")
            assert(!!entry, "McpDenoWorker is registered")
            await entry!.factory(manifest, ctx)
        } catch (err) {
            threw = true
            msg = (err as Error).message
        }
        assert(threw, "fromManifest refused outside Deno")
        assert(/Deno parent runtime/.test(msg), `error message mentions Deno: ${msg}`)
    })

    it("handshake signal constant is the documented MCP-READY", () => {
        eq(HANDSHAKE_SIGNAL, "MCP-READY", "handshake signal exposes the spec invariant")
    })
})