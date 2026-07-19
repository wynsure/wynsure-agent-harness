/**
 * Steering: a proactive host injection into a context's thread to redirect the
 * agent. Unlike interact__* activities (agent-initiated hand-off) or activity
 * resolution, steering is decided and imposed by the host. See
 * docs/serve.spec.md § "Steering".
 *
 * The primitive lives on AgentSession/AgentContext; this module holds the
 * shared option shape and the busy error the host maps to HTTP 409.
 */

/** Fragment shape a steering injection takes in the thread. */
export type SteeringShape = "user" | "instruction"

export interface SteerOptions {
   /** Fragment to emit: a UserMessage (default) or a system Instruction. */
   as?: SteeringShape
   /**
    * Avort the current completion before injecting. Only a completion
    * (status "thinking") is interruptible; tool execution is not.
    */
   interrupt?: boolean
}

/**
 * Thrown by steer() when the injection cannot be applied because the loop is
 * busy. The HTTP server maps it to 409. Carries a short reason for the client.
 */
export class SteeringBusyError extends Error {
   constructor(public readonly reason: string) {
      super(reason)
      this.name = "SteeringBusyError"
   }
}
