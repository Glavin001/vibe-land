// Interaction visuals derived from Kinema (MIT). See CREDITS.md at the repo
// root.
//
// Scope (this pass): the client-visual focus + prompt layer only — an
// `IInteractable` interface decoupled from Kinema's client-side RAPIER, a
// shared `setMeshHighlight` utility, and a prompt-label builder.
//
// NOT ported in this pass: concrete interactables (ObjectiveBeacon,
// ThrowableObject, GrabbableObject) because their Kinema implementations
// own their own client-side RAPIER colliders and mutate world state
// locally. vibe-land's architecture is server-authoritative via shared
// Rust/Rapier WASM, so the interaction manager + individual interactables
// need to be (re)implemented on top of vibe-land's physics adapter in a
// follow-up pass.

export {
  type IInteractable,
  type InteractionAccess,
  type InteractionMode,
  type InteractionSpec,
} from './Interactable';
export { setMeshHighlight } from './highlightMesh';
export {
  buildInteractionPromptLabel,
  type PromptLabelOptions,
} from './promptLabel';
