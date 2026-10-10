// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The per-key upright arbiter's state machine (inner#1367 design §4.4).
 *
 * Every finish of one key that reads an orientation of 2-8 asks the same
 * arbiter, and the arbiter writes its state only through this function. Its
 * job is that the object changes at most once, and never after some finish has
 * answered for the bytes as they were: a key is abandoned the moment anyone
 * seals it, gives up on it, or its run fails, and an abandoned key aborts every
 * commit that reaches it. What the arbiter has to do as a result comes back as
 * effects.
 */

import type { MediaMetadata } from "@ingest/media-metadata.js";

/** Where a key's upright stands; a key nobody has asked about has no state. */
export type UprightPhase = "running" | "done" | "abandoned";

/** One key's stored state. */
export interface UprightState {
  phase: UprightPhase;
  /** Whether the run the arbiter awaited has answered. */
  runEnded: boolean;
  /** What the run measured on the written object; null until it does. */
  media: MediaMetadata | null;
}

/** Something that happened to a key. */
export type UprightEvent =
  | { type: "request" }
  | { type: "seal" }
  | { type: "commitAsked" }
  | { type: "commitSettled"; landed: boolean }
  | { type: "runEnded"; media: MediaMetadata | null }
  | { type: "giveUp" };

/** What the arbiter does after a transition. */
export type UprightEffect = "startRun" | "complete" | "abort" | "wake" | "logFailure";

/** A transition's result. */
export interface UprightTransition {
  state: UprightState | null;
  effects: UprightEffect[];
}

const STAY = (state: UprightState | null): UprightTransition => ({ state, effects: [] });

const ABANDON = (state: UprightState): UprightTransition => ({
  state: { ...state, phase: "abandoned" },
  effects: ["logFailure", "wake"],
});

/**
 * Apply one event to a key.
 * @param state - The key's state, or null when nobody has asked about it.
 * @param event - What happened.
 * @returns The next state and the effects to carry out.
 */
export function uprightTransition(state: UprightState | null, event: UprightEvent): UprightTransition {
  if (event.type === "commitAsked") {
    return state?.phase === "running" ? { state, effects: ["complete"] } : { state, effects: ["abort"] };
  }
  if (state === null) {
    if (event.type === "request") return { state: { phase: "running", runEnded: false, media: null }, effects: ["startRun"] };
    if (event.type === "seal") return { state: { phase: "abandoned", runEnded: false, media: null }, effects: ["logFailure"] };
    return STAY(null);
  }
  if (state.phase === "running") return fromRunning(state, event);
  if (state.phase === "done" && event.type === "runEnded" && !state.runEnded) {
    return { state: { ...state, runEnded: true, media: event.media }, effects: ["wake"] };
  }
  return STAY(state);
}

/**
 * Apply one event to a key whose run is still going.
 * @param state - The key, running.
 * @param event - What happened, other than a commit being asked for.
 * @returns The next state and the effects to carry out.
 */
function fromRunning(state: UprightState, event: Exclude<UprightEvent, { type: "commitAsked" }>): UprightTransition {
  switch (event.type) {
    case "request":
    case "seal":
      return STAY(state);
    case "commitSettled":
      return event.landed ? { state: { ...state, phase: "done" }, effects: ["wake"] } : ABANDON(state);
    case "runEnded":
      // The run measures only after its write-back answered 200, so a run that
      // ends while the key is still running never committed.
      return ABANDON({ ...state, runEnded: true });
    case "giveUp":
      return ABANDON(state);
  }
}
