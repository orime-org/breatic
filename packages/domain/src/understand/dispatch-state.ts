// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/** Durable queue-delivery states for the current operation wake. */
export type UnderstandDispatchStatus = "pending" | "sent" | "claimed" | "retired";

/** The outbox facts stored inline on one media-understanding operation. */
export interface UnderstandDispatchState {
  /** Current durable delivery state. */
  status: UnderstandDispatchStatus;
  /** Monotonic wake identifier used to construct the stable BullMQ job ID. */
  sequence: number;
  /** Operation revision used for compare-and-set arbitration. */
  revision: number;
  /** Earliest time a pending wake can be sent. */
  dueAtMs: number;
  /** Stable ID for the current sent or claimed wake. */
  jobId?: string;
}

/** A reducer event carrying the evidence for one outbox transition. */
export type UnderstandDispatchEvent =
  | { type: "dispatch"; expectedRevision: number; operationId: string; atMs: number }
  | { type: "send-failure"; expectedRevision: number; retryAtMs: number }
  | { type: "claim"; expectedRevision: number; wakeSequence: number }
  | { type: "lease-lost"; expectedRevision: number; nextDueAtMs: number }
  | { type: "step-ended"; expectedRevision: number; nextDueAtMs: number }
  | { type: "operation-ended"; expectedRevision: number }
  | { type: "approved-handoff"; expectedRevision: number; nextDueAtMs: number };

/**
 * Reduce one durable outbox event without changing the current snapshot.
 * @param state - The current outbox facts persisted on the operation.
 * @param event - The requested event and expected current revision.
 * @returns The next outbox snapshot; stale queue deliveries leave the current wake unchanged.
 * @throws {RangeError} when revisions, sequences, timestamps or transition evidence are invalid.
 */
export function reduceUnderstandDispatch(
  state: UnderstandDispatchState,
  event: UnderstandDispatchEvent,
): UnderstandDispatchState {
  if (
    !Number.isSafeInteger(state.sequence) || state.sequence < 1 ||
    !Number.isSafeInteger(state.revision) || state.revision < 0 ||
    !Number.isFinite(state.dueAtMs) || event.expectedRevision !== state.revision
  ) {
    throw new RangeError("The operation dispatch event has stale or invalid facts.");
  }
  if (event.type === "claim" && event.wakeSequence !== state.sequence) return state;
  if (event.type === "dispatch" && (!event.operationId || !Number.isFinite(event.atMs) || event.atMs < state.dueAtMs)) {
    throw new RangeError("The operation wake is not due or has no stable identity.");
  }
  if (event.type === "send-failure" && !Number.isFinite(event.retryAtMs)) {
    throw new RangeError("The operation wake retry time is invalid.");
  }
  if ((event.type === "lease-lost" || event.type === "step-ended" || event.type === "approved-handoff") && !Number.isFinite(event.nextDueAtMs)) {
    throw new RangeError("The next operation wake time is invalid.");
  }
  if (state.status === "retired") return state;

  switch (event.type) {
    case "dispatch":
      if (state.status !== "pending") return state;
      return next(state, { status: "sent", jobId: `lm_${event.operationId}_${state.sequence}` });
    case "send-failure":
      if (state.status !== "sent") return state;
      return next(state, { status: "pending", dueAtMs: event.retryAtMs, jobId: undefined });
    case "claim":
      if (state.status === "pending" || state.status === "sent") return next(state, { status: "claimed" });
      return state;
    case "lease-lost":
    case "step-ended":
    case "approved-handoff":
      if (state.status !== "claimed") return state;
      return next(state, {
        status: "pending",
        sequence: incrementSequence(state.sequence),
        dueAtMs: event.nextDueAtMs,
        jobId: undefined,
      });
    case "operation-ended":
      return next(state, { status: "retired", jobId: undefined });
  }
}

/**
 * Advance the operation revision while applying a partial outbox update.
 * @param state - The current outbox facts.
 * @param patch - Fields changed by the accepted event.
 * @returns The updated outbox snapshot.
 * @throws {RangeError} when the operation revision cannot increase safely.
 */
function next(
  state: UnderstandDispatchState,
  patch: Partial<UnderstandDispatchState>,
): UnderstandDispatchState {
  if (state.revision === Number.MAX_SAFE_INTEGER) throw new RangeError("The operation revision cannot increase safely.");
  return { ...state, ...patch, revision: state.revision + 1 };
}

/**
 * Increase the current dispatch wake sequence.
 * @param sequence - The current stable wake sequence.
 * @returns The next wake sequence.
 * @throws {RangeError} when the sequence cannot increase safely.
 */
function incrementSequence(sequence: number): number {
  if (sequence === Number.MAX_SAFE_INTEGER) throw new RangeError("The operation dispatch sequence cannot increase safely.");
  return sequence + 1;
}
