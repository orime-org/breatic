// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

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

    await runLongMediaProbe(request, { execute, measure: async () => [], report, now: () => Date.now() });

    expect(execute).toHaveBeenCalledWith(request.objectUrl, expect.any(AbortSignal));
    expect(report).toHaveBeenCalledWith(request.reportUrl, { stdout: JSON.stringify({ streams: [] }) });
  });

  it("sends the measured windows of streams that declare no duration beside ffprobe's answer", async () => {
    const stdout = JSON.stringify({ streams: [{ index: 0, codec_type: "audio", time_base: "1/1000", sample_rate: "48000" }] });
    const measured = [{ index: 0, start: { numerator: "0", denominator: "1" }, end: { numerator: "3", denominator: "1" } }];
    const measure = vi.fn(async (_url: string, _stdout: string, _signal: AbortSignal) => measured);
    const report = vi.fn(async (_url: string, _result: LongMediaProbeRunResult) => undefined);

    await runLongMediaProbe(request, { execute: async () => stdout, measure, report, now: () => Date.now() });

    expect(measure).toHaveBeenCalledWith(request.objectUrl, stdout, expect.any(AbortSignal));
    expect(report).toHaveBeenCalledWith(request.reportUrl, { stdout, measured });
  });

  it("reports a stream it cannot measure as a controlled failure", async () => {
    const report = vi.fn(async (_url: string, _result: LongMediaProbeRunResult) => undefined);

    await runLongMediaProbe(request, { execute: async () => "{}", measure: async () => { throw new Error("unmeasured"); }, report, now: () => Date.now() });
    expect(report).toHaveBeenCalledWith(request.reportUrl, { failure: "probe_failed" });
  });

  it("logs why a measure threw before reporting the probe failed", async () => {
    const report = vi.fn(async (_url: string, _result: LongMediaProbeRunResult) => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      await runLongMediaProbe(request, { execute: async () => "{}", measure: async () => { throw new Error("The stream read failed: the source stopped at 20000 of 40000 bytes"); }, report, now: () => Date.now() });

      expect(error).toHaveBeenCalledWith("long_media_probe_read_failed", { source: request.objectUrl, err: "The stream read failed: the source stopped at 20000 of 40000 bytes" });
      expect(report).toHaveBeenCalledWith(request.reportUrl, { failure: "probe_failed" });
    } finally {
      error.mockRestore();
    }
  });

  it("reports an incomplete probe as a controlled failure", async () => {
    const execute = vi.fn(async (_url: string, _signal: AbortSignal) => null);
    const report = vi.fn(async (_url: string, _result: LongMediaProbeRunResult) => undefined);

    await runLongMediaProbe(request, { execute, measure: async () => [], report, now: () => Date.now() });
    expect(report).toHaveBeenCalledWith(request.reportUrl, { failure: "probe_failed" });
  });

  it("does not start after the absolute deadline", async () => {
    const execute = vi.fn(async (_url: string, _signal: AbortSignal) => "{}");
    const report = vi.fn(async (_url: string, _result: LongMediaProbeRunResult) => undefined);

    await runLongMediaProbe({ ...request, deadlineAt: 10 }, { execute, measure: async () => [], report, now: () => 10 });
    expect(execute).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledWith(request.reportUrl, { failure: "probe_failed" });
  });
});
