import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js"
import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js"

/**
 * `InterWorkerChannel` is a `Transport` (MCP SDK) backed by a message-oriented
 * channel between the harness and a Deno worker. One envelope per message —
 * there is no byte-stream framing. v1 ships a single implementation,
 * `WorkerChannel`, backed by the Deno Web Worker API (`postMessage` /
 * `onmessage`). The choice is fixed: a worker is only reachable through this
 * API, and the harness must itself be running under Deno.
 */

export type ParentRuntime = "node" | "deno"

export function detectRuntime(): ParentRuntime {
    if (typeof (globalThis as any).Deno !== "undefined") return "deno"
    return "node"
}

/** Handshake signal expected from the worker before MCP envelopes flow. */
export const HANDSHAKE_SIGNAL = "MCP-READY"

/**
 * Minimal handle on a Deno Web Worker. We do not depend on the DOM/Deno lib
 * types (the harness TS config uses `lib: ["esnext"]` + `types: ["node"]`), so
 * the event payloads are typed loosely as `any`. The runtime contract is the
 * Deno Web Worker API: `postMessage`, `addEventListener("message"|"error"|
 * "messageerror")`, `terminate()`.
 */
export interface WorkerLike {
    postMessage(message: any, transfer?: any[]): void
    addEventListener(type: string, listener: (ev: any) => void): void
    terminate(): void
}

export interface InterWorkerChannel extends Transport {
    /** Runtime-specific identifier useful for `status` and logs. */
    readonly channelId: string
}

/** Deno permissions object suitable for `new Worker(specifier, { permissions })`. */
export interface DenoPermissionsObject {
    env?: boolean | string[]
    net?: boolean | string[]
    read?: boolean | string[]
    write?: boolean | string[]
    ffi?: boolean
    hrtime?: boolean
    importDynamic?: boolean
    run?: boolean
    sys?: boolean
    [capability: string]: unknown
}

/**
 * Build the Deno permissions object passed to `new Worker(specifier, { type:
 * "module", permissions })`.
 *
 * Bare entries in `allow` (`"net"`, `"env"`) become `true`; valued entries
 * (`"net=127.0.0.1"`, `"write=./outbox"`) become allowlist arrays. The `env`
 * capability is special: the source of truth is `spec.env` (an allowlist of
 * env var names). When `spec.env` is empty, `permissions.env = false` — the
 * worker cannot read any env var. When populated, it becomes the array.
 * `allow: ["env"]` alone (without a `spec.env` list) is a no-op: env requires
 * the explicit allowlist.
 */
export function denoPermissionsObject(
    allow: readonly string[],
    envAllowlist: readonly string[],
): DenoPermissionsObject {
    const out: DenoPermissionsObject = {}
    // env is the most restrictive: empty list → boolean false; non-empty → allowlist.
    out.env = envAllowlist.length > 0 ? [...envAllowlist] : false

    for (const raw of allow) {
        const v = String(raw).trim()
        if (v.length === 0) continue
        // `env` is governed by the env allowlist, skip it here.
        if (v === "env") continue
        const eq = v.indexOf("=")
        const cap = eq === -1 ? v : v.slice(0, eq)
        if (cap === "env") continue // defensive — env via envAllowlist only
        if (eq === -1) {
            // Bare capability → boolean true (overrides any prior allowlist).
            ;(out as any)[cap] = true
            continue
        }
        const val = v.slice(eq + 1)
        // Valued capability → always merge into an allowlist array.
        const existing = (out as any)[cap]
        if (Array.isArray(existing)) {
            if (!existing.includes(val)) existing.push(val)
        } else {
            ;(out as any)[cap] = [val]
        }
    }
    return out
}

/** Detect whether `entrypoint` is a remote URL (no resolvable filesystem path). */
export function isRemoteEntrypoint(entrypoint: string): boolean {
    return /^(https?|file|npm|jsr):/i.test(entrypoint)
}

/**
 * WorkerChannel — backs an MCP Transport with the Deno Web Worker API.
 * Requires a Deno parent runtime; throws at construction time otherwise.
 *
 * The harness posts JSON-RPC envelopes to the worker via `postMessage(...)` and
 * receives envelopes via the `message` event. One envelope = one message — no
 * byte-stream framing. The worker posts `"MCP-READY"` synchronously once its
 * MCP loop is wired up; `start()` resolves when it arrives (or rejects after
 * `handshakeTimeoutMs`).
 */
export class WorkerChannel implements InterWorkerChannel {
    readonly channelId: string
    onclose?: () => void
    onerror?: (error: Error) => void
    onmessage?: <T extends JSONRPCMessage>(message: T, extra?: any) => void
    sessionId?: string
    setProtocolVersion?: (version: string) => void

    private worker: WorkerLike | null = null
    private ready = false
    private closed = false
    private readonly specifier: string
    private readonly permissions: DenoPermissionsObject
    private readonly handshakeTimeoutMs: number

    constructor(opts: {
        specifier: string
        permissions: DenoPermissionsObject
        handshakeTimeoutMs: number
        channelId: string
    }) {
        this.specifier = opts.specifier
        this.permissions = opts.permissions
        this.handshakeTimeoutMs = opts.handshakeTimeoutMs
        this.channelId = opts.channelId
        if (detectRuntime() !== "deno") {
            throw new Error(
                "McpDenoWorker requires a Deno parent runtime; the harness is currently " +
                "running under a non-Deno runtime (likely Node). Run the harness via " +
                "`deno run` to use McpDenoWorker resources.",
            )
        }
    }

    start(): Promise<void> {
        return new Promise<void>((resolveStart, rejectStart) => {
            let timer: any = null
            try {
                const WorkerCtor = (globalThis as any).Worker
                if (typeof WorkerCtor !== "function") {
                    throw new Error("McpDenoWorker: global Worker constructor not available")
                }
                const worker: WorkerLike = new WorkerCtor(this.specifier, {
                    type: "module",
                    permissions: this.permissions,
                })
                this.worker = worker

                timer = setTimeout(() => {
                    if (!this.ready) {
                        if (timer) clearTimeout(timer)
                        try { worker.terminate() } catch {}
                        rejectStart(new Error(
                            `McpDenoWorker: handshake timeout after ${this.handshakeTimeoutMs}ms ` +
                            `(no "${HANDSHAKE_SIGNAL}" message)`,
                        ))
                    }
                }, this.handshakeTimeoutMs)

                worker.addEventListener("message", (ev: any) => {
                    const data = ev?.data
                    if (!this.ready) {
                        if (data === HANDSHAKE_SIGNAL) {
                            this.ready = true
                            if (timer) { clearTimeout(timer); timer = null }
                            resolveStart()
                        }
                        return
                    }
                    if (data && typeof data === "object" && (data as any).jsonrpc === "2.0") {
                        this.onmessage?.(data as JSONRPCMessage)
                    } else {
                        this.onerror?.(new Error(`McpDenoWorker: non-JSON-RPC message received: ${typeof data}`))
                    }
                })
                worker.addEventListener("error", (ev: any) => {
                    const msg: string = ev?.message ?? String(ev)
                    if (!this.ready) {
                        if (timer) { clearTimeout(timer); timer = null }
                        try { worker.terminate() } catch {}
                        rejectStart(new Error(`McpDenoWorker: worker error before handshake: ${msg}`))
                    } else {
                        this.onerror?.(new Error(msg))
                    }
                })
                worker.addEventListener("messageerror", (ev: any) => {
                    this.onerror?.(new Error(`McpDenoWorker: message deserialization error: ${ev?.data ?? ""}`))
                })
            } catch (err) {
                if (timer) clearTimeout(timer)
                rejectStart(err)
            }
        })
    }

    async send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
        if (!this.worker) throw new Error("McpDenoWorker: cannot send — worker not started")
        if (this.closed) throw new Error("McpDenoWorker: cannot send — channel closed")
        // JSON-RPC envelopes are plain JSON → structurally cloneable. One
        // postMessage call = one envelope = one MCP message.
        this.worker.postMessage(message)
    }

    async close(): Promise<void> {
        if (this.closed) return
        this.closed = true
        try { this.worker?.terminate() } catch {}
        this.worker = null
        this.onclose?.()
    }
}