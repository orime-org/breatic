// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/** Where one durable long media job is in its lifecycle. */
export type LongMediaJobPhase =
  | "accepted"
  | "probing"
  | "planning"
  | "running"
  | "stopping"
  | "done"
  | "failed"
  | "cancelled"
  | "expired";

/** The job facts required to arbitrate lifecycle events. */
export interface LongMediaJobState {
  phase: LongMediaJobPhase;
  version: number;
  deadlineAt: number;
  terminalIntent: "failed" | "cancelled" | "expired" | null;
  activeContainer: boolean;
}

/** An event applied to one persisted job. */
export type LongMediaJobEvent =
  | { type: "start" }
  | { type: "probeOk" }
  | { type: "planAck"; hasRunnableSegments: boolean }
  | { type: "containerStarted" }
  | { type: "needNode" }
  | { type: "seal"; complete: boolean }
  | { type: "retryMedia" }
  | { type: "fatal" }
  | { type: "cancel" }
  | { type: "deadline" }
  | { type: "stopped" };

/** An external action required after the state is committed. */
export type LongMediaJobEffect =
  | "startProbe"
  | "startMediaAttempt"
  | "stopContainer"
  | "checkContainerStopped"
  | "revokePermits"
  | "cancelDeadline";

/** The state and effects returned by a lifecycle transition. */
export interface LongMediaJobTransition {
  state: LongMediaJobState;
  effects: LongMediaJobEffect[];
}

const TERMINAL_PHASES = new Set<LongMediaJobPhase>(["done", "failed", "cancelled", "expired"]);

/**
 * Apply one lifecycle event to a durable media job.
 * @param state - The currently persisted job state.
 * @param event - The event being applied.
 * @param now - The current epoch milliseconds.
 * @returns The next state and effects to persist or perform.
 * @throws {RangeError} When the job version cannot advance safely.
 */
export function transitionLongMediaJob(
  state: LongMediaJobState,
  event: LongMediaJobEvent,
  now: number,
): LongMediaJobTransition {
  if (TERMINAL_PHASES.has(state.phase)) return stay(state);
  if (state.phase === "stopping") {
    if (event.type === "stopped" && state.terminalIntent !== null) {
      return advance(state, {
        phase: state.terminalIntent,
        terminalIntent: state.terminalIntent,
        activeContainer: false,
      }, ["cancelDeadline"]);
    }
    if (event.type === "cancel" || event.type === "deadline" || event.type === "fatal") {
      return stay(state, state.activeContainer ? ["stopContainer"] : []);
    }
    return stay(state);
  }

  if (now >= state.deadlineAt && event.type !== "deadline") {
    if (event.type === "stopped") {
      return advance(
        state,
        { phase: "expired", terminalIntent: "expired", activeContainer: false },
        ["revokePermits", "cancelDeadline"],
      );
    }
    return terminate(state, "expired");
  }

  switch (event.type) {
    case "start":
      return state.phase === "accepted"
        ? advance(state, { phase: "probing" }, ["startProbe"])
        : stay(state);
    case "probeOk":
      return state.phase === "probing"
        ? advance(state, { phase: "planning" }, state.activeContainer ? ["stopContainer"] : [])
        : stay(state);
    case "planAck":
      return state.phase === "planning" || state.phase === "running"
        ? advance(
            state,
            { phase: "running" },
            event.hasRunnableSegments && !state.activeContainer ? ["startMediaAttempt"] : [],
          )
        : stay(state);
    case "containerStarted":
      return state.phase === "probing" || state.phase === "running"
        ? advance(state, { activeContainer: true })
        : stay(state);
    case "needNode":
      return state.phase === "running"
        ? advance(state, { phase: "planning" }, state.activeContainer ? ["stopContainer"] : [])
        : stay(state);
    case "seal":
      return event.complete && (state.phase === "planning" || state.phase === "running") && !state.activeContainer
        ? advance(state, { phase: "done" }, ["cancelDeadline"])
        : stay(state);
    case "retryMedia":
      if (state.phase === "probing" && !state.activeContainer) return advance(state, {}, ["startProbe"]);
      if (state.phase === "running" && !state.activeContainer) return advance(state, {}, ["startMediaAttempt"]);
      return stay(state);
    case "fatal":
      return terminate(state, "failed");
    case "cancel":
      return terminate(state, "cancelled");
    case "deadline":
      return now >= state.deadlineAt ? terminate(state, "expired") : stay(state);
    case "stopped":
      return state.activeContainer ? advance(state, { activeContainer: false }) : stay(state);
  }
}

/**
 * Begin a terminal transition and revoke the current job's write authority.
 * @param state - The live job state.
 * @param intent - The terminal result being established.
 * @returns The stopping or terminal state and required effects.
 */
function terminate(
  state: LongMediaJobState,
  intent: "failed" | "cancelled" | "expired",
): LongMediaJobTransition {
  return advance(
    state,
    { phase: "stopping", terminalIntent: intent },
    ["revokePermits", state.activeContainer ? "stopContainer" : "checkContainerStopped"],
  );
}

/**
 * Advance the durable revision with one state update.
 * @param state - The current job state.
 * @param update - State fields to change.
 * @param effects - Actions to perform after persistence.
 * @returns The incremented job state and effects.
 * @throws {RangeError} When the job version cannot advance safely.
 */
function advance(
  state: LongMediaJobState,
  update: Partial<LongMediaJobState>,
  effects: LongMediaJobEffect[] = [],
): LongMediaJobTransition {
  if (!Number.isSafeInteger(state.version) || state.version < 0 || state.version === Number.MAX_SAFE_INTEGER) {
    throw new RangeError("The long media job version cannot advance safely.");
  }
  return { state: { ...state, ...update, version: state.version + 1 }, effects };
}

/**
 * Keep an event that cannot change the current state.
 * @param state - The current job state.
 * @param effects - Optional idempotent effects to retry.
 * @returns The unchanged state and effects.
 */
function stay(state: LongMediaJobState, effects: LongMediaJobEffect[] = []): LongMediaJobTransition {
  return { state, effects };
}
