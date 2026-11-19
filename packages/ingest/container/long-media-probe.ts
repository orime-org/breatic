// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { readProbeOutput, type ReadFrom } from "@ingest/probe-command.js";
import { realVideoStream } from "@ingest/media-metadata.js";
import type { MeasuredStreamWindow } from "@ingest/long-media-measured-window.js";
import { readStreamWindow } from "@ingest/container/stream-window.js";
import { probeServedObject } from "@ingest/container/served-object-read.js";

/** The stderr tail kept for a failed measuring read's error. */
const MEASURE_STDERR_TAIL_BYTES = 65536;

/** The Container's fenced request to inspect one immutable source. */
export interface LongMediaProbeRunRequest {
  objectUrl: string;
  reportUrl: string;
  deadlineAt: number;
}

/** Dependencies that let the long-media probe protocol run without a real Container. */
export interface LongMediaProbeRunDeps {
  execute(objectUrl: string, signal: AbortSignal): Promise<string | null>;
  measure(objectUrl: string, stdout: string, signal: AbortSignal): Promise<MeasuredStreamWindow[]>;
  report(reportUrl: string, result: LongMediaProbeRunResult): Promise<void>;
  now(): number;
}

/** A complete probe answer or a controlled execution failure. */
export type LongMediaProbeRunResult = { stdout: string; measured?: MeasuredStreamWindow[] } | { failure: "probe_failed" };

/**
 * Probe one source and return the raw measured facts to the Worker.
 * @param request - The source, report endpoint and absolute operation deadline.
 * @param deps - The process, network and clock dependencies.
 * @returns Nothing; the report is delivered to the fenced callback.
 * @throws {Error} When the deadline has passed, probing fails or reporting is refused.
 */
export async function runLongMediaProbe(
  request: LongMediaProbeRunRequest,
  deps: LongMediaProbeRunDeps = LONG_MEDIA_PROBE_DEPS,
): Promise<void> {
  const remainingMs = request.deadlineAt - deps.now();
  if (remainingMs <= 0) {
    await deps.report(request.reportUrl, { failure: "probe_failed" });
    return;
  }
  const signal = AbortSignal.timeout(remainingMs);
  let result: LongMediaProbeRunResult;
  try {
    const stdout = await deps.execute(request.objectUrl, signal);
    if (stdout === null) result = { failure: "probe_failed" };
    else {
      const measured = await deps.measure(request.objectUrl, stdout, signal);
      result = measured.length === 0 ? { stdout } : { stdout, measured };
    }
  } catch (err) {
    console.error("long_media_probe_read_failed", { source: request.objectUrl, err: err instanceof Error ? err.message : String(err) });
    result = { failure: "probe_failed" };
  }
  await deps.report(request.reportUrl, result);
}

/**
 * Measure the window of every stream the long-media report times (each audio stream and the selected video) that
 * declares no duration, as Matroska streams do: the video from its packets, the audio from its decoded frames, which
 * apply the codec's priming and end trimming.
 * @param objectUrl - Where the source is read.
 * @param stdout - The first probe's FFprobe JSON.
 * @param signal - The probe's lifetime.
 * @param from - Whether the source is the served object or a local file.
 * @returns The measured windows; empty when every timed stream declares its duration.
 * @throws {Error} When a stream's clock cannot be measured or its read fails.
 */
export async function measureLongMediaStreams(objectUrl: string, stdout: string, signal: AbortSignal, from: ReadFrom = "object"): Promise<MeasuredStreamWindow[]> {
  const raw = JSON.parse(stdout) as { streams?: Record<string, unknown>[] };
  const video = realVideoStream(readProbeOutput(stdout));
  const timed = (raw.streams ?? []).filter((stream) => stream.codec_type === "audio" || (video !== undefined && stream.codec_type === "video" && stream.index === video.index));
  const measured: MeasuredStreamWindow[] = [];
  for (const stream of timed) {
    if (stream.duration_ts !== undefined) continue;
    const window = await readStreamWindow(objectUrl, stream, from, { signal, stderrTailBytes: MEASURE_STDERR_TAIL_BYTES });
    if (window === null) throw new Error("The long media stream clock could not be measured");
    measured.push({
      index: Number(stream.index),
      start: { numerator: String(window.start[0]), denominator: String(window.start[1]) },
      end: { numerator: String(window.end[0]), denominator: String(window.end[1]) },
    });
  }
  return measured;
}

const LONG_MEDIA_PROBE_DEPS: LongMediaProbeRunDeps = {
  execute: async (objectUrl, signal) => {
    const probed = await probeServedObject(objectUrl, signal);
    return probed?.toString("utf8") ?? null;
  },
  measure: (objectUrl, stdout, signal) => measureLongMediaStreams(objectUrl, stdout, signal),
  report: async (reportUrl, result) => {
    const response = await fetch(reportUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(result),
    });
    await response.body?.cancel();
    if (!response.ok) throw new Error(`The long media probe report was answered ${response.status}`);
  },
  now: () => Date.now(),
};
