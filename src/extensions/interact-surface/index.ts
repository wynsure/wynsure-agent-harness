// InteractSurface extension — publishes the interact__* tool surface and owns
// the user-facing conversation projection. The split is by responsibility:
//  - `./state.ts`            — the leaf class, the environment + passive
//                               acceptor, the item protocol;
//  - `./items.ts`            — the interact item kinds + the registry
//                               (`registerInteractionItem`, dispatch helpers);
//  - `./interact-surface.ts` — the resource class (kind, factory, applyTool,
//                               session binding, presentation projection);
//  - `./api.ts`              — host UI helpers (read the leaf, drive resolution).
import "./interact-surface.ts"

export {
   InteractSurfaceObject,
   InteractSurfaceSpecSchema,
   InteractSurfaceManifestSchema,
} from "./interact-surface.ts"
export type {
   InteractSurfaceSpec,
   InteractSurfaceManifest,
} from "./interact-surface.ts"

// State + environment
export {
   USER_BOARD_ENVIRONMENT,
   UserBoardEnvironment,
   InteractionStream,
   createPresentation,
} from "./state.ts"
export type {
   NotifyLevel,
   RequestStatus,
   InteractionItemBase,
   PresentationItem,
   UserInputItem,
   CoreInteractionItem,
   InteractionItemExtension,
   InteractionItem,
   InteractionItemDraft,
   InteractionItemEvent,
   InteractionProjectionBase,
} from "./state.ts"

// Interact item kinds + registry (register / lookup / dispatch)
export type {
   AskItem,
   ConfirmItem,
   TodoItem,
   AlertItem,
   PromptItem,
   NotifyItem,
   InteractionKind,
   InteractionItemEntry,
} from "./items.ts"
export {
   registerInteractionItem,
   interactionItemEntry,
   interactionItemEntryByTool,
   interactionItemEntries,
   getInteractTools,
   buildInteractionPayload,
   createInteractionItemDraft,
} from "./items.ts"

// Host UI helpers (read leaf, drive resolution)
export {
   getInteractStream,
   getInteractions,
   pinnedInteractions,
   resolveInteraction,
   failInteraction,
} from "./api.ts"