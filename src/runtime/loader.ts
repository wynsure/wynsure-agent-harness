import { readFileSync } from "fs"
import { dirname, resolve } from "path"
import { parseAllDocuments } from "yaml"
import { Blueprint } from "../blueprint/blueprint.ts"
import { InstructionTemplateCollection } from "../blueprint/instruction.ts"
import { validateManifest } from "./scheme.ts"

export function loadAgentBlueprintFrom(path: string): Blueprint {
   const cwd = dirname(resolve(path))
   const content = readFileSync(path, "utf-8")
   const docs = parseAllDocuments(content)
   const rawDescs = docs.map((d) => d.toJS()).filter((d) => d != null)
   return createBlueprintFrom(rawDescs, cwd)
}

/**
 * Validate every manifest and record it as a descriptor. Synchronous and
 * side-effect free: no resource is instantiated here — live objects (MCP
 * connections, workers) are built per session when `AgentSession.create` runs
 * the scheme factories. The harness injects no builtin manifests and owns no
 * reserved namespace: every tool surface and preset must be declared by the
 * blueprint (or by a host that registers kinds into the scheme before load).
 */
export function createBlueprintFrom(
   manifests: unknown[],
   cwd: string,
): Blueprint {
   const blueprint = new Blueprint(new InstructionTemplateCollection(cwd))
   manifests.forEach((m, i) => blueprint.addResource(validateManifest(m, i)))
   return blueprint
}
