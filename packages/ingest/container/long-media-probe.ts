// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { createInterface } from "node:readline";
import { PROBE_MAX_BYTES, probeArgs, protocolsFor, readProbeOutput, type ReadFrom } from "@ingest/probe-command.js";
import { realVideoStream } from "@ingest/media-metadata.js";
import type { MeasuredStreamWindow } from "@ingest/long-media-measured-window.js";
import { decodedAudioAccumulator, videoPacketAccumulator, type StreamWindow, type WindowAccumulator } from "@ingest/container/stream-window.js";
import { startPlanCommand } from "@ingest/container/plan-command.js";
import { runTool } from "./run-tool.js";

/** The stderr tail kept for a failed measuring read's error. */
const MEASURE_STDERR_TAIL_BYTES = 65536;

/**
 * FFprobe's error lines that leave a read whole (measured with FFmpeg 7.1): the HTTP layer reporting a dropped
 * connection, which `-reconnect` then resumes with a Range request, and the Matroska demuxer reaching the end of a
 * truncated file, whose window is what it holds. A drop that cannot be resumed adds the demuxer's `Read error`.
 */
const WHOLE_READ_STDERR = [
  /^\[http @ 0x[0-9a-f]+\] Stream ends prematurely at \d+, should be \d+$/u,
  /^\[matroska,webm @ 0x[0-9a-f]+\] File ended prematurely$/u,
];

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
  } catch {
    result = { failure: "probe_failed" };
  }
  await deps.report(request.reportUrl, result);
}

/**
 * Read one stream's FFprobe entries line by line into its accumulator, so a long source never holds the whole list.
 * @param args - The FFprobe arguments, printing `compact` lines of named fields.
 * @param accumulator - Where the entries go.
 * @param signal - The probe's lifetime.
 * @returns The stream's window.
 * @throws {Error} When FFprobe fails, reports an error (a dropped read still exits 0) or an entry carries no exact clock.
 */
async function readWindow(args: string[], accumulator: WindowAccumulator, signal: AbortSignal): Promise<StreamWindow> {
  const pipe = startPlanCommand("ffprobe", args, { signal, stderrTailBytes: MEASURE_STDERR_TAIL_BYTES }, { stdout: true });
  let clockless = false;
  try {
    for await (const line of createInterface({ input: pipe.stdout!, crlfDelay: Infinity })) {
      if (line.length === 0) continue;
      const fields = Object.fromEntries(line.split("|").map((pair) => pair.split("=", 2) as [string, string]));
      if (!accumulator.add(fields)) { clockless = true; pipe.stop(); break; }
    }
  } finally {
    await pipe.done.catch((error: unknown) => { if (!clockless) throw error; });
  }
  // FFprobe exits 0 after a failed read, with the frames seen so far; any other error line fails the window.
  const stderr = pipe.stderrTail();
  if (stderr.split("\n").some((line) => line.length > 0 && !WHOLE_READ_STDERR.some((whole) => whole.test(line)))) {
    throw new Error(`The long media stream read failed: ${stderr}`);
  }
  const window = accumulator.window();
  if (clockless || window === null) throw new Error("The long media stream clock could not be measured");
  return window;
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
 * @throws {Error} When a stream's clock cannot be measured.
 */
export async function measureLongMediaStreams(objectUrl: string, stdout: string, signal: AbortSignal, from: ReadFrom = "object"): Promise<MeasuredStreamWindow[]> {
  const raw = JSON.parse(stdout) as { streams?: Record<string, unknown>[] };
  const video = realVideoStream(readProbeOutput(stdout));
  const timed = (raw.streams ?? []).filter((stream) => stream.codec_type === "audio" || (video !== undefined && stream.codec_type === "video" && stream.index === video.index));
  const measured: MeasuredStreamWindow[] = [];
  for (const stream of timed) {
    if (stream.duration_ts !== undefined) continue;
    const audio = stream.codec_type === "audio";
    const accumulator = audio ? decodedAudioAccumulator(stream) : videoPacketAccumulator(stream);
    if (accumulator === null) throw new Error("The long media stream clock could not be measured");
    // A served object's read resumes with a Range request after a dropped connection instead of ending early.
    const reconnect = from === "object" ? ["-reconnect", "1", "-reconnect_on_network_error", "1"] : [];
    // `repeat` keeps every line, so a repeated one is checked rather than folded into "Last message repeated".
    const window = await readWindow(["-v", "repeat+error", "-protocol_whitelist", protocolsFor(from), ...reconnect, "-select_streams", String(stream.index),
      "-show_entries", audio ? "frame=pts,nb_samples" : "packet=pts,duration", "-of", "compact=p=0", objectUrl], accumulator, signal);
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
    const result = await runTool("ffprobe", probeArgs(objectUrl), { maxBytes: PROBE_MAX_BYTES, signal });
    return result?.toString("utf8") ?? null;
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
