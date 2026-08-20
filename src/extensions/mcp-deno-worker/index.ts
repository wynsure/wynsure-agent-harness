// McpDenoWorker extension — publishes a `<name>__<tool>` surface driven by an
// MCP client over a Deno Web Worker channel (`postMessage`). Connection is
// established eagerly at session instantiation. The kind refuses to
// instantiate under a non-Deno parent runtime — there is no fallback
// transport in v1.
import "./mcp-deno-worker.ts"

export {
    McpDenoWorkerObject,
    McpDenoWorkerSpecSchema,
    McpDenoWorkerManifestSchema,
} from "./mcp-deno-worker.ts"
export type {
    McpDenoWorkerSpec,
    McpDenoWorkerStatus,
    McpDenoWorkerManifest,
} from "./mcp-deno-worker.ts"
export {
    type InterWorkerChannel,
    type ParentRuntime,
    type WorkerLike,
    type DenoPermissionsObject,
    detectRuntime,
    HANDSHAKE_SIGNAL,
    WorkerChannel,
    denoPermissionsObject,
    isRemoteEntrypoint,
} from "./channel.ts"
export {
    jsonSchemaToZod,
    jsonSchemaObjectToZod,
} from "./schema.ts"