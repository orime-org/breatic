// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A video mini-tool's model step through provider (inner#1306 execution design §11.2, §11.4): `advanceGenerate` runs the
 * step's ticket with `runMedia` against the step row, and per answer:
 *
 * - running (`StillRunning`): rethrown, the step not ended;
 * - done: the step ends `returned` with the link and the costs before the link is fetched, then is recorded `done`;
 *   a fetch that fails records the step `failed` and never sends again; a step found `returned` only fetches;
 * - `MediaRunFailed`: the step ends `failed` with its category and the error's costs;
 * - `SendNotAccepted`: counted on the step; under `job_attempts` the step comes back after `job_backoff_delay_ms × 2^n`,
 *   at the last the step ends `timeout`;
 * - any other throw (`NoAnswer`, `DeadlinePassed`): what `costsOf` hands over is appended to the step first, then the
 *   error is rethrown with the ticket and the send mark kept.
 *
 * `runMedia` and the domain's step functions are mocked; the derived-key fetch is the mocked ingest transfer.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as coreModule from "@breatic/core";
import type * as domainModule from "@breatic/domain";
import { SendNotAccepted, UpstreamRequestRejected } from "@breatic/provider";
import { DeadlinePassed } from "@breatic/shared";
import { advanceGenerate, type GenerateStep, type ModelStepRun } from "@worker/handlers/mini-tool/model-run-steps.js";
import { MediaRunFailed } from "@worker/handlers/media-run.js";
import { StillRunning } from "@worker/handlers/still-running.js";

const h = vi.hoisted(() => ({
  list: vi.fn(), ensure: vi.fn(), end: vi.fn(), delivered: vi.fn(), record: vi.fn(), transfer: vi.fn(), refused: vi.fn(), run: vi.fn(),
}));
vi.mock("@breatic/core", async (original) => {
  const actual = await original<typeof coreModule>();
  return { ...actual, getWorkerConfig: (): ReturnType<typeof actual.getWorkerConfig> => ({ ...actual.getWorkerConfig(), job_attempts: 3, job_backoff_delay_ms: 2000 }) };
});
vi.mock("@breatic/domain", async (original) => {
  const actual = await original<typeof domainModule>();
  return { ...actual, endMiniToolModelStep: h.end, appendMiniToolStepDeliveredCosts: h.delivered, recordMiniToolStepResult: h.record,
    recordStepSendNotAccepted: h.refused, backendUploadService: { ...actual.backendUploadService, transferUrlToDerived: h.transfer },
    upstreamStepRepo: { ...actual.upstreamStepRepo, listSteps: h.list, ensureSteps: h.ensure } };
});
vi.mock("@worker/handlers/media-run.js", async (original) => ({ ...await original<Record<string, unknown>>(), runMedia: h.run }));

const TASK = "50000000-0000-4000-8000-000000000002";
const STEP = "60000000-0000-4000-8000-000000000002";
const DEADLINE = Date.now() + 3_600_000;
const LINK = "https://out.example/erased.mp4";
const KNOWN = { state: "known" as const, usd: 0.3, source: "billing" as const };
const RUN: ModelStepRun = { taskId: TASK, projectId: "10000000-0000-4000-8000-000000000002", sourceKey: "video/source.mp4", log: "erase",
  container: { containerClass: "MiniToolContainerStd4", limits: { probeStdoutBytes: 268435456, analysisStdoutBytes: 16777216, stderrTailBytes: 65536 }, chunkRetries: 1 } };
const PLANNED: GenerateStep = {
  model: "bria-video-eraser-mask", itemIndex: 0, stepKey: "erase:0", contentType: "video/mp4", rejection: { path: "code", equals: 1401 },
  input: () => Promise.resolve({ prompt: "", params: { video: "https://cdn.example/v.mp4", mask_video: "https://cdn.example/m.mp4", copy_audio: false } }),
};

/**
 * The step row as `listSteps` reads it.
 * @param status - Its status.
 * @param output - Its output.
 * @returns The row.
 */
function row(status: string, output: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: STEP, taskId: TASK, position: 0, kind: "generate", endpoint: PLANNED.model, itemIndex: 0, status, predictionId: null, output };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.list.mockResolvedValue([row("submitted")]);
  h.end.mockResolvedValue(undefined);
  h.delivered.mockResolvedValue(undefined);
  h.record.mockResolvedValue(undefined);
  h.transfer.mockResolvedValue(undefined);
});

describe("a model step through its ticket", () => {
  it("runs the step's ticket on the step row with the frozen WaveSpeed route", async () => {
    h.run.mockRejectedValue(new StillRunning(Date.now() + 1000));
    await expect(advanceGenerate(RUN, PLANNED, "u", DEADLINE)).rejects.toBeInstanceOf(StillRunning);
    expect(h.run).toHaveBeenCalledWith(expect.objectContaining({ taskId: STEP, model: PLANNED.model, route: { mode: "upstream", upstream: "wavespeed" }, deadlineAt: DEADLINE }), expect.anything());
    expect(h.end).not.toHaveBeenCalled();
  });

  it("ends the step returned with its link and costs before fetching, then records it done", async () => {
    const order: string[] = [];
    h.run.mockResolvedValue({ outputs: [{ kind: "url", url: LINK }], costs: [KNOWN], servedBy: "wavespeed", passedOverCosts: [] });
    h.end.mockImplementation(() => { order.push("end"); return Promise.resolve(); });
    h.transfer.mockImplementation(() => { order.push("fetch"); return Promise.resolve(); });
    h.record.mockImplementation(() => { order.push("record"); return Promise.resolve(); });
    const ended = await advanceGenerate(RUN, PLANNED, "u", DEADLINE);
    expect(order).toEqual(["end", "fetch", "record"]);
    expect(h.end).toHaveBeenCalledWith({ taskId: TASK, stepId: STEP, end: { kind: "returned", link: LINK }, costs: [KNOWN], servedBy: "wavespeed" });
    expect(h.record).toHaveBeenCalledWith(expect.objectContaining({ outcome: "done", identity: { kind: "provider", stepId: STEP } }), expect.anything());
    expect(ended).toEqual({ key: `erase:0:${STEP}` });
  });

  it("records a step whose fetch failed as failed and sends nothing again", async () => {
    h.run.mockResolvedValue({ outputs: [{ kind: "url", url: LINK }], costs: [KNOWN], servedBy: "wavespeed", passedOverCosts: [] });
    h.transfer.mockRejectedValue(new Error("fetch failed"));
    expect(await advanceGenerate(RUN, PLANNED, "u", DEADLINE)).toEqual({ failed: "failed" });
    expect(h.record).toHaveBeenCalledWith(expect.objectContaining({ outcome: "failed" }), expect.anything());
    expect(h.run).toHaveBeenCalledTimes(1);
  });

  it("only fetches a step found returned", async () => {
    h.list.mockResolvedValue([row("returned", { providerReturn: { link: LINK } })]);
    expect(await advanceGenerate(RUN, PLANNED, "u", DEADLINE)).toEqual({ key: `erase:0:${STEP}` });
    expect(h.run).not.toHaveBeenCalled();
    expect(h.transfer).toHaveBeenCalledWith(LINK, expect.objectContaining({ storageKey: `erase:0:${STEP}` }));
  });

  it("ends a step whose done answer has no link as failed", async () => {
    h.run.mockResolvedValue({ outputs: [{ kind: "text", text: "no link" }], costs: [KNOWN], servedBy: "wavespeed", passedOverCosts: [] });
    expect(await advanceGenerate(RUN, PLANNED, "u", DEADLINE)).toEqual({ failed: "failed" });
    expect(h.end).toHaveBeenCalledWith(expect.objectContaining({ end: expect.objectContaining({ kind: "failed", category: "failed" }), costs: [KNOWN] }));
    expect(h.transfer).not.toHaveBeenCalled();
  });

  it("ends a failed run with its category and the error's costs", async () => {
    h.run.mockRejectedValue(new MediaRunFailed(new UpstreamRequestRejected(PLANNED.model, "wavespeed", "bad input", [], { status: 400 }), [KNOWN], "Eraser"));
    expect(await advanceGenerate(RUN, PLANNED, "u", DEADLINE)).toEqual({ failed: "model_rejected" });
    expect(h.end).toHaveBeenCalledWith(expect.objectContaining({ end: expect.objectContaining({ kind: "failed", category: "model_rejected" }), costs: [KNOWN] }));
  });

  it("backs off a send the upstream did not take while attempts remain", async () => {
    h.run.mockRejectedValue(new SendNotAccepted("wavespeed", new Error("busy")));
    h.refused.mockResolvedValue(1);
    const before = Date.now();
    const thrown = await advanceGenerate(RUN, PLANNED, "u", DEADLINE).catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(StillRunning);
    expect((thrown as StillRunning).resumeAt).toBeGreaterThanOrEqual(before + 2000 * 2);
    expect(h.end).not.toHaveBeenCalled();
  });

  it("ends the step timeout once the upstream refused every attempt", async () => {
    h.run.mockRejectedValue(new SendNotAccepted("wavespeed", new Error("busy")));
    h.refused.mockResolvedValue(3);
    expect(await advanceGenerate(RUN, PLANNED, "u", DEADLINE)).toEqual({ failed: "timeout" });
    expect(h.end).toHaveBeenCalledWith(expect.objectContaining({ end: expect.objectContaining({ kind: "failed", category: "timeout" }), costs: [] }));
  });

  it("keeps the costs a cut call handed over, then rethrows with the ticket kept", async () => {
    const cut = new DeadlinePassed(Object.assign(new Error("cut"), { costs: [KNOWN] }));
    h.run.mockRejectedValue(cut);
    await expect(advanceGenerate(RUN, PLANNED, "u", DEADLINE)).rejects.toBe(cut);
    expect(h.delivered).toHaveBeenCalledWith(TASK, STEP, expect.any(Array));
    expect(h.end).not.toHaveBeenCalled();
  });
});
