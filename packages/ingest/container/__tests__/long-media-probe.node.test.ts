// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it, vi } from "vitest";

import { runLongMediaProbe, type LongMediaProbeRunRequest, type LongMediaProbeRunResult } from "../long-media-probe.js";

const request: LongMediaProbeRunRequest = {
  objectUrl: "http://media.local/objects/source.mp4",
  reportUrl: "http://long-media.local/probe-report",
  deadlineAt: Date.now() + 60_000,
};

describe("runLongMediaProbe", () => {
  it("sends ffprobe's measured answer to the fenced report callback", async () => {
    const execute = vi.fn(async (_url: string, _signal: AbortSignal) => JSON.stringify({ streams: [] }));
    const report = vi.fn(async (_url: string, _result: LongMediaProbeRunResult) => undefined);

    await runLongMediaProbe(request, { execute, report, now: () => Date.now() });

    expect(execute).toHaveBeenCalledWith(request.objectUrl, expect.any(AbortSignal));
    expect(report).toHaveBeenCalledWith(request.reportUrl, { stdout: JSON.stringify({ streams: [] }) });
  });

  it("reports an incomplete probe as a controlled failure", async () => {
    const execute = vi.fn(async (_url: string, _signal: AbortSignal) => null);
    const report = vi.fn(async (_url: string, _result: LongMediaProbeRunResult) => undefined);

    await runLongMediaProbe(request, { execute, report, now: () => Date.now() });
    expect(report).toHaveBeenCalledWith(request.reportUrl, { failure: "probe_failed" });
  });

  it("does not start after the absolute deadline", async () => {
    const execute = vi.fn(async (_url: string, _signal: AbortSignal) => "{}");
    const report = vi.fn(async (_url: string, _result: LongMediaProbeRunResult) => undefined);

    await runLongMediaProbe({ ...request, deadlineAt: 10 }, { execute, report, now: () => 10 });
    expect(execute).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledWith(request.reportUrl, { failure: "probe_failed" });
  });
});
