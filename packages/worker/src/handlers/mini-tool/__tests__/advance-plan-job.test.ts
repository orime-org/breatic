// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as sharedModule from "@breatic/shared";
import type * as coreModule from "@breatic/core";
import type { MiniToolPlanJobRequest } from "@breatic/shared";

const h = vi.hoisted(() => ({ read: vi.fn(), submit: vi.fn(), error: vi.fn(), now: 0 }));
vi.mock("@breatic/shared", async (original) => ({
  ...await original<typeof sharedModule>(), readMiniToolPlanJob: h.read, submitMiniToolPlanJob: h.submit,
}));
vi.mock("@breatic/core", async (original) => ({
  ...await original<typeof coreModule>(),
  env: { INGEST_BASE_URL: "https://ingest.test.invalid", INGEST_SHARED_SECRET: "test-secret" },
  getMiniToolsConfig: () => ({ poll_interval_ms: 5000 }),
  logger: { error: h.error },
}));

import { BodyTooLarge, DEFAULT_TIMEOUT_MS, DeadlinePassed, EmptyBody, HttpRetryError, UploadHttpError, miniToolPlanJobRequestSchema, type UntilDeadline } from "@breatic/shared";
import { advanceMiniToolPlanJob, planReadUntil } from "../advance-plan-job.js";
import { StillRunning } from "@worker/handlers/still-running.js";

const inputId = "20000000-0000-4000-8000-000000000001";
const DEADLINE = 1792920000000;
const GRACE_END = DEADLINE + 10000;
// §93 D5 (frames-split design §7.17 frame row 「不得把presentation ordinal当原解码n」, 「唯一写点：worker的配方构造」): a job frame recipe names a grid frame of its tool source and its PNG target (§7.16).
const plan: MiniToolPlanJobRequest = {
  schemaVersion: 2, jobId: "task:T/chunk:3", containerClass: "OriginalClass", deadlineAt: DEADLINE,
  limits: { probeStdoutBytes: 268435456, analysisStdoutBytes: 16777216, stderrTailBytes: 65536 },
  inputs: [{ inputId, storageKey: "source/video.mp4" }],
  outputs: [
    { outputIndex: 24, storageKey: "result/frame-24.png", contentType: "image/png", recipe: { kind: "frame", inputId, grid: { fps: { numerator: 25, denominator: 1 }, gridStart: { numerator: 0, denominator: 1 }, frameCount: 96, realFrameCount: 96 }, source: { kind: "original", keyframes: { earliestKeyframeTime: 0, maxKeyframeInterval: 1.92, allKeyframes: false } }, frameIndex: 42, target: { width: 32, height: 18, colorMatrix: "bt709", toneMap: "none", pngBitDepth: 8, alpha: "none" } } },
    { outputIndex: 25, storageKey: "result/frame-25.png", contentType: "image/png", recipe: { kind: "frame", inputId, grid: { fps: { numerator: 25, denominator: 1 }, gridStart: { numerator: 0, denominator: 1 }, frameCount: 96, realFrameCount: 96 }, source: { kind: "original", keyframes: { earliestKeyframeTime: 0, maxKeyframeInterval: 1.92, allKeyframes: false } }, frameIndex: 43, target: { width: 32, height: 18, colorMatrix: "bt709", toneMap: "none", pngBitDepth: 8, alpha: "none" } } },
  ],
};
const outputs = [24, 25].map((outputIndex) => ({
  outputIndex, storageKey: `result/frame-${outputIndex}.png`, sha256: "c".repeat(64), sizeBytes: 123,
  contentType: "image/png", width: 32, height: 18, durationSeconds: null, cover: null, upright: null,
}));
const done = { schemaVersion: 2, state: "done", outputs, usage: { wallMs: 1234, cpuUsec: 567890 } } as const;
const failed = { schemaVersion: 2, state: "failed", outputs: outputs.slice(0, 1), reason: "tool_failed", usage: { wallMs: 9876, cpuUsec: null } } as const;

beforeEach(() => {
  vi.resetAllMocks();
  h.now = DEADLINE - 20000;
  vi.spyOn(Date, "now").mockImplementation(() => h.now);
  h.read.mockResolvedValue({ schemaVersion: 2, state: "running" });
  h.submit.mockResolvedValue({ schemaVersion: 2, state: "starting" });
});
afterEach(() => vi.restoreAllMocks());

describe("frozen planned job advancement", () => {
  it.each([done, failed])("returns a read $state report without submitting", async (report) => {
    h.read.mockResolvedValue(report);
    expect(await advanceMiniToolPlanJob(plan)).toEqual(report);
    expect(h.read).toHaveBeenCalledExactlyOnceWith("https://ingest.test.invalid", "test-secret", plan,
      expect.objectContaining({ timeoutMs: DEFAULT_TIMEOUT_MS, signal: expect.any(AbortSignal) }));
    expect(h.submit).not.toHaveBeenCalled();
  });

  it.each(["starting", "running"])("releases the pickup while the report is %s", async (state) => {
    h.read.mockResolvedValue({ schemaVersion: 2, state });
    await expect(advanceMiniToolPlanJob(plan)).rejects.toMatchObject({ name: "StillRunning", resumeAt: DEADLINE - 15000 });
    expect(h.read).toHaveBeenCalledTimes(1);
    expect(h.submit).not.toHaveBeenCalled();
  });

  // A pickup reads every opened attempt before it starts any work (frames-split §7.19): a read that finds no job opens
  // nothing while opening is withheld.
  it("with opening withheld, a job ingest holds no record of is not submitted and answers unopened", async () => {
    h.read.mockResolvedValue(null);
    expect(await advanceMiniToolPlanJob(plan, false)).toEqual({ unopened: true });
    expect(h.submit).not.toHaveBeenCalled();
  });

  it.each([done, failed])("with opening withheld, a read $state report is still returned", async (report) => {
    h.read.mockResolvedValue(report);
    expect(await advanceMiniToolPlanJob(plan, false)).toEqual(report);
  });

  it("submits only the missing original request under the original computation deadline", async () => {
    h.read.mockResolvedValue(null);
    await expect(advanceMiniToolPlanJob(plan)).rejects.toBeInstanceOf(StillRunning);
    expect(h.submit).toHaveBeenCalledExactlyOnceWith("https://ingest.test.invalid", "test-secret", plan,
      expect.objectContaining({ timeoutMs: 20000, signal: expect.any(AbortSignal) }));
    expect(h.read).toHaveBeenCalledTimes(1);
    expect(plan.outputs[0]).toMatchObject({ outputIndex: 24, storageKey: "result/frame-24.png" });
  });

  it("returns the pickup after a submission reports running", async () => {
    h.read.mockResolvedValue(null); h.submit.mockResolvedValue({ schemaVersion: 2, state: "running" });
    await expect(advanceMiniToolPlanJob(plan)).rejects.toBeInstanceOf(StillRunning);
    expect(h.read).toHaveBeenCalledTimes(1); expect(h.submit).toHaveBeenCalledTimes(1);
  });

  it.each([done, failed])("retains a terminal $state answer returned by the original submission", async (report) => {
    h.read.mockResolvedValue(null); h.submit.mockResolvedValue(report);
    expect(await advanceMiniToolPlanJob(plan)).toEqual(report);
    expect(h.submit).toHaveBeenCalledTimes(1);
    expect(h.read).toHaveBeenCalledTimes(1);
  });

  it("retains an explicitly unmeasured failed expense without manufacturing zero", async () => {
    const report = { ...failed, usage: null }; h.read.mockResolvedValue(report);
    expect(await advanceMiniToolPlanJob(plan)).toEqual(report);
    expect(h.submit).not.toHaveBeenCalled();
  });

  it("retains a failed job's completed subset and nonzero measured CPU", async () => {
    const report = { ...failed, usage: { wallMs: 9876, cpuUsec: 123456 } };
    h.read.mockResolvedValue(report);
    expect(await advanceMiniToolPlanJob(plan)).toEqual(report);
    expect(h.submit).not.toHaveBeenCalled();
  });

  it("does not submit when the missing answer crosses the original deadline", async () => {
    h.now = DEADLINE - 1;
    h.read.mockImplementation(async () => { h.now = DEADLINE; return null; });
    await expect(advanceMiniToolPlanJob(plan)).rejects.toBeInstanceOf(DeadlinePassed);
    expect(h.submit).not.toHaveBeenCalled();
  });

  it.each([DEADLINE, GRACE_END - 1, GRACE_END, GRACE_END + 1])("does not open a missing job at %s", async (now) => {
    h.now = now; h.read.mockResolvedValue(null);
    await expect(advanceMiniToolPlanJob(plan)).rejects.toBeInstanceOf(DeadlinePassed);
    expect(h.read).toHaveBeenCalledTimes(1);
    expect(h.submit).not.toHaveBeenCalled();
  });

  it.each([DEADLINE, GRACE_END - 1])("reads an existing nonterminal job inside the final reporting window at %s", async (now) => {
    h.now = now;
    await expect(advanceMiniToolPlanJob(plan)).rejects.toMatchObject({ name: "StillRunning", resumeAt: now + 5000 });
    expect(h.submit).not.toHaveBeenCalled();
  });

  it.each([GRACE_END, GRACE_END + 1])("expires a still-running job at or after the final reporting boundary %s", async (now) => {
    h.now = now;
    await expect(advanceMiniToolPlanJob(plan)).rejects.toBeInstanceOf(DeadlinePassed);
    expect(h.read).toHaveBeenCalledTimes(1);
    expect(h.submit).not.toHaveBeenCalled();
  });

  it.each([done, failed])("retains a final $state report at and after the reporting boundary", async (report) => {
    for (const now of [GRACE_END, GRACE_END + 1]) {
      h.read.mockClear(); h.now = now; h.read.mockResolvedValue(report);
      expect(await advanceMiniToolPlanJob(plan)).toEqual(report);
      expect(h.read).toHaveBeenCalledExactlyOnceWith("https://ingest.test.invalid", "test-secret", plan,
        expect.objectContaining({ timeoutMs: DEFAULT_TIMEOUT_MS, signal: expect.any(AbortSignal) }));
    }
    expect(h.submit).not.toHaveBeenCalled();
  });

  it.each([done, failed])("retains a $state report that arrives across the reporting boundary", async (report) => {
    h.now = GRACE_END - 1;
    h.read.mockImplementation(async () => { h.now = GRACE_END; return report; });
    expect(await advanceMiniToolPlanJob(plan)).toEqual(report);
    expect(h.submit).not.toHaveBeenCalled();
  });

  // A read of what ingest already holds starts no new work, so it is never given less than the transport's own bound: one
  // started 1 ms before the window ends is not cut at the window's end (the still-running check after it stays there).
  it("bounds a read started 1 ms before the reporting window ends by the transport's own bound", () => {
    expect(planReadUntil(DEADLINE, GRACE_END - 1)).toBe(GRACE_END - 1 + DEFAULT_TIMEOUT_MS);
    expect(planReadUntil(DEADLINE, DEADLINE - 3_600_000)).toBe(GRACE_END);
  });

  it.each([done, failed])("returns a $state report whose read starts 1 ms before the reporting window ends and takes 5 ms", async (report) => {
    h.now = GRACE_END - 1;
    // As the real transport: a read that outlasts its bound is aborted with the bound's DeadlinePassed.
    h.read.mockImplementation(async (_base: string, _secret: string, _request: unknown, bound: UntilDeadline | undefined) => {
      h.now += 5;
      if (5 > (bound?.timeoutMs ?? DEFAULT_TIMEOUT_MS)) throw new DeadlinePassed();
      return report;
    });
    expect(await advanceMiniToolPlanJob(plan)).toEqual(report);
    expect(h.submit).not.toHaveBeenCalled();
  });

  it.each([429, 500, 502, 503, 599])("defers a read HTTP%s without submitting or spending a computation retry", async (status) => {
    const error = new UploadHttpError(status); h.read.mockRejectedValue(error);
    await expect(advanceMiniToolPlanJob(plan)).rejects.toBeInstanceOf(StillRunning);
    expect(h.read).toHaveBeenCalledTimes(1);
    expect(h.submit).not.toHaveBeenCalled();
    expect(h.error).toHaveBeenCalledWith(expect.objectContaining({ err: error, ctx: expect.objectContaining({ jobId: plan.jobId, phase: "read" }) }), expect.any(String));
  });

  it.each([429, 500, 503])("defers HTTP%s submission refusal with the same durable identity", async (status) => {
    h.read.mockResolvedValue(null); h.submit.mockRejectedValue(new UploadHttpError(status));
    await expect(advanceMiniToolPlanJob(plan)).rejects.toBeInstanceOf(StillRunning);
    expect(h.submit).toHaveBeenCalledTimes(1);
    expect(h.submit.mock.calls[0]?.[2]).toEqual(plan);
  });

  it.each([new TypeError("fetch failed"), new HttpRetryError("unreachable", 3, new TypeError("fetch failed")), new DOMException("read timed out", "TimeoutError"), new DOMException("read aborted", "AbortError")])("defers a transient read $name without submitting", async (error) => {
    h.read.mockRejectedValue(error);
    await expect(advanceMiniToolPlanJob(plan)).rejects.toBeInstanceOf(StillRunning);
    expect(h.submit).not.toHaveBeenCalled();
  });

  it.each([new UploadHttpError(400), new UploadHttpError(409), new SyntaxError("invalid JSON"), new EmptyBody("empty report"), new Error("invalid report identity")])("preserves a permanent submission failure $name", async (error) => {
    h.read.mockResolvedValue(null); h.submit.mockRejectedValue(error);
    await expect(advanceMiniToolPlanJob(plan)).rejects.toBe(error);
    expect(h.submit).toHaveBeenCalledTimes(1);
  });

  it.each([new UploadHttpError(400), new UploadHttpError(401), new UploadHttpError(403), new UploadHttpError(409), new SyntaxError("invalid JSON"), miniToolPlanJobRequestSchema.safeParse(null).error!, new EmptyBody("empty report"), new BodyTooLarge(100), new Error("invalid report identity")])("preserves a contract or permanent failure $name", async (error) => {
    h.read.mockRejectedValue(error);
    await expect(advanceMiniToolPlanJob(plan)).rejects.toBe(error);
    expect(h.submit).not.toHaveBeenCalled();
  });

  it("expires a failed final read instead of scheduling beyond the reporting boundary", async () => {
    h.now = GRACE_END; h.read.mockRejectedValue(new TypeError("fetch failed"));
    await expect(advanceMiniToolPlanJob(plan)).rejects.toBeInstanceOf(DeadlinePassed);
    expect(h.submit).not.toHaveBeenCalled();
  });

  it.each([null, { schemaVersion: 2, state: "running" }])("checks the reporting boundary again after a pending read", async (answer) => {
    h.now = GRACE_END - 1;
    h.read.mockImplementation(async () => { h.now = GRACE_END; return answer; });
    await expect(advanceMiniToolPlanJob(plan)).rejects.toBeInstanceOf(DeadlinePassed);
    expect(h.read).toHaveBeenCalledTimes(1);
    expect(h.submit).not.toHaveBeenCalled();
  });

  it("expires a transient read error observed across the reporting boundary", async () => {
    h.now = GRACE_END - 1;
    h.read.mockImplementation(async () => { h.now = GRACE_END; throw new TypeError("fetch failed"); });
    await expect(advanceMiniToolPlanJob(plan)).rejects.toBeInstanceOf(DeadlinePassed);
    expect(h.submit).not.toHaveBeenCalled();
  });

  it("retains the diagnostic from an ordinary read timeout observed at the reporting boundary", async () => {
    const error = new Error("transport timeout"); h.now = GRACE_END - 1;
    h.read.mockImplementation(async () => { h.now = GRACE_END; throw error; });
    await expect(advanceMiniToolPlanJob(plan)).rejects.toBeInstanceOf(DeadlinePassed);
    expect(h.error).toHaveBeenCalledWith(expect.objectContaining({ err: error }), expect.any(String));
    expect(h.submit).not.toHaveBeenCalled();
  });

  it.each([new Error("transport timeout"), new TypeError("reply lost"), new UploadHttpError(429), new UploadHttpError(503), new HttpRetryError("reply lost", 3, new TypeError("fetch failed"))])("uses the original computation deadline for a failed submission $name", async (error) => {
    h.now = DEADLINE - 1; h.read.mockResolvedValue(null);
    h.submit.mockImplementation(async () => { h.now = DEADLINE; throw error; });
    await expect(advanceMiniToolPlanJob(plan)).rejects.toBeInstanceOf(DeadlinePassed);
    expect(h.error).toHaveBeenCalledWith(expect.objectContaining({ err: error }), expect.any(String));
    expect(h.submit).toHaveBeenCalledTimes(1);
  });

  it("preserves an elapsed submission deadline instead of returning StillRunning", async () => {
    h.read.mockResolvedValue(null); h.submit.mockRejectedValue(new DeadlinePassed());
    await expect(advanceMiniToolPlanJob(plan)).rejects.toBeInstanceOf(DeadlinePassed);
    expect(h.submit).toHaveBeenCalledTimes(1);
  });

  it("never replaces keys, indices, class, limits or deadline across generated repeated pickups", async () => {
    await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 8 }), async (repeats) => {
      h.read.mockReset(); h.submit.mockReset();
      h.read.mockResolvedValueOnce(null).mockResolvedValue({ schemaVersion: 2, state: "running" });
      h.submit.mockRejectedValueOnce(new TypeError("response lost after accept"));
      const before = structuredClone(plan);
      for (let i = 0; i < repeats; i++) await expect(advanceMiniToolPlanJob(plan)).rejects.toBeInstanceOf(StillRunning);
      h.read.mockResolvedValueOnce(done);
      expect(await advanceMiniToolPlanJob(plan)).toEqual(done);
      expect(h.read).toHaveBeenCalledTimes(repeats + 1);
      expect(h.submit).toHaveBeenCalledTimes(1);
      expect(h.submit.mock.calls[0]?.[2]).toEqual(before);
      expect(plan).toEqual(before);
    }), { numRuns: 20 });
  });

  it("replays an ambiguous submission only with the same frozen request", async () => {
    await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 8 }), async (repeats) => {
      h.read.mockReset(); h.submit.mockReset();
      h.read.mockResolvedValue(null);
      h.submit.mockRejectedValue(new HttpRetryError("reply lost", 3, new TypeError("fetch failed")));
      const before = structuredClone(plan);
      for (let i = 0; i < repeats; i++) await expect(advanceMiniToolPlanJob(plan)).rejects.toBeInstanceOf(StillRunning);
      h.read.mockResolvedValueOnce(done);
      expect(await advanceMiniToolPlanJob(plan)).toEqual(done);
      expect(h.submit).toHaveBeenCalledTimes(repeats);
      expect(h.submit.mock.calls.map((call) => call[2])).toEqual(Array.from({ length: repeats }, () => before));
      expect(plan).toEqual(before);
    }), { numRuns: 20 });
  });
});
