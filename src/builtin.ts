import type { ToolGuide } from "./blueprint.ts"
import type { ObjectManifest } from "./object-meta.ts"
import { INTERACT_TOOLS } from "./interact.ts"
import { AGENT_API_VERSION } from "./api-version.ts"

/**
 * Reserved namespace for Presets published by the harness itself. A user
 * manifest of kind `Preset` whose name lives under this prefix is rejected at
 * load time. See docs/resources.spec.md § "Presets fournis par le harness".
 */
export const HARNESS_PRESET_NAMESPACE = "harness/"

/**
 * Virtual resource name used in `toolset.pattern` to reference tools published
 * by the harness builtin catalogue (e.g. `pattern: "harness/interact__ask"`).
 */
export const HARNESS_RESOURCE_NAME = "harness"

export function isHarnessPresetName(name: string): boolean {
   return name.startsWith(HARNESS_PRESET_NAMESPACE)
}

/**
 * Catalogue of tools published by the harness and referenceable from a toolset
 * via `pattern: "harness/<tool_name>"` (or `pattern: "harness/*"` for all). In
 * v1 the catalogue is exactly the user-board interaction surface
 * (`interact__*`). Resolving an unknown name at load is a fail-fast error (see
 * `validateBuiltinTooling`).
 */
const BUILTIN_TOOLS_BY_NAME = new Map<string, ToolGuide>(
   INTERACT_TOOLS.map((t) => [t.name, t]),
)

export function resolveBuiltinTool(name: string): ToolGuide | undefined {
   return BUILTIN_TOOLS_BY_NAME.get(name)
}

export function listBuiltinToolNames(): string[] {
   return [...BUILTIN_TOOLS_BY_NAME.keys()]
}

/**
 * Walks a list of manifests and throws on any `toolset.tools` entry of the form
 * `harness/<tool>` whose tool name is not in the harness catalogue. Called
 * fail-fast at load, so the runtime resolver can assume every builtin
 * reference is valid. Accepts `tools` as a string or a list of strings.
 */
export function validateBuiltinTooling(manifests: ObjectManifest[]): void {
   for (const m of manifests) {
      const spec = (m as { spec?: { tooling?: unknown[] } }).spec
      const tooling = spec?.tooling
      if (!Array.isArray(tooling)) continue
      for (const entry of tooling) {
         if (
            !entry ||
            typeof entry !== "object" ||
            (entry as { type?: string }).type !== "toolset"
         ) {
            continue
         }
         const tools = (entry as { tools?: string | string[] }).tools
         if (tools === undefined) continue
         const patterns = Array.isArray(tools) ? tools : [tools]
         for (const pattern of patterns) {
            const slash = pattern.indexOf("/")
            if (slash <= 0) continue
            const resourceName = pattern.slice(0, slash).trim()
            if (resourceName !== HARNESS_RESOURCE_NAME) continue
            const tail = pattern.slice(slash + 1).trim()
            if (tail === "*") continue
            for (const name of tail.split(",").map((s) => s.trim())) {
               if (name.length === 0) continue
               if (!resolveBuiltinTool(name)) {
                  throw new Error(
                     `Unknown builtin tool "${name}" in ${m.kind}/${m.metadata.name}. ` +
                        `Known builtins: ${listBuiltinToolNames().join(", ")}.`,
                  )
               }
            }
         }
      }
   }
}

/**
 * Manifests for the harness-provided Presets. Injected by `createBlueprintFrom`
 * alongside the user manifests so they participate in `extends` like any other
 * Preset (same merge rules, same auditability via `status.mergedFrom`).
 */
export function builtinPresetManifests(): ObjectManifest[] {
   return [
      {
         apiVersion: AGENT_API_VERSION,
         kind: "Preset",
         metadata: { name: "harness/conversational" },
         spec: {
            // Single toolset entry with a list of sources — exposes the five
            // interact tools without the noise of one entry per tool.
            tooling: [
               {
                  type: "toolset",
                  tools: [
                     "harness/interact__ask",
                     "harness/interact__confirm",
                     "harness/interact__todo",
                     "harness/interact__notify",
                     "harness/interact__message",
                  ],
               },
            ],
            hooks: {
               on_completion: [{ type: "tooluse", tool: "interact__message" }],
            },
         },
      },
   ]
}
