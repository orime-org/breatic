// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { submitJob, type JobsEnv } from "@ingest/jobs/routes.js";

// §93 D5 (frames-split design §7.17 frame row 「不得把presentation ordinal当原解码n」, 「唯一写点：worker的配方构造」): a job frame recipe names a full-ledger entry and its PNG target, not a frameIndex.
const PLAN = {
  limits: { probeStdoutBytes: 1048576, analysisStdoutBytes: 1048576, stderrTailBytes: 8192 },
  schemaVersion: 2,
  jobId: "plan-chunk-1",
  containerClass: "MiniToolContainerStd1",
  deadlineAt: 2000000000000,
  inputs: [
    { inputId: "20000000-0000-4000-8000-000000000001", storageKey: "fixtures/source-a.mp4" },
    { inputId: "20000000-0000-4000-8000-000000000002", storageKey: "fixtures/source-b.mp4" },
  ],
  outputs: [{ outputIndex: 8, storageKey: "results/T/o08.png", contentType: "image/png", recipe: { kind: "frame", inputId: "20000000-0000-4000-8000-000000000002", entry: { kind: "source", decodeStart: { numerator: "6", denominator: "5" }, clipStart: { numerator: "6", denominator: "5" }, displayStart: { numerator: "6", denominator: "5" }, displayEnd: { numerator: "31", denominator: "25" }, rate: { numerator: "1", denominator: "1" } }, target: { width: 32, height: 18, colorMatrix: "bt709", toneMap: "none", pngBitDepth: 8, alpha: "none" } } }],
};

describe("planned job route dispatch without a container image", () => {
  it("passes both frozen sources and the original global output index to the DO", async () => {
    const submit = vi.fn(async () => ({ schemaVersion: 2, state: "running" }));
    const namespace = { idFromName: vi.fn(() => "object-id"), get: vi.fn(() => ({ submit })) };
    const response = await submitJob(new Request("https://ingest.example/jobs", { method: "POST", headers: { "x-ingest-secret": env.INGEST_SHARED_SECRET }, body: JSON.stringify(PLAN) }), { ...env, MINI_TOOL_STD1: namespace } as unknown as JobsEnv);
    expect(response.status).toBe(200);
    expect(submit).toHaveBeenCalledExactlyOnceWith(PLAN);
    expect(namespace.idFromName).toHaveBeenCalledExactlyOnceWith("plan-chunk-1");
    expect(await response.json()).toEqual({ schemaVersion: 2, state: "running" });
  });

  it("refuses unsupported explicit versions before constructing a DO", async () => {
    const get = vi.fn();
    const namespace = { idFromName: vi.fn(), get };
    const legacy = { jobId: "legacy", containerClass: PLAN.containerClass, deadlineAt: PLAN.deadlineAt, op: "cut", params: { range: { start: 0, end: 1 } }, input: { storageKey: "fixtures/source-a.mp4" }, outputs: [{ storageKey: "results/out.mp4", contentType: "video/mp4" }] };
    for (const schemaVersion of [1, 3, "2"]) {
      const response = await submitJob(new Request("https://ingest.example/jobs", { method: "POST", headers: { "x-ingest-secret": env.INGEST_SHARED_SECRET }, body: JSON.stringify({ ...legacy, schemaVersion }) }), { ...env, MINI_TOOL_STD1: namespace } as unknown as JobsEnv);
      expect(response.status).toBe(400);
    }
    expect(get).not.toHaveBeenCalled();
  });
});
