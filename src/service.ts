/**
 * ServiceContract — a typed capability key. A resource that implements a
 * capability hands back an instance of `T` when asked for the contract it
 * supports, via `ResourceObject.getService`. Consumers resolve a capability
 * from a resource by contract, without coupling to the concrete kind: the
 * harness asks "give me the thread completion service" and obtains it from
 * whichever resource provides it.
 *
 * A contract is just a stable string id carrying a phantom type parameter for
 * compile-time inference; it carries no runtime behaviour of its own.
 */
export interface ServiceContract<T> {
   readonly id: string
   /** Phantom marker for compile-time inference; never set at runtime. */
   readonly _?: T
}

/** Define a named, typed capability. Ids must be unique process-wide. */
export function defineService<T>(id: string): ServiceContract<T> {
   return { id }
}
