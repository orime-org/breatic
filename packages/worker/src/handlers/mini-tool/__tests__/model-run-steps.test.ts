// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The pure rules of the tracking, erase and expand steps (inner#1306 execution design §10.3–§10.5, §10.7), shared by the
 * generic step runner:
 *
 * - `modelStepCategory(error, rejection)`: a paid model step's category, the lip-sync `gen` rule made tool-independent:
 *   400 and 422 at submit and the configured asynchronous rejection are `model_rejected`; a passed deadline, exhausted
 *   network retries, 408, 429 and 5xx are `timeout`; anything else `failed`.
 * - `trackedMaskFailure(step, cause)`: the `{ code, step }` a failed tracking analysis stores; a container step's reason
 *   `empty_foreground` or `tracking_output_mismatch` keeps its name, SAM3 follows `modelStepCategory` with no rejection field.
 * - `eraseContainerCategory(reason)`: `model_output_mismatch` from the composite keeps its name, any other reason is `failed`.
 * - `expandFailureReason(windows, shared)`: a line per window that did not succeed; a window never submitted after a failure
 *   or an expiry is `generate` / `stopped`.
 * - `lipsyncTrackJoinFailureLine(reason)`: a person's `track_join` failure, `empty_foreground` as `track` / `no_face`, anything
 *   else as `track` / `failed`.
 */
import { describe, expect, it } from "vitest";
import { DeadlinePassed, HttpRetryError } from "@breatic/shared";
import { expandFailureReasonSchema } from "@breatic/shared/mini-tools";
import { lipsyncTrackJoinFailureLine } from "@worker/handlers/mini-tool/lipsync-steps.js";
import { eraseContainerCategory, expandFailureReason, modelStepCategory, trackedMaskFailure } from "@worker/handlers/mini-tool/model-run-steps.js";
import { HttpStatusError, UpstreamTaskFailed } from "@worker/providers/http.js";

/**
 * An asynchronous model failure carrying the upstream's error value.
 * @param value - The structured error.
 * @returns The error.
 */
function asyncFailure(value: unknown): UpstreamTaskFailed {
  return Object.assign(new UpstreamTaskFailed("wavespeed", JSON.stringify(value)), { structuredError: value });
}
const BRIA = { path: "code", equals: 1401 };

describe("model step categories (execution design §10.4, §10.5 category tables)", () => {
  it.each([
    ["Bria refusing the submit with 400", new HttpStatusError("wavespeed", 400, "{}"), BRIA, "model_rejected"],
    ["VACE refusing the submit with 422", new HttpStatusError("wavespeed", 422, "{}"), undefined, "model_rejected"],
    ["Bria failing with async code 1401", asyncFailure({ code: 1401 }), BRIA, "model_rejected"],
    ["Bria failing with another code", asyncFailure({ code: 1500 }), BRIA, "failed"],
    ["VACE failing asynchronously", asyncFailure({ code: 1401 }), undefined, "failed"],
    ["a passed deadline", new DeadlinePassed(), BRIA, "timeout"],
    ["exhausted network retries", new HttpRetryError("POST https://api.example.test", 3, new TypeError("fetch failed")), undefined, "timeout"],
    ["a 503", new HttpStatusError("wavespeed", 503, ""), BRIA, "timeout"],
    ["any other error", new Error("boom"), BRIA, "failed"],
  ] as const)("MS01 %s is %s", (_name, error, rejection, category) => {
    expect(modelStepCategory(error, rejection)).toBe(category);
  });
});

describe("tracked mask failure codes (execution design §10.3 code table)", () => {
  it.each([
    ["join", { reason: "empty_foreground" }, { code: "empty_foreground", step: "join" }],
    ["join", { reason: "tracking_output_mismatch" }, { code: "tracking_output_mismatch", step: "join" }],
    ["prepare", { reason: "tool_failed" }, { code: "failed", step: "prepare" }],
    ["track", new HttpStatusError("wavespeed", 400, "{}"), { code: "model_rejected", step: "track" }],
    ["track", asyncFailure({ code: 1405 }), { code: "failed", step: "track" }],
    ["track", new HttpStatusError("wavespeed", 429, ""), { code: "timeout", step: "track" }],
    ["prepare", new DeadlinePassed(), { code: "timeout", step: "prepare" }],
  ] as const)("TM01 a %s failure from %j stores %j", (step, cause, expected) => {
    expect(trackedMaskFailure(step, cause)).toEqual(expected);
  });
});

describe("erase composite category (execution design §10.4 failure table)", () => {
  it.each([["model_output_mismatch", "model_output_mismatch"], ["tool_failed", "failed"], ["empty_foreground", "failed"]] as const)("EC01 %s is %s", (reason, category) => {
    expect(eraseContainerCategory(reason)).toBe(category);
  });
});

describe("expand failure reason (execution design §10.5 failure paragraph)", () => {
  it("EF01 window 3 timed out: windows 4 and 5 never submitted are stopped, done windows are left out", () => {
    const reason = expandFailureReason([
      { windowIndex: 0, state: "done", failure: null }, { windowIndex: 1, state: "done", failure: null }, { windowIndex: 2, state: "done", failure: null },
      { windowIndex: 3, state: "submitted", failure: { step: "generate", category: "timeout" } },
      { windowIndex: 4, state: "unsubmitted", failure: null }, { windowIndex: 5, state: "unsubmitted", failure: null },
    ], null);
    expect(reason).toEqual({ kind: "expand", windows: [
      { windowIndex: 3, step: "generate", category: "timeout" }, { windowIndex: 4, step: "generate", category: "stopped" }, { windowIndex: 5, step: "generate", category: "stopped" },
    ], shared: null });
    expect(expandFailureReasonSchema.safeParse(reason).success).toBe(true);
  });

  it("EF02 a whole-run expiry while window 1 prepared its mask records that step, the rest stopped", () => {
    const reason = expandFailureReason([
      { windowIndex: 0, state: "done", failure: null },
      { windowIndex: 1, state: "unsubmitted", failure: { step: "window_mask", category: "timeout" } },
      { windowIndex: 2, state: "unsubmitted", failure: null },
    ], { step: "expired", category: "timeout" });
    expect(reason).toEqual({ kind: "expand", windows: [
      { windowIndex: 1, step: "window_mask", category: "timeout" }, { windowIndex: 2, step: "generate", category: "stopped" },
    ], shared: { step: "expired", category: "timeout" } });
  });

  it("EF03 a failed composite after every window succeeded lists no window", () => {
    expect(expandFailureReason([{ windowIndex: 0, state: "done", failure: null }], { step: "composite", category: "failed" }))
      .toEqual({ kind: "expand", windows: [], shared: { step: "composite", category: "failed" } });
  });
});

describe("lip-sync track_join failure line (execution design §10.2 last paragraph)", () => {
  it.each([["empty_foreground", "no_face"], ["tracking_output_mismatch", "failed"], ["tool_failed", "failed"]] as const)("LJ01 %s is track / %s", (reason, category) => {
    expect(lipsyncTrackJoinFailureLine(reason)).toEqual({ step: "track", category });
  });
});
