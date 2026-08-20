/**
 * Tests for the McpDirect extension. Unlike McpDenoWorker, the whole point of
 * McpDirect is that the server runs inside the test's own process — so the
 * live path IS testable under `npm test`:
 *  - manifest schema validation (entry required, export default)
 *  - the kind is registered under `agent/v1`
 *  - fromManifest imports the fixture entry, links it in-process, and
 *    publishes prefixed tools
 *  - applyTool performs a real round-trip through the in-memory link
 *  - factory errors are fail-fast and actionable (bad entry, missing export)
 *  - close tears the link down
 */
import { describe, it, assert, eq } from "./runner.ts"
import { resolve as pathResolve } from "path"
import {
    McpDirectObject,
    McpDirectSpecSchema,
    McpDirectManifestSchema,
} from "../src/extensions/mcp-direct/index.ts"
import { scheme, type ObjectLoadContext } from "../src/runtime/scheme.ts"
import type { AgentContext } from "../src/runtime/context.ts"
// Side-effect import to ensure the kind is registered.
import "../src/extensions"

const FIXTURE_ENTRY = pathResolve(import.meta.dirname, "fixtures/direct-echo-server.ts")

function loadCtx(): ObjectLoadContext {
    // McpDirect's factory only consumes `cwd`.
    return { cwd: import.meta.dirname } as ObjectLoadContext
}

function captureContext(): { ctx: AgentContext; deliveries: any[] } {
    const deliveries: any[] = []
    const ctx = {
        deliver(_deliveryId: any, result: any, isError?: boolean) {
            deliveries.push({ result, isError })
        },
    } as unknown as AgentContext
    return { ctx, deliveries }
}

describe("mcp-direct schema", () => {
    it("entry is required", () => {
        const r = McpDirectSpecSchema.safeParse({})
        assert(!r.success, "missing entry rejects")
    })

    it("export defaults to 'default'", () => {
        const r = McpDirectSpecSchema.parse({ entry: "./server.ts" })
        eq(r.export, "default", "export default applied")
    })

    it("manifest envelope validates apiVersion + kind", () => {
        const r = McpDirectManifestSchema.safeParse({
            apiVersion: "agent/v1",
            kind: "McpDirect",
            metadata: { name: "echo" },
            spec: { entry: "./server.ts" },
        })
        assert(r.success, "valid manifest accepted")
    })

    it("manifest rejects a wrong kind", () => {
        const r = McpDirectManifestSchema.safeParse({
            apiVersion: "agent/v1",
            kind: "McpStdio",
            metadata: { name: "echo" },
            spec: { entry: "./server.ts" },
        })
        assert(!r.success, "wrong kind rejected")
    })
})

describe("mcp-direct scheme registration", () => {
    it("McpDirect is registered under agent/v1", () => {
        const entry = scheme.lookup("agent/v1", "McpDirect")
        assert(!!entry, "registered")
        eq(entry!.metadata.surface, "Permanent (lien in-process établi à l'instanciation de session)", "surface documented")
    })

    it("McpDirect factory is the static fromManifest", () => {
        const entry = scheme.lookup("agent/v1", "McpDirect")!
        eq(entry.factory, McpDirectObject.fromManifest, "factory wired to the class")
    })
})

describe("mcp-direct in-process link", () => {
    it("fromManifest imports the entry and publishes prefixed tools", async () => {
        const obj = await McpDirectObject.fromManifest(
            {
                apiVersion: "agent/v1",
                kind: "McpDirect",
                metadata: { name: "echo" },
                spec: { entry: FIXTURE_ENTRY },
            } as any,
            loadCtx(),
        )
        try {
            const tools = obj.getTools()
            eq(tools.length, 1, "one tool published")
            eq(tools[0].name, "echo__echo", "tool name prefixed with the resource name")
            eq(tools[0].intent, "Echo the message back", "description carried into intent")
            eq(obj.status.connected, true, "status connected")
            eq(obj.status.toolCount, 1, "status toolCount")
        } finally {
            await obj.close()
        }
    })

    it("applyTool round-trips through the in-memory link", async () => {
        const obj = await McpDirectObject.fromManifest(
            {
                apiVersion: "agent/v1",
                kind: "McpDirect",
                metadata: { name: "echo" },
                spec: { entry: FIXTURE_ENTRY },
            } as any,
            loadCtx(),
        )
        try {
            const { ctx, deliveries } = captureContext()
            await obj.applyTool("echo__echo", { message: "hi" }, ctx)
            eq(deliveries.length, 1, "one delivery")
            eq(deliveries[0].result, "echo: hi", "echoed payload delivered")
            eq(deliveries[0].isError, false, "not an error")
        } finally {
            await obj.close()
        }
    })

    it("close resets the link and status", async () => {
        const obj = await McpDirectObject.fromManifest(
            {
                apiVersion: "agent/v1",
                kind: "McpDirect",
                metadata: { name: "echo" },
                spec: { entry: FIXTURE_ENTRY },
            } as any,
            loadCtx(),
        )
        await obj.close()
        eq(obj.status.connected, false, "status disconnected after close")
        eq(obj.getTools().length, 0, "tool cache cleared")
    })
})

describe("mcp-direct fail-fast errors", () => {
    it("unknown entry module surfaces at load", async () => {
        let threw = false
        let msg = ""
        try {
            await McpDirectObject.fromManifest(
                {
                    apiVersion: "agent/v1",
                    kind: "McpDirect",
                    metadata: { name: "dead" },
                    spec: { entry: "./fixtures/does-not-exist.ts" },
                } as any,
                loadCtx(),
            )
        } catch (err) {
            threw = true
            msg = (err as Error).message
        }
        assert(threw, "missing module fails at load")
        assert(
            /failed to import entry/.test(msg),
            `error names the entry: ${msg}`,
        )
    })

    it("missing named export surfaces at load", async () => {
        let threw = false
        let msg = ""
        try {
            await McpDirectObject.fromManifest(
                {
                    apiVersion: "agent/v1",
                    kind: "McpDirect",
                    metadata: { name: "dead" },
                    spec: { entry: FIXTURE_ENTRY, export: "not_exported" },
                } as any,
                loadCtx(),
            )
        } catch (err) {
            threw = true
            msg = (err as Error).message
        }
        assert(threw, "missing export fails at load")
        assert(
            /no export named "not_exported"/.test(msg),
            `error names the export: ${msg}`,
        )
    })
})
