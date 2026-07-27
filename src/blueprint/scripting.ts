/**
 * Single evaluation entrypoint for the harness: interpolates `{{expr}}`
 * templates and evaluates boolean expressions using @jointhedots/scripting.
 *
 * Both rely on the same `LocalScope` view of the variables exposed to guards,
 * instructions and templates: the tool `args`, the per-context `memory` (read
 * only), and the legacy instruction variables (`cwd`, `sessionId`, `agentName`,
 * `currentPosture`). The `{{...}}` syntax (CurlyCurly) is preserved so legacy
 * `{{sessionId}}` placeholders keep working — they are now parsed as JS
 * identifier expressions.
 */
import * as acorn from "acorn"
import {
   EmbedSyntax,
   EmptyScope,
   LocalScope,
   evaluateExpression,
   parseTextTemplate,
} from "@jointhedots/scripting"

export type Scope = Record<string, unknown>

/**
 * Render a `{{expr}}` template against `vars`. The expression inside each
 * placeholder is evaluated as JavaScript in a scope built from `vars`. Throws
 * if a placeholder fails to parse or evaluates to a throw.
 */
export function renderTemplate(pattern: string, vars: Scope = {}): string {
   const tpl = parseTextTemplate(pattern, EmbedSyntax.CurlyCurly)
   return tpl.evaluate({ vars, encoder: stringifyValue })
}

/**
 * Evaluate a JS expression that must reduce to a boolean. Used by guardrail
 * `when` clauses. The expression is parsed with acorn (single Expression) and
 * evaluated against `vars` via the @jointhedots/scripting interpreter.
 */
export function evaluateCondition(expr: string, vars: Scope = {}): boolean {
   const ast = parseExpression(expr)
   const scope = new LocalScope(EmptyScope, undefined, vars)
   const value = evaluateExpression(ast as any, scope)
   return Boolean(value)
}

/**
 * Parse a single JS expression (no statements, no program). Throws a readable
 * error pointing at the expression if parsing fails. Exported so other modules
 * (guardrail inputs validation) can rewalk the AST without re-implementing the
 * trailing-input check.
 */
export function parseExpression(expr: string): acorn.Expression {
   // parseExpressionAt parses a single Expression starting at offset 0 and
   // stops there; we then ensure the remaining input is whitespace only so a
   // stray `a b` is rejected instead of silently dropping `b`.
   const node = acorn.parseExpressionAt(expr, 0, {
      ecmaVersion: 2022,
      allowReturnOutsideFunction: false,
   }) as acorn.Expression

   // Skip trailing whitespace and require the whole input was consumed;
   // acorn stops at the first valid expression otherwise.
   const remaining = expr.slice(node.end ?? expr.length).trim()
   if (remaining.length > 0) {
      throw new SyntaxError(
         `Unexpected trailing input after expression: ${JSON.stringify(remaining)}`,
      )
   }
   return node
}

function stringifyValue(value: unknown): string {
   if (value === null || value === undefined) return ""
   if (typeof value === "string") return value
   if (typeof value === "number" || typeof value === "boolean") return String(value)
   try {
      return JSON.stringify(value)
   } catch {
      return String(value)
   }
}
