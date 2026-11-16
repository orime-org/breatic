// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/** Tells OrbitControls camera changes the user made from those the code applied (#920). */
export interface OrbitUserMoveWatch {
  /** OrbitControls `start`: a press, wheel or touch began; it fires before anything moves. */
  start: () => void;
  /** OrbitControls `change`: the camera moved; the damping after the input ends still belongs to it. */
  change: () => void;
  /** Run a camera change the code makes; it is not the user's, and it ends the gesture it interrupts. */
  applying: (fn: () => void) => void;
}

/**
 * Watch OrbitControls for the first camera change the user's own input makes.
 *
 * OrbitControls dispatches `start` on press before any move (three 0.173.0
 * `OrbitControls.js:1320-1324`), so `start` only arms the watch and the first
 * `change` while armed is the move; a click that selects an object never
 * changes the camera and reports nothing.
 * @param onUserMove - Called once per gesture, on its first camera change.
 * @returns The handlers to feed OrbitControls' events into.
 * @throws {never} Never.
 */
export function createOrbitUserMoveWatch(onUserMove: () => void): OrbitUserMoveWatch {
  let armed = false;
  let applyingDepth = 0;
  return {
    start: (): void => { armed = true; },
    change: (): void => {
      if (!armed || applyingDepth > 0) return;
      armed = false;
      onUserMove();
    },
    applying: (fn: () => void): void => {
      armed = false;
      applyingDepth += 1;
      try { fn(); } finally { applyingDepth -= 1; }
    },
  };
}
