import { z } from "zod"
import type { LabelSelector, } from "../../blueprint/object-meta.ts"
import { labelSelectorMatches } from "../../blueprint/object-meta.ts"
import type { ToolingEntry } from "../../blueprint/blueprint-schema.ts"
import type { AgentSession } from "../session.ts"
import type { ToolGuide } from "../tool.ts"
import { SkillObject } from "./skill.ts"
import { PresetObject } from "./preset.ts"

/**
 * Parse a `toolset.pattern` string `<resource>/<tools>` into its parts. `<tools>`
 * is either `*` (all) or a comma-separated list of tool names. Whitespace
 * around commas is ignored. Throws if the pattern is malformed.
 */
export function parseToolsetPattern(pattern: string): {
   resourceName: string
   toolNames: string[] | null // null means "*"
} {
   const slash = pattern.indexOf("/")
   if (slash <= 0 || slash === pattern.length - 1) {
      throw new Error(
         `Invalid toolset pattern "${pattern}": expected "<resource>/<tools>" where <tools> is "*" or a comma-separated list`,
      )
   }
   const resourceName = pattern.slice(0, slash).trim()
   const tail = pattern.slice(slash + 1).trim()
   if (!resourceName) {
      throw new Error(`Invalid toolset pattern "${pattern}": empty resource name`)
   }
   if (tail === "*") return { resourceName, toolNames: null }
   const toolNames = tail
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
   if (toolNames.length === 0) {
      throw new Error(
         `Invalid toolset pattern "${pattern}": empty tool list (use "*" for all tools)`,
      )
   }
   return { resourceName, toolNames }
}

/**
 * True iff `tool` matches one of the requested names. The match accepts both
 * the full tool name (as exposed to the LLM) and the suffix after
 * `${resourceName}__`, so `pattern: "memory/set"` resolves the tool
 * `memory__set` published by resource `memory`.
 */
function toolMatches(tool: ToolGuide, resourceName: string, requested: string[]): boolean {
   const full = tool.name
   if (requested.includes(full)) return true
   const prefix = `${resourceName}__`
   if (full.startsWith(prefix)) {
      const suffix = full.slice(prefix.length)
      if (requested.includes(suffix)) return true
   }
   return false
}

/**
 * Resolve a single `tools` pattern (`<resource>/<tools>`) against the
 * session's live resources, pushing the matching guides into `out`. Shared by
 * every entry of a `tools: string[]` (and the single-string form, normalized
 * to `[str]` by the caller). There is no virtual/builtin resource: every
 * resource must be declared in the blueprint. Tool-name filtering matches
 * either the full name or the suffix after `${resource}__`.
 */
function resolveToolsPattern(
   pattern: string,
   session: AgentSession,
   out: ToolGuide[],
): void {
   const { resourceName, toolNames } = parseToolsetPattern(pattern)
   const res = session.getResource(resourceName)
   if (res instanceof SkillObject) {
      // Skill activation tool: same shape as before unification.
      out.push({
         name: res.name,
         intent: res.spec?.description ?? res.name,
         input: z.object({}),
      })
      return
   }
   if (res) {
      const all = res.getTools()
      if (toolNames === null) {
         out.push(...all)
      } else {
         out.push(...all.filter((g) => toolMatches(g, resourceName, toolNames)))
      }
      return
   }
   // Legacy inline skill: the resource name resolves to a plain instruction
   // template registered on the collection.
   const instructions = session.blueprint.instructions
   if (instructions.has(resourceName)) {
      const skillTemplate = instructions.get(resourceName)
      out.push({
         name: skillTemplate.name,
         intent: skillTemplate.description ?? "",
         input: z.object({}),
      })
      return
   }
   throw new Error(
      `toolset tools "${pattern}" references unknown resource "${resourceName}"`,
   )
}

/**
 * Materializes the live tool surface from a list of tooling entries against
 * the session's resources. Shared by postures, skills, and the agent's
 * permanent tooling. A `type: "toolset"` entry selects tools in one of two
 * modes:
 *
 *   - `tools: "<resource>/<tools>"` (string or string[]) — one or more named
 *     resources.
 *   - `selector.matchLabels` — multi-resource by label equality AND.
 *
 * A `type: "subagent"` entry exposes a `subagent_<id>` tool with a fixed
 * `task: string` argument. Presets are never selectable.
 */
export function resolveToolingGuides(
   tooling: ToolingEntry[],
   session: AgentSession,
): ToolGuide[] {
   const guides: ToolGuide[] = []
   for (const t of tooling) {
      if (t.type === "toolset") {
         if (t.tools !== undefined) {
            const patterns = Array.isArray(t.tools) ? t.tools : [t.tools]
            for (const p of patterns) {
               resolveToolsPattern(p, session, guides)
            }
            continue
         }
         // selector.matchLabels path (multi-resource).
         const selector = t.selector as LabelSelector
         for (const res of session.resources) {
            if (res instanceof PresetObject) continue
            if (labelSelectorMatches(selector, res.metadata.labels)) {
               guides.push(...res.getTools())
            }
         }
      } else if (t.type === "subagent") {
         guides.push({
            name: `subagent_${t.agent_id}`,
            intent: `Delegate to subagent: ${t.agent_id}`,
            input: z.object({
               task: z.string().describe("The task to delegate to the subagent"),
            }),
         })
      }
   }
   return guides
}

/**
 * Deduplicate guardrail declarations by local `name`. The owner prefix is
 * applied later by the context (a posture may merge guardrails from multiple
 * owners: its own, the agent base, presets); only the local name matters for
 * dedup at this level — the same local name on the same owner is a duplicate.
 * First occurrence wins.
 */
export function dedupGuardrails<T extends { name: string }>(decls: T[]): T[] {
   const seen = new Set<string>()
   const out: T[] = []
   for (const d of decls) {
      if (seen.has(d.name)) continue
      seen.add(d.name)
      out.push(d)
   }
   return out
}
