// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/** One independently recoverable Cloudflare Container attempt. */
export interface LongMediaAttemptState {
  attemptId: string;
  epoch: number;
  phase: "queued" | "starting" | "running" | "stopping" | "stopped" | "lost";
}

/** Events reported by the coordinator and Cloudflare Container runtime. */
export type LongMediaAttemptEvent =
  | { type: "start" }
  | { type: "accepted"; epoch: number; attemptId: string }
  | { type: "checkpoint"; epoch: number; attemptId: string }
  | { type: "stop" }
  | { type: "gone"; epoch: number; attemptId: string }
  | { type: "failure"; epoch: number; attemptId: string }
  | { type: "recover"; running: boolean }
  | { type: "restart"; epoch: number; attemptId: string; jobLive: boolean };

/** External actions produced by one attempt event. */
export type LongMediaAttemptEffect = "start" | "destroy";

/** The state committed for one attempt and its required platform actions. */
export interface LongMediaAttemptTransition {
  state: LongMediaAttemptState;
  effects: LongMediaAttemptEffect[];
}

/**
 * Apply one event to a single attempt without allowing stale epochs to mutate it.
 * @param state - The persisted attempt.
 * @param event - The incoming lifecycle event.
 * @returns The next attempt state and external actions.
 */
export function transitionLongMediaAttempt(
  state: LongMediaAttemptState,
  event: LongMediaAttemptEvent,
): LongMediaAttemptTransition {
  if (event.type === "restart") {
    if ((state.phase !== "stopped" && state.phase !== "lost") || !event.jobLive || event.epoch <= state.epoch) {
      return stay(state);
    }
    return { state: { attemptId: event.attemptId, epoch: event.epoch, phase: "queued" }, effects: [] };
  }

  if (event.type === "start") {
    return state.phase === "queued" ? { state: { ...state, phase: "starting" }, effects: ["start"] } : stay(state);
  }

  if (event.type === "stop") {
    if (state.phase === "queued") return { state: { ...state, phase: "stopped" }, effects: [] };
    if (state.phase === "starting" || state.phase === "running" || state.phase === "stopping") {
      return { state: { ...state, phase: "stopping" }, effects: ["destroy"] };
    }
    return stay(state);
  }

  if (event.type === "recover") {
    if (state.phase === "starting" && event.running) return { state: { ...state, phase: "running" }, effects: [] };
    if (state.phase === "starting" && !event.running) return { state: { ...state, phase: "lost" }, effects: [] };
    if (state.phase === "running" && !event.running) return { state: { ...state, phase: "lost" }, effects: [] };
    if (state.phase === "stopping" && !event.running) return { state: { ...state, phase: "stopped" }, effects: [] };
    if (state.phase === "stopping" && event.running) return { state, effects: ["destroy"] };
    return stay(state);
  }

  if (event.epoch !== state.epoch || event.attemptId !== state.attemptId) return stay(state);
  if (event.type === "accepted" && state.phase === "starting") {
    return { state: { ...state, phase: "running" }, effects: [] };
  }
  if (event.type === "gone" && state.phase === "stopping") {
    return { state: { ...state, phase: "stopped" }, effects: [] };
  }
  if (event.type === "failure") {
    if (state.phase === "queued" || state.phase === "starting") {
      return { state: { ...state, phase: "stopped" }, effects: [] };
    }
    if (state.phase === "running" || state.phase === "stopping") {
      return { state: { ...state, phase: "stopping" }, effects: ["destroy"] };
    }
  }
  return stay(state);
}

/**
 * Keep the current attempt when an event is stale or invalid for its phase.
 * @param state - The persisted attempt.
 * @returns The unchanged attempt with no new actions.
 */
function stay(state: LongMediaAttemptState): LongMediaAttemptTransition {
  return { state, effects: [] };
}
