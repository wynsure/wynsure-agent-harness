import { type ZodType, type ZodTypeAny, z, toJSONSchema } from "zod"

export interface ToolGuide<TInput = any, TOutput = any> {
   readonly name: ToolName
   readonly intent?: string
   readonly input?: ZodType<TInput>
   readonly output?: ZodType<TOutput>
}

/** Name of a tool (a `ToolGuide.name`, matched against `ToolUse`/`ToolFeedback`). */
export type ToolName = string

export function defineTool<TInput>(
   name: string,
   intent: string,
   input?: ZodType<TInput>,
): ToolGuide<TInput> {
   return { name, intent, input }
}

const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/

export function validateToolGuideName(name: string): void {
   if (!TOOL_NAME_PATTERN.test(name)) {
      throw new Error(
         `Invalid tool name "${name}": must match pattern ^[a-zA-Z0-9_-]+$. ` +
            `Slashes, spaces, dots and other special characters are not allowed.`,
      )
   }
}

export function validateToolGuides(guides: ToolGuide[]): void {
   for (const g of guides) {
      validateToolGuideName(g.name)
   }
}

function toolingParamsToZod(params: unknown): ZodTypeAny {
   if (!params) return z.object({})
   if (Array.isArray(params)) {
      const shape: Record<string, z.ZodTypeAny> = {}
      for (let i = 0; i < params.length; i++) {
         const p = params[i]
         if (typeof p === "string") {
            shape[`arg${i}`] = z.string()
         } else if (p && typeof p === "object" && (p as any).name) {
            shape[(p as any).name] = (p as any).type === "string" ? z.string() : z.any()
         } else if (p && typeof p === "object") {
            shape[`arg${i}`] = z.any()
         }
      }
      return z.object(shape)
   }
   return z.any()
}

/** Project a tooling entry list onto its local `type: route` guides. */
export function toolingToToolGuide(tooling: any[]): ToolGuide[] {
   const guides: ToolGuide[] = []
   for (const t of tooling) {
      if (t.type === "route") {
         guides.push({
            name: t.name,
            intent: t.description ?? `Route to posture ${t.posture}`,
            input: toolingParamsToZod(t.params),
         })
      }
   }
   return guides
}

export function toolGuideToJsonSchema(tool: ToolGuide): Record<string, any> {
   if (!tool.input) return { type: "object", properties: {} }
   return toJSONSchema(tool.input as ZodTypeAny) as Record<string, any>
}
