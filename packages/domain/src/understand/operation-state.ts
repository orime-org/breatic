// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/** Lifecycle states for one persisted media-understanding operation. */
export type UnderstandOperationStatus =
  | "queued"
  | "running"
  | "blocked"
  | "ready"
  | "partial"
  | "failed"
  | "cancelled"
  | "expired";

/** The lifecycle facts needed to reduce one operation event. */
export interface UnderstandOperationState {
  /** Current lifecycle status. */
  status: UnderstandOperationStatus;
  /** Monotonic compare-and-set revision. */
  revision: number;
  /** Immutable absolute operation deadline in epoch milliseconds. */
  deadlineAtMs: number;
}

/** One lifecycle event with the evidence required for its transition. */
export type UnderstandOperationEvent =
  | { type: "claim" | "unknown" | "cancel-applied" | "deadline"; expectedRevision: number; atMs: number }
  | { type: "advance"; expectedRevision: number; atMs: number; resolvesUnknown?: boolean }
  | { type: "finish"; expectedRevision: number; atMs: number; completeCoverage: boolean }
  | { type: "fatal"; expectedRevision: number; atMs: number; hasUsableEvidence: boolean }
  | { type: "user-retry"; expectedRevision: number; atMs: number; approved: boolean };

const TERMINAL = new Set<UnderstandOperationStatus>(["ready", "partial", "failed", "cancelled", "expired"]);

/**
 * Reduce a lifecycle event without mutating the persisted state snapshot.
 * @param state - The current operation lifecycle facts.
 * @param event - The expected revision, event time and event-specific evidence.
 * @returns The next lifecycle snapshot, or the same snapshot for an idempotent terminal event.
 * @throws {RangeError} when the revision is stale, the event is invalid, or new work crosses the deadline.
 */
export function reduceUnderstandOperation(
  state: UnderstandOperationState,
  event: UnderstandOperationEvent,
): UnderstandOperationState {
  if (
    !Number.isSafeInteger(state.revision) || state.revision < 0 ||
    !Number.isFinite(state.deadlineAtMs) ||
    event.expectedRevision !== state.revision ||
    !Number.isFinite(event.atMs)
  ) {
    throw new RangeError("The operation event has stale or invalid lifecycle facts.");
  }
  if (TERMINAL.has(state.status)) return state;
  if (event.type === "deadline") {
    if (event.atMs < state.deadlineAtMs) throw new RangeError("The operation deadline has not been reached.");
    return next(state, "expired");
  }
  if (event.atMs >= state.deadlineAtMs) throw new RangeError("The operation deadline has passed.");

  switch (event.type) {
    case "claim":
      if (state.status === "queued") return next(state, "running");
      if (state.status === "running" || state.status === "blocked") return state;
      throw new RangeError(`Cannot claim an operation in ${state.status}.`);
    case "advance":
      if (state.status === "queued" || state.status === "running") return next(state, "running");
      if (state.status === "blocked" && event.resolvesUnknown === true) return next(state, "running");
      if (state.status === "blocked") throw new RangeError("An unknown outcome must be resolved before work advances.");
      throw new RangeError(`Cannot advance an operation in ${state.status}.`);
    case "unknown":
      if (state.status === "queued" || state.status === "running" || state.status === "blocked") {
        return state.status === "blocked" ? state : next(state, "blocked");
      }
      throw new RangeError(`Cannot block an operation in ${state.status}.`);
    case "finish":
      if (state.status !== "running" && state.status !== "blocked" && state.status !== "queued") {
        throw new RangeError(`Cannot finish an operation in ${state.status}.`);
      }
      return next(state, event.completeCoverage ? "ready" : "partial");
    case "fatal":
      if (state.status !== "running" && state.status !== "blocked" && state.status !== "queued") {
        throw new RangeError(`Cannot fail an operation in ${state.status}.`);
      }
      return next(state, event.hasUsableEvidence ? "partial" : "failed");
    case "cancel-applied":
      if (state.status !== "queued" && state.status !== "running" && state.status !== "blocked") {
        throw new RangeError(`Cannot cancel an operation in ${state.status}.`);
      }
      return next(state, "cancelled");
    case "user-retry":
      if (state.status !== "blocked" || !event.approved) {
        throw new RangeError("An unknown outcome can resume only after an explicit user approval.");
      }
      return next(state, "queued");
  }
}

/**
 * Advance the compare-and-set revision with one lifecycle status.
 * @param state - The current lifecycle snapshot.
 * @param status - The status accepted by the event reducer.
 * @returns A new lifecycle snapshot.
 * @throws {RangeError} when the revision can no longer increase safely.
 */
function next(state: UnderstandOperationState, status: UnderstandOperationStatus): UnderstandOperationState {
  if (state.revision === Number.MAX_SAFE_INTEGER) throw new RangeError("The operation revision cannot increase safely.");
  return { ...state, status, revision: state.revision + 1 };
}
