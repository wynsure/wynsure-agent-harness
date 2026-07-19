/**
 * Minimal test framework for the agent harness. No external dependency — just
 * enough to script runtime scenarios against a mocked completion service and
 * assert on the resulting thread / events.
 *
 * Run via: `npm test` (tsx src/test/run.ts).
 */

type TestFn = () => Promise<void> | void

interface Case {
   name: string
   fn: TestFn
}
interface Suite {
   name: string
   cases: Case[]
}

const suites: Suite[] = []
let current: Suite | null = null

export function describe(name: string, fn: () => void): void {
   const suite: Suite = { name, cases: [] }
   const prev = current
   current = suite
   try {
      fn()
   } finally {
      current = prev
   }
   suites.push(suite)
}

export function it(name: string, fn: TestFn): void {
   if (!current) throw new Error(`it("${name}") called outside describe()`)
   current.cases.push({ name, fn })
}

export function assert(cond: unknown, msg: string): asserts cond {
   if (!cond) throw new Error(`assertion failed: ${msg}`)
}

export function eq<T>(actual: T, expected: T, msg: string): void {
   const a = JSON.stringify(actual)
   const e = JSON.stringify(expected)
   if (a !== e) {
      throw new Error(`${msg}\n  expected: ${e}\n  actual:   ${a}`)
   }
}

export async function runAll(): Promise<void> {
   let passed = 0
   let failed = 0
   for (const suite of suites) {
      console.log(`\n${suite.name}`)
      for (const c of suite.cases) {
         try {
            await c.fn()
            passed++
            console.log(`  \x1b[32m✓\x1b[0m ${c.name}`)
         } catch (err) {
            failed++
            const msg = err instanceof Error ? err.message : String(err)
            console.log(`  \x1b[31m✗\x1b[0m ${c.name}`)
            for (const line of msg.split("\n")) {
               console.log(`      ${line}`)
            }
         }
      }
   }
   console.log(`\n${passed} passed, ${failed} failed`)
   process.exit(failed > 0 ? 1 : 0)
}
