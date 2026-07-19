import pino from "pino"
import { mkdirSync, writeFileSync } from "fs"
import { resolve, dirname } from "path"

const LOG_PATH = process.env.HARNESS_LOG_PATH
   ? resolve(process.env.HARNESS_LOG_PATH)
   : resolve(process.cwd(), "logs", "agent-harness.log")

mkdirSync(dirname(LOG_PATH), { recursive: true })

const LOG_LEVEL = process.env.HARNESS_LOG_LEVEL ?? "info"

export const isDebugMode =
   LOG_LEVEL === "debug" || process.env.HARNESS_DEBUG === "1"

const DEFAULT_LEVEL = isDebugMode ? "debug" : LOG_LEVEL

function buildLogger(withConsole: boolean): pino.Logger {
   const targets: pino.TransportTargetOptions[] = [
      { target: "pino/file", options: { destination: LOG_PATH, mkdir: true }, level: LOG_LEVEL },
   ]
   if (withConsole) {
      targets.push({
         target: "pino-pretty",
         options: {
            colorize: true,
            translateTime: "HH:MM:ss.l",
            ignore: "pid,hostname",
            singleLine: false,
            destination: 1,
         },
         level: LOG_LEVEL,
      })
   }
   return pino(
      { level: DEFAULT_LEVEL },
      pino.transport({ targets }),
   )
}

/**
 * Pino logger. Defaults to file-only output. Call `enableConsoleLogging()`
 * once (typically from `runServe`) to swap in a multistream logger that
 * also writes to the process console via pino-pretty — useful for
 * operator-facing traces during long-running host processes.
 */
export let logger: pino.Logger = buildLogger(
   process.env.HARNESS_CONSOLE_LOG === "1",
)

/** Re-instantiate the logger with an additional console stream. */
export function enableConsoleLogging(): void {
   logger = buildLogger(true)
}

export const logPath = LOG_PATH

export const logsDir = dirname(LOG_PATH)

export function writeTraceFile(filePath: string, content: string): void {
   if (!isDebugMode) return
   mkdirSync(dirname(filePath), { recursive: true })
   writeFileSync(filePath, content, "utf-8")
}

export function installCrashHandlers() {
   process.on("uncaughtException", (err) => {
      logger.fatal({ err }, "uncaughtException")
      process.stderr.write(`Uncaught exception: ${err.stack ?? err.message}\n`)
      process.stderr.write(`Log written to: ${logPath}\n`)
      process.exit(1)
   })

   process.on("unhandledRejection", (reason) => {
      logger.fatal(
         { err: reason instanceof Error ? reason : { message: String(reason) } },
         "unhandledRejection",
      )
      process.stderr.write(
         `Unhandled rejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}\n`,
      )
      process.stderr.write(`Log written to: ${logPath}\n`)
      process.exit(1)
   })
}