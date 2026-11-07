// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The web-animation job and its model-call registry (inner#1711 design §3.7, §6). `WebAnimationContainer` holds one
 * job per job id and writes it only through `transitionWebAnimationJob`, the way the mini-tool object writes through
 * `transition()`: it stores the returned record in one write, then carries out the effects.
 *
 * One model call is in flight at a time. A cancel, the deadline or the container's own final report first puts the
 * job in `stopping`, which refuses new calls; the transition that ends the last open call also ends the job, so the
 * stop, the terminal state and the frozen registry are one record. A terminal record never changes again.
 */

import type { WebAnimationJobCall, WebAnimationJobReport, WebAnimationJobRequest } from "@breatic/shared/space-content";

/** Where a job is. */
export type WebAnimationJobState = WebAnimationJobReport["state"];

/** A state a job ends in. */
type Terminal = "done" | "failed" | "cancelled" | "expired";

/** One call as stored; `outcome` is null while it is open. */
type StoredCall = Omit<WebAnimationJobCall, "outcome"> & { outcome: WebAnimationJobCall["outcome"] | null };

/** One job as the object stores it. */
export interface WebAnimationJobRecord {
  state: WebAnimationJobState;
  /** Null only for the pre-submit cancel marker. */
  request: WebAnimationJobRequest | null;
  /** Epoch ms the pre-submit cancel marker stands until; null for a job. */
  markerUntil: number | null;
  /** How a stopping job ends once its open call has ended. */
  endAs: { state: Terminal; failureReason: string | null } | null;
  phase: WebAnimationJobReport["phase"];
  steps: unknown[];
  calls: StoredCall[];
  outputs: WebAnimationJobReport["outputs"];
  /** Epoch ms the container was asked to start; null when it never was. */
  startedAt: number | null;
  endedAt: number | null;
  cpuUsec: number | null;
  failureReason: string | null;
}

/** Something that happened to a job; the object's RPC methods map onto these one to one. */
export type WebAnimationJobEvent =
  | { type: "submit"; request: WebAnimationJobRequest }
  | { type: "startFailed" }
  | { type: "cancel"; deadlineAt: number }
  | { type: "deadline" }
  | { type: "beginModelCall" }
  | { type: "recordModelCallStart"; seq: number; generationId: string }
  | ({ type: "endModelCall"; seq: number } & Pick<WebAnimationJobCall, "outcome" | "tokens" | "costUsd">)
  | { type: "written"; key: string; sha256: string; bytes: number }
  | { type: "progress"; phase: NonNullable<WebAnimationJobReport["phase"]>; steps: unknown[] }
  | { type: "finished"; ok: boolean; failureReason: string | null; cpuUsec: number | null }
  | { type: "containerGone" };

/** What the object does after a transition: start the container, stop it, or bound the drain of an open call. */
export type WebAnimationJobEffect = "start" | "destroy" | "scheduleDrain";

/** A transition's result. */
export interface WebAnimationTransition {
  record: WebAnimationJobRecord | null;
  effects: WebAnimationJobEffect[];
  /** The seq a `beginModelCall` was given; null for a refused call and every other event. */
  seq: number | null;
  /** True when a submit met the pre-submit cancel marker. */
  refused: boolean;
}

const TERMINAL: ReadonlySet<WebAnimationJobState> = new Set(["done", "failed", "cancelled", "expired"]);

/**
 * The transition that changes nothing.
 * @param record - The record as it is.
 * @returns It, with no effect.
 * @throws {never} Never.
 */
function stay(record: WebAnimationJobRecord | null): WebAnimationTransition {
  return { record, effects: [], seq: null, refused: false };
}

/**
 * A record with nothing in it yet.
 * @param state - Its state.
 * @param request - Its request, or null for the marker.
 * @returns The record.
 * @throws {never} Never.
 */
function blank(state: WebAnimationJobState, request: WebAnimationJobRequest | null): WebAnimationJobRecord {
  return {
    state, request, markerUntil: null, endAs: null, phase: null, steps: [], calls: [], outputs: [],
    startedAt: null, endedAt: null, cpuUsec: null, failureReason: null,
  };
}

/**
 * The open call, if one is in flight.
 * @param record - The job.
 * @returns It, or undefined.
 * @throws {never} Never.
 */
function openCall(record: WebAnimationJobRecord): StoredCall | undefined {
  return record.calls.find((call) => call.outcome === null);
}

/**
 * End a job: every open call is cut off, the container stops, and the record freezes, all in this one transition.
 * @param record - The job.
 * @param state - Where it ends.
 * @param failureReason - Why a failed job failed.
 * @param now - Epoch ms.
 * @returns The ended job and its effects.
 * @throws {never} Never.
 */
function end(record: WebAnimationJobRecord, state: Terminal, failureReason: string | null, now: number): WebAnimationTransition {
  return {
    record: {
      ...record,
      state,
      endAs: null,
      failureReason: state === "failed" ? failureReason : null,
      endedAt: now,
      calls: record.calls.map((call) => (call.outcome === null ? { ...call, outcome: "cut_off" } : call)),
    },
    effects: ["destroy"],
    seq: null,
    refused: false,
  };
}

/**
 * Stop a running job: at once when no call is in flight, otherwise once that call ends.
 * @param record - The running job.
 * @param state - Where it ends.
 * @param failureReason - Why, when it ends failed.
 * @param now - Epoch ms.
 * @returns The transition.
 * @throws {never} Never.
 */
function stop(record: WebAnimationJobRecord, state: Terminal, failureReason: string | null, now: number): WebAnimationTransition {
  if (openCall(record) === undefined) return end(record, state, failureReason, now);
  return { record: { ...record, state: "stopping", endAs: { state, failureReason } }, effects: ["scheduleDrain"], seq: null, refused: false };
}

/**
 * Apply a submit.
 * @param record - The stored record, or null.
 * @param request - The job.
 * @param now - Epoch ms.
 * @returns The transition.
 * @throws {never} Never.
 */
function submit(record: WebAnimationJobRecord | null, request: WebAnimationJobRequest, now: number): WebAnimationTransition {
  if (record !== null && record.state === "cancelled_before_submit" && now < (record.markerUntil ?? 0)) {
    return { ...stay(record), refused: true };
  }
  if (record !== null && record.state !== "cancelled_before_submit") return stay(record);
  if (now >= request.deadlineAt) return stay({ ...blank("expired", request), endedAt: now });
  return { record: { ...blank("running", request), startedAt: now }, effects: ["start"], seq: null, refused: false };
}

/**
 * Apply one event to a job.
 * @param record - The stored record, or null when none exists.
 * @param event - What happened.
 * @param now - Epoch ms.
 * @returns The next record, the effects to carry out, the seq a begun call was given and whether a submit was refused.
 * @throws {never} Never.
 */
export function transitionWebAnimationJob(
  record: WebAnimationJobRecord | null,
  event: WebAnimationJobEvent,
  now: number,
): WebAnimationTransition {
  if (event.type === "submit") return submit(record, event.request, now);
  if (record === null) {
    return event.type === "cancel"
      ? stay({ ...blank("cancelled_before_submit", null), markerUntil: event.deadlineAt })
      : stay(null);
  }
  if (TERMINAL.has(record.state) || record.state === "cancelled_before_submit") return stay(record);
  const running = record.state === "running";
  switch (event.type) {
    case "startFailed":
      return running && record.calls.length === 0 ? { record: null, effects: ["destroy"], seq: null, refused: false } : stay(record);
    case "cancel":
      return running ? stop(record, "cancelled", null, now) : stay(record);
    case "deadline":
      return running ? stop(record, "expired", null, now) : stay(record);
    case "finished": {
      const withCpu = { ...record, cpuUsec: event.cpuUsec };
      if (!running) return stay(withCpu);
      const keys = [record.request?.packageKey, record.request?.manifestKey];
      const complete = keys.every((key) => record.outputs.some((output) => output.key === key));
      if (event.ok && complete) return stop(withCpu, "done", null, now);
      return stop(withCpu, "failed", event.ok ? "output_missing" : (event.failureReason ?? "container_failed"), now);
    }
    case "containerGone":
      return running ? end(record, "failed", "container_gone", now) : end(record, record.endAs?.state ?? "failed", record.endAs?.failureReason ?? null, now);
    case "beginModelCall": {
      if (!running || openCall(record) !== undefined) return stay(record);
      const seq = record.calls.length + 1;
      const call: StoredCall = { seq, generationId: null, tokens: null, costUsd: null, outcome: null };
      return { record: { ...record, calls: [...record.calls, call] }, effects: [], seq, refused: false };
    }
    case "recordModelCallStart": {
      if (openCall(record)?.seq !== event.seq) return stay(record);
      const calls = record.calls.map((call) => (call.seq === event.seq ? { ...call, generationId: event.generationId } : call));
      return stay({ ...record, calls });
    }
    case "endModelCall": {
      if (openCall(record)?.seq !== event.seq) return stay(record);
      const { outcome, tokens, costUsd } = event;
      const ended = { ...record, calls: record.calls.map((call) => (call.seq === event.seq ? { ...call, outcome, tokens, costUsd } : call)) };
      return record.endAs === null ? stay(ended) : end(ended, record.endAs.state, record.endAs.failureReason, now);
    }
    case "written": {
      if (event.key !== record.request?.packageKey && event.key !== record.request?.manifestKey) return stay(record);
      const output = { key: event.key, sha256: event.sha256, bytes: event.bytes };
      const outputs = record.outputs.some((held) => held.key === event.key)
        ? record.outputs.map((held) => (held.key === event.key ? output : held))
        : [...record.outputs, output];
      return stay({ ...record, outputs });
    }
    case "progress":
      return running ? stay({ ...record, phase: event.phase, steps: event.steps }) : stay(record);
  }
}

/**
 * The report a job gives: only ended calls are listed, so a terminal report lists every call it made.
 * @param record - The job, or null.
 * @returns Its report, or null when the object holds no job.
 * @throws {never} Never.
 */
export function reportOfWebAnimationJob(record: WebAnimationJobRecord | null): WebAnimationJobReport | null {
  if (record === null) return null;
  const calls: WebAnimationJobCall[] = [];
  for (const call of record.calls) if (call.outcome !== null) calls.push({ ...call, outcome: call.outcome });
  return {
    state: record.state,
    phase: record.phase,
    steps: record.steps,
    calls,
    container: record.startedAt !== null && record.endedAt !== null
      ? { wallMs: record.endedAt - record.startedAt, cpuUsec: record.cpuUsec }
      : null,
    outputs: record.outputs,
    failureReason: record.failureReason,
  };
}
