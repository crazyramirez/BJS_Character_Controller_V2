// ═══════════════════════════════════════════════════════════
// ESM / TypeScript entry point for character-controller.js
// ═══════════════════════════════════════════════════════════
//
// character-controller.js was written for the classic Babylon.js
// browser setup: it expects a global `BABYLON` (and a global
// `HavokPhysics`) and attaches its helpers to `window`.
//
// This wrapper makes it usable from an ESM / TypeScript project
// WITHOUT a build step. It:
//   1. Imports the SAME Babylon build the rest of your app uses.
//   2. Registers the glTF loader (side-effect import) — this is
//      what fixes the "r.addPendingData is not a function" error.
//   3. Exposes Babylon (and Havok) as globals BEFORE the controller
//      runs, then re-exports the controller's public API.
//
// USAGE (TypeScript / ESM):
//   import { setupCharacter, initPhysics } from "./character-controller.module.js";
//
// IMPORTANT: use ONE Babylon build everywhere. Mixing `babylonjs`
// and `@babylonjs/core` causes engine/scene/loader mismatches.
// ═══════════════════════════════════════════════════════════

import * as BABYLON from "@babylonjs/core";
import "@babylonjs/loaders/glTF";

// character-controller.js reads these from the global scope.
globalThis.BABYLON = BABYLON;

// Physics is optional. initPhysics() calls the global HavokPhysics().
// Load it lazily so apps that don't use physics aren't forced to
// install @babylonjs/havok.
try {
  const { default: HavokPhysics } = await import("@babylonjs/havok");
  globalThis.HavokPhysics = HavokPhysics;
} catch {
  // @babylonjs/havok not installed — kinematic mode still works.
}

// Run the controller now that the globals it expects exist.
await import("./character-controller.js");

// Re-export the public API (the controller attached these to window).
export const {
  S,
  ACTION_STATES,
  AnimCtrl,
  CharCtrl,
  normBone,
  cleanAnimName,
  lerp,
  lerpAngle,
  loadCharacterRuntime,
  swapCharacterAnimations,
  setupCharacter,
  loadCharacter,
  initPhysics,
} = globalThis;
