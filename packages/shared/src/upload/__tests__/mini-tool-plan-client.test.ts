// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";
import * as shared from "@shared/index.js";
import type { MiniToolPlanJobReport } from "../mini-tool-plan-job.js";
import type { UntilDeadline } from "../../http/deadline.js";
import type * as requestModule from "../../http/request.js";

const { send } = vi.hoisted(() => ({ send: vi.fn<(...args: unknown[]) => Promise<Response>>() }));
vi.mock("@shared/http/request.js", async (importOriginal) => ({
  ...await importOriginal<typeof requestModule>(), httpRequest: send,
}));

const baseUrl = "https://ingest.test.invalid";
const inputId = "20000000-0000-4000-8000-000000000001";
// frames-split design §7.17 frame row (「唯一写点：worker的配方构造」): a job frame recipe names the grid, the tool source, the grid
// frame number and its PNG target.
const request = {
  schemaVersion: 2, jobId: "task:T/chunk:1", containerClass: "MediaContainer",
  deadlineAt: 1792920000000,
  limits: { probeStdoutBytes: 268435456, analysisStdoutBytes: 16777216, stderrTailBytes: 65536 },
  inputs: [{ inputId, storageKey: "source/video.mp4" }],
  outputs: [{ outputIndex: 8, storageKey: "result/frame-8.png", contentType: "image/png", recipe: {
    kind: "frame", inputId, grid: { fps: { numerator: 25, denominator: 1 }, gridStart: { numerator: 0, denominator: 1 }, frameCount: 125, realFrameCount: 125 },
    source: { kind: "original", keyframes: { earliestKeyframeTime: 0, maxKeyframeInterval: 2, allKeyframes: false } }, frameIndex: 42,
    target: { width: 32, height: 18, colorMatrix: "bt709", toneMap: "none", pngBitDepth: 8, alpha: "none" },
  } }],
};
const output = {
  outputIndex: 8, storageKey: "result/frame-8.png", sha256: "c".repeat(64), sizeBytes: 123,
  contentType: "image/png", width: 32, height: 18, durationSeconds: null, cover: null, upright: null,
};
const usage = { wallMs: 1000, cpuUsec: 100000 };
const done = { schemaVersion: 2, state: "done", outputs: [output], usage };
type PlanClient = (baseUrl: string, secret: string, job: unknown, bound?: UntilDeadline) => Promise<MiniToolPlanJobReport | null>;

/**
 * Reach the typed client through the same public module as the real worker.
 * @param method - The independently required transport entry.
 * @returns Its callable interface once exported.
 * @throws {Error} When the public entry has not been implemented.
 */
function client(method: "submitMiniToolPlanJob" | "readMiniToolPlanJob"): PlanClient {
  const entry: unknown = Reflect.get(shared, method);
  expect(entry, `shared exports ${method}`).toBeTypeOf("function");
  return entry as PlanClient;
}

beforeEach(() => { send.mockReset(); });

describe("planned job transport over the actual shared ingest client", () => {
  it("submits the original indexed plan and task bound without changing the deadline", async () => {
    send.mockResolvedValue(Response.json(done));
    const bound = { signal: new AbortController().signal, timeoutMs: 123456 };
    expect(await client("submitMiniToolPlanJob")(baseUrl, "test-secret", request, bound)).toMatchObject(done);
    expect(send).toHaveBeenCalledExactlyOnceWith(`${baseUrl}/jobs`, {
      method: "POST", headers: { "x-ingest-secret": "test-secret", "content-type": "application/json" },
      body: JSON.stringify(request),
    }, { replaySafe: true, ...bound });
    expect(request.deadlineAt).toBe(1792920000000);
  });

  it("reads only the original class and escaped job identity and validates its actual index", async () => {
    send.mockResolvedValue(Response.json(done));
    expect(await client("readMiniToolPlanJob")(baseUrl, "test-secret", request)).toMatchObject(done);
    expect(send).toHaveBeenCalledExactlyOnceWith(`${baseUrl}/jobs/MediaContainer/task%3AT%2Fchunk%3A1`, {
      method: "GET", headers: { "x-ingest-secret": "test-secret" },
    }, { replaySafe: true });
  });

  it.each(["starting", "running"])("preserves a %s report without manufacturing measurements", async (state) => {
    send.mockResolvedValue(Response.json({ schemaVersion: 2, state }));
    expect(await client("readMiniToolPlanJob")(baseUrl, "test-secret", request)).toEqual({ schemaVersion: 2, state });
  });

  it("retains a failed job's actual completed subset and unknown expense", async () => {
    const failed = { schemaVersion: 2, state: "failed", outputs: [output], reason: "internal", usage: null };
    send.mockResolvedValue(Response.json(failed));
    expect(await client("readMiniToolPlanJob")(baseUrl, "test-secret", request)).toMatchObject(failed);
  });

  it("returns null only for the original job's HTTP404 read", async () => {
    send.mockResolvedValue(new Response(null, { status: 404 }));
    expect(await client("readMiniToolPlanJob")(baseUrl, "test-secret", request)).toBeNull();
    expect(send).toHaveBeenCalledOnce();
  });

  it.each(["submitMiniToolPlanJob", "readMiniToolPlanJob"] as const)("keeps HTTP503 visible through %s", async (method) => {
    send.mockResolvedValue(new Response(null, { status: 503 }));
    await expect(client(method)(baseUrl, "test-secret", request)).rejects.toMatchObject({ status: 503 });
    expect(send).toHaveBeenCalledOnce();
  });

  it.each([
    { ...done, schemaVersion: undefined },
    { ...done, schemaVersion: 3 },
    { ...done, outputs: [] },
    { ...done, outputs: [{ ...output, outputIndex: 0 }] },
    { ...done, outputs: [{ ...output, storageKey: "other/frame.png" }] },
  ])("refuses an incompatible or foreign terminal report %#", async (report) => {
    send.mockResolvedValue(Response.json(report));
    await expect(client("readMiniToolPlanJob")(baseUrl, "test-secret", request)).rejects.toThrow();
    expect(send).toHaveBeenCalledOnce();
  });

  it("validates a proposed plan before sending any request", async () => {
    const submit = client("submitMiniToolPlanJob");
    await expect(submit(baseUrl, "test-secret", { ...request, command: "free-shell" })).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });

  it("propagates a network failure without a hidden second submission", async () => {
    const failure = new Error("connection lost after acceptance");
    send.mockRejectedValue(failure);
    await expect(client("submitMiniToolPlanJob")(baseUrl, "test-secret", request)).rejects.toBe(failure);
    expect(send).toHaveBeenCalledOnce();
  });
});

// frames-split §7.1.1 Exp and §7.6: past D a presentation job holds no plan, yet each ended attempt's usage is still read.
describe("a planned job read by its class and id alone", () => {
  type ById = (baseUrl: string, secret: string, containerClass: string, jobId: string) => Promise<MiniToolPlanJobReport | null>;
  const byId = (): ById => {
    const entry: unknown = Reflect.get(shared, "readMiniToolPlanJobById");
    expect(entry, "shared exports readMiniToolPlanJobById").toBeTypeOf("function");
    return entry as ById;
  };

  it("reads the escaped identity and answers the report's state and usage without a request to match outputs to", async () => {
    send.mockResolvedValue(Response.json(done));
    expect(await byId()(baseUrl, "test-secret", "MediaContainer", "task:T/chunk:1")).toMatchObject({ state: "done", usage });
    expect(send).toHaveBeenCalledExactlyOnceWith(`${baseUrl}/jobs/MediaContainer/task%3AT%2Fchunk%3A1`, {
      method: "GET", headers: { "x-ingest-secret": "test-secret" },
    }, { replaySafe: true });
  });

  it("answers null for a job the class does not hold and refuses a malformed report", async () => {
    send.mockResolvedValueOnce(new Response(null, { status: 404 }));
    expect(await byId()(baseUrl, "test-secret", "MediaContainer", "job")).toBeNull();
    send.mockResolvedValueOnce(Response.json({ ...done, schemaVersion: 3 }));
    await expect(byId()(baseUrl, "test-secret", "MediaContainer", "job")).rejects.toThrow();
  });
});
