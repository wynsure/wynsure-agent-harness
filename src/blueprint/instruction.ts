import { readFileSync } from "fs"
import { resolve } from "path"
import { parseAllDocuments } from "yaml"
import { z } from "zod"
import { renderTemplate } from "./scripting.ts"

export interface InstructionTemplate {
   readonly name: string

   requirement?: {
      tools?: string[]
      variables?: string[]
   }

   readonly description?: string
   readonly policy?: string
   readonly instruction?: string
}

export const InstructionFrontmatterSchema = z
   .object({
      name: z.string().default(""),
      description: z.string().default(""),
      policy: z.string().optional(),
      required_tooling: z.array(z.string()).default([]),
      required_variable: z.array(z.string()).default([]),
      tools: z.array(z.string()).default([]),
      variables: z.array(z.string()).default([]),
   })
   .passthrough()

export type InstructionFrontmatter = z.infer<typeof InstructionFrontmatterSchema>

export function parseFrontmatter(content: string): {
   frontmatter: Record<string, any>
   body: string
} {
   const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
   if (!fmMatch) {
      return { frontmatter: {}, body: content }
   }
   const frontmatter = parseAllDocuments(fmMatch[1])[0]?.toJS() ?? {}
   const body = fmMatch[2]
   return { frontmatter, body }
}

export function resolveRef(
   ref: string,
   cwd: string,
): { frontmatter: Record<string, any>; body: string } {
   const filePath = resolve(cwd, ref)
   const content = readFileSync(filePath, "utf-8")
   return parseFrontmatter(content)
}

function dedup(items: string[]): string[] {
   return [...new Set(items)]
}

function instructionTemplateFromFrontmatter(
   frontmatter: Record<string, any>,
   body: string,
   opts?: { defaultName?: string; source?: string },
): InstructionTemplate {
   const parsed = InstructionFrontmatterSchema.safeParse(frontmatter)
   if (!parsed.success) {
      throw new Error(
         `Invalid frontmatter${opts?.source ? ` in ${opts.source}` : ""}:\n` +
            parsed.error.issues
               .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
               .join("\n"),
      )
   }
   const fm = parsed.data
   const tools = dedup([...(fm.required_tooling ?? []), ...(fm.tools ?? [])])
   const variables = dedup([
      ...(fm.required_variable ?? []),
      ...(fm.variables ?? []),
   ])
   const name = fm.name || opts?.defaultName || ""
   return {
      name,
      requirement: {
         tools,
         variables,
      },
      description: fm.description,
      policy: fm.policy,
      instruction: body.trim(),
   }
}

export function buildInstructionTemplate(
   ref: string,
   cwd: string,
   opts?: { defaultName?: string },
): InstructionTemplate {
   const { frontmatter, body } = resolveRef(ref, cwd)
   return instructionTemplateFromFrontmatter(frontmatter, body, {
      ...opts,
      source: ref,
   })
}

export const InstructionInlineSchema = InstructionFrontmatterSchema.extend({
   content: z.string(),
}).passthrough()

export type InstructionInline = z.infer<typeof InstructionInlineSchema>

export function buildInstructionTemplateFromInline(
   inline: InstructionInline,
   opts?: { defaultName?: string },
): InstructionTemplate {
   const { content, ...frontmatter } = inline
   return instructionTemplateFromFrontmatter(frontmatter, content, opts)
}

export type InstructionRef = string | { $ref: string } | InstructionInline

export function resolveInstructionRef(
   ref: InstructionRef,
   collection: InstructionTemplateCollection,
   opts?: { defaultName?: string },
): InstructionTemplate {
   if (typeof ref === "string") {
      return buildInstructionTemplate(ref, collection.cwd, opts)
   }
   if ("content" in ref) {
      return buildInstructionTemplateFromInline(ref, opts)
   }
   return collection.get(ref.$ref, opts)
}

const TEMPLATE_VAR_PATTERN = /\{\{(\w+)\}\}/g

/**
 * Resolve a `{{expr}}` template against `variables`. The placeholder body is
 * now a real JS expression (so `{{user.role}}`, `{{count + 1}}` work), parsed
 * and evaluated via @jointhedots/scripting. Pure-identifier placeholders from
 * existing blueprints keep working unchanged.
 */
export function resolveInstructionTemplate(
   template: InstructionTemplate,
   variables: Record<string, unknown> = {},
): string {
   const payload = template.instruction ?? ""
   // Quick path: no placeholder, skip parser entirely.
   if (!TEMPLATE_VAR_PATTERN.test(payload)) return payload
   TEMPLATE_VAR_PATTERN.lastIndex = 0
   return renderTemplate(payload, variables)
}

export interface InstructionRequirementCheck {
   ok: boolean
   missingTools: string[]
   missingVariables: string[]
}

export function checkInstructionTemplate(
   template: InstructionTemplate,
   context: {
      availableTools?: string[]
      variables?: string[] | Record<string, unknown>
   },
): InstructionRequirementCheck {
   const requiredTools = template.requirement?.tools ?? []
   const requiredVars = template.requirement?.variables ?? []
   const availableTools = context.availableTools ?? []
   const providedVarNames = Array.isArray(context.variables)
      ? context.variables
      : Object.keys(context.variables ?? {})

   const missingTools = requiredTools.filter((t) => !availableTools.includes(t))
   const missingVariables = requiredVars.filter(
      (v) => !providedVarNames.includes(v),
   )

   return {
      ok: missingTools.length === 0 && missingVariables.length === 0,
      missingTools,
      missingVariables,
   }
}

export class InstructionTemplateCollection {
   private cache = new Map<string, InstructionTemplate>()
   readonly cwd: string

   constructor(cwd: string) {
      this.cwd = cwd
   }

   get(
      ref: string,
      opts?: { defaultName?: string },
   ): InstructionTemplate {
      const cached = this.cache.get(ref)
      if (cached) return cached
      const template = buildInstructionTemplate(ref, this.cwd, opts)
      this.cache.set(ref, template)
      return template
   }

   has(ref: string): boolean {
      return this.cache.has(ref)
   }

   add(ref: string, template: InstructionTemplate): void {
      this.cache.set(ref, template)
   }

   list(): InstructionTemplate[] {
      return [...this.cache.values()]
   }
}

/**
 * Merges a list of instruction templates into a single one, used when a
 * resource `extends` one or more presets. The consumer's own template is the
 * last entry — its name/description/policy win; preset bodies are prepended as
 * foundational context so the resolved instruction stays a single string.
 * Required tools/variables are unioned across every template.
 *
 * `[]` or `[null]`-only inputs return null so an optional instruction stays
 * optional after merging.
 */
export function mergeInstructionTemplates(
   templates: (InstructionTemplate | null | undefined)[],
): InstructionTemplate | null {
   const real = templates.filter(
      (t): t is InstructionTemplate => t != null,
   )
   if (real.length === 0) return null
   const own = real[real.length - 1]
   const presets = real.slice(0, -1)

   const parts = [
      ...presets.map((t) => t.instruction),
      own.instruction,
   ].filter((p): p is string => typeof p === "string" && p.length > 0)
   const body = parts.length > 0 ? parts.join("\n\n") : ""

   const tools = new Set<string>()
   const variables = new Set<string>()
   for (const t of real) {
      for (const tool of t.requirement?.tools ?? []) tools.add(tool)
      for (const v of t.requirement?.variables ?? []) variables.add(v)
   }

   return {
      name: own.name,
      description: own.description ?? presets[0]?.description,
      policy: own.policy ?? presets[0]?.policy,
      instruction: body,
      requirement: {
         tools: [...tools],
         variables: [...variables],
      },
   }
}
