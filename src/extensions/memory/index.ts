// Memory extension — publishes a per-context volatile `<name>__set` /
// `<name>__get` tool pair backed by the context's state leaf (Pattern A).
import "./memory.ts"

export {
   MemoryObject,
   MemorySpecSchema,
   MemoryManifestSchema,
} from "./memory.ts"
export type {
   MemorySpec,
   MemoryManifest,
} from "./memory.ts"
