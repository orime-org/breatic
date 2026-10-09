// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The mini-tool job state machine (inner#888 §8.2). The Durable Object holds
 * one job and writes its state only through this function; what the object
 * has to do to the container as a result comes back as effects.
 *
 * Submission and the "already started" answer are handled before a job
 * exists, so they are not events here.
 */

import type { ContainerFailure } from "@shared/mini-tools/types.js";

/** Where a job is. */
export type JobPhase = "starting" | "running" | "done" | "failed";

/** One job's stored state. */
export interface JobState {
  phase: JobPhase;
  /** Which start this is; a deadline set for an earlier one does not touch it. */
  attemptId: string;
  /** The main outputs the job must write, by storage key. */
  outputs: string[];
  /** The main outputs written so far. */
  written: string[];
  /** Epoch ms, taken just before the container started. */
  startedAt: number;
  /** Epoch ms, taken at destroy; null until the job ends. */
  endedAt: number | null;
  /** Why the job failed; null otherwise. */
  reason: ContainerFailure | null;
}

/** Something that happened to a job. */
export type JobEvent =
  | { type: "accepted" }
  | { type: "written"; key: string }
  | { type: "reported"; ok: boolean; reason?: ContainerFailure }
  | { type: "stopped" }
  | { type: "containerGone" }
  | { type: "expired"; attemptId: string }
  | { type: "startFailed" };

/** What the object does to the container after a transition. */
export type JobEffect = "destroy" | "cancelSchedule" | "clearOverrides";

/** A transition's result. */
export interface Transition {
  state: JobState | null;
  effects: JobEffect[];
}

const STAY = (state: JobState | null): Transition => ({ state, effects: [] });

/**
 * End a job, stopping its container and its deadline in the same write.
 * @param state - The job.
 * @param phase - Where it ends.
 * @param now - Epoch ms.
 * @param reason - Why a failed job failed.
 * @returns The ended job and its effects.
 */
function end(state: JobState, phase: "done" | "failed", now: number, reason: ContainerFailure = "tool_failed"): Transition {
  return {
    state: { ...state, phase, endedAt: now, reason: phase === "failed" ? reason : null },
    effects: ["destroy", "cancelSchedule"],
  };
}

/**
 * Apply one event to a job.
 * @param state - The job, or null when none exists.
 * @param event - What happened.
 * @param now - Epoch ms.
 * @returns The next state and the effects to carry out.
 */
export function transition(state: JobState | null, event: JobEvent, now: number): Transition {
  if (state === null || state.phase === "done" || state.phase === "failed") return STAY(state);
  const live = state.phase;
  switch (event.type) {
    case "accepted":
      return live === "starting" ? STAY({ ...state, phase: "running" }) : STAY(state);
    case "written":
      return state.outputs.includes(event.key) && !state.written.includes(event.key)
        ? STAY({ ...state, written: [...state.written, event.key] })
        : STAY(state);
    case "reported": {
      const complete = state.outputs.every((key) => state.written.includes(key));
      return end(state, event.ok && complete ? "done" : "failed", now, event.ok ? undefined : event.reason);
    }
    case "stopped":
    case "containerGone":
      // A stop that reaches a starting job is one the start already answers for.
      return live === "running" ? end(state, "failed", now) : STAY(state);
    case "expired":
      return event.attemptId === state.attemptId ? end(state, "failed", now) : STAY(state);
    case "startFailed":
      return live === "starting" ? { state: null, effects: ["destroy", "clearOverrides", "cancelSchedule"] } : STAY(state);
  }
}
