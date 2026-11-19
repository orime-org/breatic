// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The pure rules of the lip-sync steps (execution design §9.3, §9.4; multi-person lip-sync DD §7.1): failure categories,
 * step and intermediate object keys, stopping the other people after a blocking failure, and the one CommitFail reason.
 */
import { DeadlinePassed, HttpRetryError } from "@breatic/shared";
// The step key is the plan's (DD §7.1); admission freezes it on a retry, so it is computed in one place.
export { lipsyncStepKey } from "@breatic/domain";
import type { LipsyncFailureReason } from "@breatic/shared/mini-tools";
import { HttpStatusError, UpstreamTaskFailed } from "@worker/providers/http.js";

/** A failure category of §9.4. */
export type LipsyncCategory = LipsyncFailureReason["persons"][number]["category"];
/** A per-person step of §9.4. */
export type LipsyncPersonStep = LipsyncFailureReason["persons"][number]["step"];
/** A shared step's line of §9.4. */
export type LipsyncSharedLine = NonNullable<LipsyncFailureReason["shared"]>;
/** Where a paid step (`track`, `gen`) is. */
export type LipsyncPaidState = "unsubmitted" | "submitted" | "done";
/** The model's configured asynchronous rejection field: a dot path into the structured error and the value it holds. */
export interface LipsyncAsyncRejection { path: string; equals: unknown }
/** One person's progress through the steps. */
export interface LipsyncPersonState {
  personId: string;
  detectionNumber: number;
  track: LipsyncPaidState;
  gen: LipsyncPaidState;
  failure: { step: LipsyncPersonStep; category: LipsyncCategory } | null;
}
/** One person line of the failure reason. */
export type LipsyncPersonLine = LipsyncFailureReason["persons"][number];

/**
 * Read a dot path inside a structured error value.
 * @param value - The structured error.
 * @param path - The dot path.
 * @returns The value there, or undefined.
 * @throws {never} Never.
 */
function atPath(value: unknown, path: string): unknown {
  let current = value;
  for (const key of path.split(".")) {
    if (current === null || typeof current !== "object" || !(key in current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/**
 * A model step's failure category (§9.4 category table); never guessed from error text.
 * @param step - The paid step that failed.
 * @param error - What it threw.
 * @param rejection - The selected model's `async_rejection`, when it has one.
 * @returns The category.
 * @throws {never} Never.
 */
export function lipsyncStepCategory(step: "track" | "gen", error: unknown, rejection: LipsyncAsyncRejection | undefined): "model_rejected" | "timeout" | "failed" {
  if (error instanceof DeadlinePassed || error instanceof HttpRetryError) return "timeout";
  if (error instanceof HttpStatusError) {
    if (error.status === 408 || error.status === 429 || error.status >= 500) return "timeout";
    return step === "gen" && (error.status === 400 || error.status === 422) ? "model_rejected" : "failed";
  }
  if (error instanceof UpstreamTaskFailed && step === "gen" && rejection !== undefined
    && atPath(error.structuredError, rejection.path) === rejection.equals) return "model_rejected";
  return "failed";
}

/**
 * After a `no_face` or `model_rejected`, the `stopped` line of each other person's first unsubmitted paid step (§9.4
 * stopped row); a step already submitted settles on its own.
 * @param people - Every person's progress.
 * @returns The lines to record; those steps are not submitted.
 * @throws {never} Never.
 */
export function lipsyncStoppedLines(people: readonly LipsyncPersonState[]): LipsyncPersonLine[] {
  const blocked = people.some((p) => p.failure?.category === "no_face" || p.failure?.category === "model_rejected");
  if (!blocked) return [];
  return people.flatMap((p): LipsyncPersonLine[] => {
    if (p.failure !== null) return [];
    const step = p.track === "unsubmitted" ? "track" : p.track === "done" && p.gen === "unsubmitted" ? "gen" : null;
    return step === null ? [] : [{ personId: p.personId, detectionNumber: p.detectionNumber, step, category: "stopped" }];
  });
}

/**
 * The person line of a failed `lipsync_faces` job (§97 D18-3): a track with no foreground or one the container cannot read
 * is the track step's, as the join's own `empty_foreground` and `tracking_output_mismatch` are (execution design §10.2).
 * @param reason - The container's failure reason.
 * @returns The step and category to record.
 * @throws {never} Never.
 */
export function lipsyncFacesFailureLine(reason: string): { step: LipsyncPersonStep; category: LipsyncCategory } {
  if (reason === "empty_foreground") return { step: "track", category: "no_face" };
  if (reason === "tracking_output_mismatch") return { step: "track", category: "failed" };
  return { step: "faces", category: reason === "no_face" ? "no_face" : "failed" };
}

/**
 * The person line of a failed `track_join` job (execution design §10.2): no foreground over the range means the track found
 * nobody; any other failure of the join is `failed`.
 * @param reason - The container's failure reason.
 * @returns The step and category to record.
 * @throws {never} Never.
 */
export function lipsyncTrackJoinFailureLine(reason: string): { step: LipsyncPersonStep; category: LipsyncCategory } {
  return { step: "track", category: reason === "empty_foreground" ? "no_face" : "failed" };
}

/**
 * The one CommitFail reason of §9.4: a line per person who did not succeed, and the shared step's line.
 * @param people - Every person's progress and whether it succeeded.
 * @param shared - The failed shared step, or null.
 * @returns The reason.
 * @throws {never} Never.
 */
export function lipsyncFailureReason(people: readonly (LipsyncPersonState & { succeeded: boolean })[], shared: LipsyncSharedLine | null): LipsyncFailureReason {
  const persons = people.flatMap((p): LipsyncPersonLine[] => p.succeeded || p.failure === null ? []
    : [{ personId: p.personId, detectionNumber: p.detectionNumber, step: p.failure.step, category: p.failure.category }]);
  return { kind: "lipsync", persons, shared };
}
