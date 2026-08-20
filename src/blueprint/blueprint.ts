import { InstructionTemplateCollection } from "./instruction.ts"
import { type ObjectManifest } from "./object-meta.ts"

/**
 * Opaque construction thunk a descriptor may carry instead of the scheme
 * lookup (test/host seam for injecting pre-built objects). Only the runtime
 * knows the real shape (`runtime/scheme.ts` re-types it as `ObjectFactory`);
 * the declaration side stores it uninterpreted so this layer never depends on
 * the runtime.
 */
export type DescriptorFactory = (
   manifest: ObjectManifest,
   ctx: object,
) => unknown

/**
 * ResourceDescriptor — one blueprint entry: a validated manifest plus,
 * for programmatic/test construction, an optional factory override. The
 * descriptor is the shared, immutable unit: a blueprint loaded once can serve
 * any number of sessions, each instantiating its own live objects from these
 * descriptors (see runtime/session.ts).
 */
export interface ResourceDescriptor {
   readonly manifest: ObjectManifest
   readonly factory?: DescriptorFactory
}

/**
 * Blueprint — the shared, declarative half of a load. It holds descriptors
 * (validated manifests) and the instruction collection (whose fs reads are
 * cached per ref), never live resource objects: instantiation — connections,
 * workers, mutable status — happens per session at `AgentSession.create`.
 */
export class Blueprint {
   descriptors: ResourceDescriptor[] = []
   instructions: InstructionTemplateCollection = new InstructionTemplateCollection(
      process.cwd(),
   )

   constructor(instructions?: InstructionTemplateCollection) {
      if (instructions) this.instructions = instructions
   }

   getDescriptor(name: string): ResourceDescriptor | undefined {
      return this.descriptors.find((d) => d.manifest.metadata.name === name)
   }

   /**
    * Register a descriptor. The load path (`createBlueprintFrom`) validates
    * manifests against the scheme before calling this; programmatic callers
    * (tests, hosts building blueprints in code) are trusted and may pass a
    * factory that bypasses the scheme.
    */
   addResource(manifest: ObjectManifest, factory?: DescriptorFactory): void {
      this.descriptors.push({ manifest, factory })
   }
}
