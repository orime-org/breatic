// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The worker ↔ ingest contract for web-animation jobs (inner#1711 design §3.7): one shape on both sides, so the
 * request, the cancel body and the report cannot drift apart.
 */

import { describe, expect, it } from "vitest";

import {
  WEB_ANIMATION_CONTAINER_CLASS, webAnimationJobCancelSchema, webAnimationJobReportSchema, webAnimationJobRequestSchema,
} from "../web-animation-job.js";

const request = {
  containerClass: "WebAnimationContainer" as const,
  jobId: "timeline:40000000-0000-4000-8000-000000000001",
  deadlineAt: 1794040000000,
  prompt: "A red square slides from left to right",
  viewport: { width: 1920, height: 1080 },
  fps: { num: 24, den: 1 },
  durationFrames: 96,
  packageKey: "web-animation/p/40000000-0000-4000-8000-000000000001/index.html",
  manifestKey: "web-animation/p/40000000-0000-4000-8000-000000000001/manifest.json",
  fontSetVersion: 1,
  maxPackageBytes: 5_000_000,
  maxTokens: 32_000,
  callTimeoutMs: 300_000,
  model: "deepseek/deepseek-v4.1-flash-1017",
};

const call = {
  seq: 1,
  generationId: "gen-123",
  tokens: { input: 11785, output: 202, reasoning: 148, cacheRead: 0 },
  costUsd: 0.0037779,
  outcome: "completed" as const,
};

describe("webAnimationJobRequestSchema", () => {
  it("accepts the request the worker builds", () => {
    expect(webAnimationJobRequestSchema.parse(request)).toEqual(request);
  });

  it("names the container class the job routes dispatch on", () => {
    expect(WEB_ANIMATION_CONTAINER_CLASS).toBe("WebAnimationContainer");
    expect(webAnimationJobRequestSchema.safeParse({ ...request, containerClass: "MiniToolContainerStd1" }).success).toBe(false);
  });

  it("carries no spend ceiling: a run is bounded by its deadline and one model call at a time", () => {
    expect(webAnimationJobRequestSchema.parse({ ...request, costCeilingUsd: 0.5 })).toEqual(request);
  });

  it("requires every limit the ingest Worker cannot read from yaml", () => {
    for (const field of ["maxPackageBytes", "maxTokens", "callTimeoutMs", "fontSetVersion", "model"] as const) {
      const { [field]: _dropped, ...rest } = request;
      expect(webAnimationJobRequestSchema.safeParse(rest).success, field).toBe(false);
    }
  });

  it("keeps package and manifest under the private web-animation prefix", () => {
    expect(webAnimationJobRequestSchema.safeParse({ ...request, packageKey: "assets/x/index.html" }).success).toBe(false);
    expect(webAnimationJobRequestSchema.safeParse({ ...request, manifestKey: "transfer/x/manifest.json" }).success).toBe(false);
  });
});

describe("webAnimationJobCancelSchema", () => {
  it("carries the deadline a pre-submit cancel marker lives until", () => {
    expect(webAnimationJobCancelSchema.parse({ deadlineAt: 1794040000000 })).toEqual({ deadlineAt: 1794040000000 });
    expect(webAnimationJobCancelSchema.safeParse({}).success).toBe(false);
  });
});

describe("webAnimationJobReportSchema", () => {
  const report = {
    state: "done" as const,
    phase: "saving" as const,
    steps: [],
    calls: [call],
    container: { wallMs: 42_000, cpuUsec: 9_000_000 },
    outputs: [{ key: request.packageKey, sha256: "a".repeat(64), bytes: 553 }],
    failureReason: null,
  };

  it("accepts a terminal report with its calls and outputs", () => {
    expect(webAnimationJobReportSchema.parse(report)).toEqual(report);
  });

  it("knows every job state, the drain and pre-submit cancel included", () => {
    for (const state of ["running", "stopping", "done", "failed", "cancelled", "expired", "cancelled_before_submit"]) {
      expect(webAnimationJobReportSchema.safeParse({ ...report, state }).success, state).toBe(true);
    }
  });

  it("records how each call ended", () => {
    for (const outcome of ["completed", "upstream_error", "interrupted", "cut_off"]) {
      expect(webAnimationJobReportSchema.safeParse({ ...report, calls: [{ ...call, outcome }] }).success, outcome).toBe(true);
    }
    expect(webAnimationJobReportSchema.safeParse({ ...report, calls: [{ ...call, outcome: "lost" }] }).success).toBe(false);
  });

  it("lets a call without a generation carry no id and no cost", () => {
    const refused = { seq: 2, generationId: null, tokens: null, costUsd: null, outcome: "upstream_error" as const };
    expect(webAnimationJobReportSchema.parse({ ...report, calls: [refused] }).calls).toEqual([refused]);
  });
});
