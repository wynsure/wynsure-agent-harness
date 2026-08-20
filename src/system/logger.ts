import pino from "pino"

/** Logging interface the harness host must provide. */
export interface HarnessLoggerConfig {
   logger: pino.Logger
   debugMode: boolean
   /** Called on each context change when debugMode is true. Host decides storage. */
   writeTrace?: (sessionId: string, contextId: string, content: string) => void
}

// ── Mutable state (set via configureLogger) ────────────────────────────

let _configured = false
let _debugMode = true
let _writeTrace: HarnessLoggerConfig["writeTrace"]
let _logger: pino.Logger = pino({ level: "debug" })

/** Inject the host's logging configuration. Must be called before session creation. */
export function configureLogger(config: HarnessLoggerConfig): void {
   _logger = config.logger
   _debugMode = config.debugMode
   _writeTrace = config.writeTrace
   _configured = true
}

export function isLoggerConfigured(): boolean {
   return _configured
}

export const logger: pino.Logger = new Proxy({} as pino.Logger, {
   get(_target, prop) {
      return (_logger as any)[prop]
   },
})

export function getDebugMode(): boolean {
   return _debugMode
}

export function writeTrace(sessionId: string, contextId: string, content: string): void {
   if (!_debugMode || !_writeTrace) return
   _writeTrace(sessionId, contextId, content)
}

export { getDebugMode as isDebugMode }