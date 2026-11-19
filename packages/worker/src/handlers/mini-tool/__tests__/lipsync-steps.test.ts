// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * inner#1306 test plan §97 (execution design §9.3, §9.4; multi-person lip-sync DD §7.1; frames-split §7.15, §7.17): the pure
 * rules of the lip-sync worker steps. The module `@worker/handlers/mini-tool/lipsync-steps.ts` and its function names are
 * the test author's choice (recorded in §97 需要确认); the rules come from the design:
 *
 * - `lipsyncStepCategory(step, error, rejection)`: a model step's failure category. `gen` refused at submit with HTTP 400
 *   or 422 is `model_rejected`; an asynchronous failure whose structured error has `rejection.equals` at `rejection.path`
 *   (the model's configured `async_rejection`, dot path into the error value) is `model_rejected`, any other asynchronous
 *   failure `failed`; a passed deadline, exhausted network retries, 408, 429 and 5xx are `timeout`; anything else is
 *   `failed` (never guessed from error text). Only `gen` can be `model_rejected`.
 * - `lipsyncStepKey(planFingerprint, personId, kind)`: the DD §7.1 step key, a 64-hex digest of the three; the composite
 *   step has no person. `stepObjectKey(stepKey, attemptId)` (model-run-steps): the intermediate object key, the step key, a colon and the
 *   attempt's existing `attemptId` (§97 D17-6: `MiniToolStepAttempt.attemptId` for track and gen, the container attempt's
 *   `attemptId` for container steps).
 * - `lipsyncStoppedLines(people)`: once a person has `no_face` or `model_rejected`, every other person whose paid step
 *   (`track`, `gen`) is not yet submitted gets a `stopped` line on that step and is not submitted; submitted steps settle.
 * - `lipsyncFacesFailureLine(reason)` (§97 D18-3): the person line of a failed `lipsync_faces` job. Its container reports
 *   `empty_foreground` (no tracked foreground over the used range: the track found nobody) → `{ step: "track", category:
 *   "no_face" }`, `no_face` (foreground but no face in any frame) → `{ step: "faces", category: "no_face" }`,
 *   `tracking_output_mismatch` (the track it reads is malformed, as the join's own mismatch) → `{ step: "track", category:
 *   "failed" }`; any other container failure → `{ step: "faces", category: "failed" }`.
 * - `lipsyncFailureReason(people, shared)`: the one CommitFail reason of §9.4, a line per person who did not succeed with
 *   its `detectionNumber`, successful people left out, valid under shared `lipsyncFailureReasonSchema`.
 */
import { describe, expect, it } from "vitest";
import { DeadlinePassed, HttpRetryError } from "@breatic/shared";
import * as miniTools from "@breatic/shared/mini-tools";
import { stepObjectKey } from "@worker/handlers/mini-tool/model-run-steps.js";
import { HttpStatusError, UpstreamTaskFailed } from "@worker/providers/http.js";

type Category = "no_face" | "model_rejected" | "timeout" | "failed" | "stopped";
type PersonStep = "track" | "faces" | "clip" | "stem" | "gen";
type Rejection = { path: string; equals: unknown } | undefined;
type PaidState = "unsubmitted" | "submitted" | "done";
interface PersonState { personId: string; detectionNumber: number; track: PaidState; gen: PaidState; failure: { step: PersonStep; category: Category } | null }
interface Line { personId: string; detectionNumber: number; step: PersonStep; category: Category }
interface StepsApi {
  lipsyncStepCategory: (step: "track" | "gen", error: unknown, rejection: Rejection) => "model_rejected" | "timeout" | "failed";
  lipsyncStepKey: (planFingerprint: string, personId: string | null, kind: PersonStep | "composite") => string;
  lipsyncStoppedLines: (people: readonly PersonState[]) => Line[];
  lipsyncFacesFailureLine: (reason: string) => { step: PersonStep; category: Category };
  lipsyncFailureReason: (people: readonly (PersonState & { succeeded: boolean })[], shared: { step: "prepare" | "composite" | "stitch" | "expired"; category: "timeout" | "failed" } | null) => unknown;
}
const MODULE = "@worker/handlers/mini-tool/lipsync-steps.js";
/**
 * The module under test, loaded by name so this file compiles before it exists.
 * @returns Its exports.
 */
const steps = async (): Promise<StepsApi> => (await import(/* @vite-ignore */ MODULE)) as StepsApi;
const reasonSchema = (miniTools as unknown as { lipsyncFailureReasonSchema: { safeParse: (value: unknown) => { success: boolean } } }).lipsyncFailureReasonSchema;

/**
 * An asynchronous model failure carrying the upstream's error value.
 * @param value - The structured error.
 * @returns The error.
 */
function asyncFailure(value: unknown): UpstreamTaskFailed {
  return Object.assign(new UpstreamTaskFailed("wavespeed", JSON.stringify(value)), { structuredError: value });
}
const REJECTION = { path: "code", equals: "face_not_detected" };

describe("model step failure categories (§97; execution design §9.4 category table)", () => {
  it.each([
    ["gen refused at submit with 400", "gen", new HttpStatusError("wavespeed", 400, "{}"), REJECTION, "model_rejected"],
    ["gen refused at submit with 422", "gen", new HttpStatusError("wavespeed", 422, "{}"), REJECTION, "model_rejected"],
    ["track refused with 400 is not a model rejection", "track", new HttpStatusError("wavespeed", 400, "{}"), undefined, "failed"],
    ["gen failing with the configured rejection field", "gen", asyncFailure({ code: "face_not_detected" }), REJECTION, "model_rejected"],
    ["gen failing at a nested rejection path", "gen", asyncFailure({ detail: { reason: "no_speaker" } }), { path: "detail.reason", equals: "no_speaker" }, "model_rejected"],
    ["gen failing with another structured error", "gen", asyncFailure({ code: "internal" }), REJECTION, "failed"],
    ["gen failing when the model has no rejection field", "gen", asyncFailure({ code: "face_not_detected" }), undefined, "failed"],
    ["text that reads like a rejection is not guessed", "gen", asyncFailure("face_not_detected"), REJECTION, "failed"],
    ["a passed deadline", "gen", new DeadlinePassed(), REJECTION, "timeout"],
    ["exhausted network retries", "track", new HttpRetryError("POST https://api.example.test", 3, new TypeError("fetch failed")), undefined, "timeout"],
    ["a 408", "gen", new HttpStatusError("wavespeed", 408, ""), REJECTION, "timeout"],
    ["a 429", "gen", new HttpStatusError("wavespeed", 429, ""), REJECTION, "timeout"],
    ["a 503", "track", new HttpStatusError("wavespeed", 503, ""), undefined, "timeout"],
    ["any other error", "gen", new Error("boom"), REJECTION, "failed"],
  ] as const)("SC01 %s", async (_name, step, error, rejection, category) => {
    expect((await steps()).lipsyncStepCategory(step, error, rejection)).toBe(category);
  });
});

describe("step keys and intermediate object keys (§97; DD §7.1, frames-split §7.17)", () => {
  it("SK01 a step key is a digest of the plan, the person and the kind, different for each", async () => {
    const { lipsyncStepKey } = await steps();
    const key = lipsyncStepKey("d".repeat(64), "person-1", "gen");
    expect(key).toMatch(/^[a-f0-9]{64}$/);
    expect(lipsyncStepKey("d".repeat(64), "person-1", "gen")).toBe(key);
    expect(new Set([key, lipsyncStepKey("e".repeat(64), "person-1", "gen"), lipsyncStepKey("d".repeat(64), "person-2", "gen"),
      lipsyncStepKey("d".repeat(64), "person-1", "track"), lipsyncStepKey("d".repeat(64), null, "composite")]).size).toBe(5);
  });

  it("SK02 an intermediate object key is the step key, a colon and the attempt's id", () => {
    const first = "70000000-0000-4000-8000-000000000001";
    const second = "70000000-0000-4000-8000-000000000002";
    expect(stepObjectKey("a".repeat(64), first)).toBe(`${"a".repeat(64)}:${first}`);
    expect(stepObjectKey("a".repeat(64), second)).not.toBe(stepObjectKey("a".repeat(64), first));
  });
});

const person = (n: number, track: PaidState, gen: PaidState, failure: PersonState["failure"] = null): PersonState => ({ personId: `person-${n}`, detectionNumber: n, track, gen, failure });

describe("stopping the other people's paid steps (§97; execution design §9.4 stopped row)", () => {
  it.each([
    ["no_face", { step: "faces", category: "no_face" }],
    ["model_rejected", { step: "gen", category: "model_rejected" }],
  ] as const)("ST01 after %s, each other person's first unsubmitted paid step is stopped", async (_name, failure) => {
    const lines = (await steps()).lipsyncStoppedLines([person(1, "done", "unsubmitted", failure), person(2, "unsubmitted", "unsubmitted"), person(3, "done", "unsubmitted")]);
    expect(lines).toEqual([
      { personId: "person-2", detectionNumber: 2, step: "track", category: "stopped" },
      { personId: "person-3", detectionNumber: 3, step: "gen", category: "stopped" },
    ]);
  });

  it("ST02 a person whose paid steps were already submitted settles instead of stopping", async () => {
    expect((await steps()).lipsyncStoppedLines([person(1, "done", "unsubmitted", { step: "faces", category: "no_face" }), person(2, "done", "submitted")])).toEqual([]);
  });

  it.each([
    ["no failure", [person(1, "done", "unsubmitted"), person(2, "unsubmitted", "unsubmitted")]],
    ["only a timeout", [person(1, "done", "done", { step: "gen", category: "timeout" }), person(2, "unsubmitted", "unsubmitted")]],
    ["only a failure", [person(1, "done", "done", { step: "gen", category: "failed" }), person(2, "unsubmitted", "unsubmitted")]],
  ] as const)("ST03 %s stops nobody", async (_name, people) => {
    expect((await steps()).lipsyncStoppedLines(people)).toEqual([]);
  });
});

describe("the person line of a failed faces job (§97 D18-3; execution design §9.4 no_face row)", () => {
  it.each([
    ["empty_foreground", { step: "track", category: "no_face" }],
    ["no_face", { step: "faces", category: "no_face" }],
    ["tracking_output_mismatch", { step: "track", category: "failed" }],
    ["tool_failed", { step: "faces", category: "failed" }],
    ["internal", { step: "faces", category: "failed" }],
  ] as const)("FL01 %s", async (reason, line) => {
    expect((await steps()).lipsyncFacesFailureLine(reason)).toEqual(line);
  });
});

describe("the one CommitFail reason (§97; execution design §9.4)", () => {
  it("FR01 one line per person who did not succeed, with its detection number, and the shared step", async () => {
    const reason = (await steps()).lipsyncFailureReason([
      { ...person(1, "done", "done"), succeeded: true },
      { ...person(2, "done", "done", { step: "gen", category: "timeout" }), succeeded: false },
    ], { step: "stitch", category: "failed" });
    expect(reason).toEqual({ kind: "lipsync", persons: [{ personId: "person-2", detectionNumber: 2, step: "gen", category: "timeout" }], shared: { step: "stitch", category: "failed" } });
    expect(reasonSchema.safeParse(reason).success).toBe(true);
  });

  it("FR02 the stopped people of a blocking failure appear with the blocker", async () => {
    const reason = (await steps()).lipsyncFailureReason([
      { ...person(1, "done", "unsubmitted", { step: "faces", category: "no_face" }), succeeded: false },
      { ...person(2, "unsubmitted", "unsubmitted", { step: "track", category: "stopped" }), succeeded: false },
    ], null);
    expect(reason).toEqual({ kind: "lipsync", shared: null, persons: [
      { personId: "person-1", detectionNumber: 1, step: "faces", category: "no_face" },
      { personId: "person-2", detectionNumber: 2, step: "track", category: "stopped" },
    ] });
  });
});
