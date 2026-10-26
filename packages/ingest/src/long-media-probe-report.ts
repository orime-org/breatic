// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { readLongMediaProbeReport, type LongMediaProbeReport } from "@shared/media/long-media-probe.js";
import { realVideoStream } from "@ingest/media-metadata.js";
import { readProbeOutput } from "@ingest/probe-command.js";

interface RawStream {
  index?: number;
  codec_type?: string;
  start_pts?: string | number;
  duration_ts?: string | number;
  time_base?: string;
}

interface StreamTiming {
  startUs: string;
  endUs: string;
}

/**
 * Convert measured ffprobe facts into one complete source-file report.
 * @param stdout - The JSON output from ffprobe.
 * @param sourceFingerprint - The hash measured for the immutable R2 source.
 * @param profileVersion - The frozen media conversion profile version.
 * @returns A report with one source timeline for the complete file.
 * @throws {Error} When the source media or stream timing facts are incomplete.
 */
export function buildLongMediaProbeReport(
  stdout: string,
  sourceFingerprint: string,
  profileVersion: string,
): LongMediaProbeReport {
  if (profileVersion.length === 0) throw new Error("The long media profile version is missing");
  let raw: { streams?: RawStream[] };
  try {
    raw = JSON.parse(stdout) as { streams?: RawStream[] };
  } catch {
    throw new Error("The long media ffprobe output is invalid");
  }

  const probedStreams = raw.streams ?? [];
  const selectedVideo = realVideoStream(readProbeOutput(stdout));
  const selectedVideoRaw = selectedVideo === undefined
    ? undefined
    : probedStreams.find((stream) => stream.index === selectedVideo.index && stream.codec_type === "video");
  const sourceStreams = [
    ...probedStreams.filter((stream) => stream.codec_type === "audio"),
    ...(selectedVideoRaw === undefined ? [] : [selectedVideoRaw]),
  ];
  if (sourceStreams.length === 0) throw new Error("The long media source has no audio or video stream");

  const streams: LongMediaProbeReport["streams"] = sourceStreams.map((stream) => {
    if (stream.index === undefined || !Number.isSafeInteger(stream.index) || stream.index < 0) {
      throw new Error("The long media stream index is missing");
    }
    if (stream.codec_type !== "audio" && stream.codec_type !== "video") {
      throw new Error("The long media stream kind is invalid");
    }
    return { index: stream.index, kind: stream.codec_type, ...streamTiming(stream) };
  });
  const sourceRange = sourceTimeEnvelope(streams);
  const descriptor = {
    inputKind: "source_file" as const,
    mediaKind: selectedVideo === undefined ? "audio" as const : "video" as const,
  };

  return readLongMediaProbeReport({
    version: 1,
    sourceFingerprint,
    selectedVideoStreamIndex: selectedVideo?.index ?? null,
    streams,
    mediaInputs: [{
      mediaInputId: JSON.stringify({ sourceFingerprint, descriptor, profileVersion }),
      descriptor,
      sourceRange,
    }],
  });
}

/**
 * Convert exact stream PTS facts to integer microseconds.
 * @param raw - One ffprobe stream.
 * @returns Its measured start and end on the source timeline.
 * @throws {Error} When PTS, duration or time base is unavailable.
 */
function streamTiming(raw: RawStream): StreamTiming {
  const startPts = exactIntegerText(raw.start_pts, true);
  const durationTicks = exactIntegerText(raw.duration_ts, false);
  if (startPts === null || durationTicks === null || BigInt(durationTicks) <= 0n) {
    throw new Error("The long media stream time is not measured");
  }
  const parts = raw.time_base?.split("/");
  if (parts === undefined || parts.length !== 2 || !/^\d+$/.test(parts[0]!) || !/^\d+$/.test(parts[1]!) ||
      BigInt(parts[0]!) <= 0n || BigInt(parts[1]!) <= 0n) {
    throw new Error("The long media stream time base is invalid");
  }
  const numerator = BigInt(parts[0]!);
  const denominator = BigInt(parts[1]!);
  return {
    startUs: ticksToMicroseconds(BigInt(startPts), numerator, denominator),
    endUs: ticksToMicroseconds(BigInt(startPts) + BigInt(durationTicks), numerator, denominator),
  };
}

/**
 * Preserve an exact integer field from FFprobe's JSON representation.
 * @param value - The number or decimal text emitted by FFprobe.
 * @param signed - Whether negative integers are valid.
 * @returns The exact decimal text, or null when precision is unavailable.
 * @throws {Error} When a numeric JSON value has already lost integer precision.
 */
function exactIntegerText(value: string | number | undefined, signed: boolean): string | null {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error("The long media stream timestamp loses JSON precision");
    return signed || value >= 0 ? String(value) : null;
  }
  if (typeof value !== "string") return null;
  return (signed ? /^-?\d+$/ : /^\d+$/).test(value) ? value : null;
}

/**
 * Find the one time range spanning the complete source file.
 * @param streams - Audio streams and the selected video stream.
 * @returns The earliest source start and latest source end.
 * @throws {RangeError} When the stream list is empty or its ranges are invalid.
 */
function sourceTimeEnvelope(streams: readonly LongMediaProbeReport["streams"][number][]): { startUs: string; endUs: string } {
  const first = streams[0];
  if (first === undefined) throw new RangeError("A long media source needs at least one stream.");
  let startUs = BigInt(first.startUs);
  let endUs = BigInt(first.endUs);
  for (const stream of streams.slice(1)) {
    const streamStartUs = BigInt(stream.startUs);
    const streamEndUs = BigInt(stream.endUs);
    if (streamStartUs < startUs) startUs = streamStartUs;
    if (streamEndUs > endUs) endUs = streamEndUs;
  }
  return { startUs: String(startUs), endUs: String(endUs) };
}

/**
 * Convert PTS ticks to the nearest integer microsecond.
 * @param ticks - The PTS value in the stream time base.
 * @param numerator - The time base numerator.
 * @param denominator - The time base denominator.
 * @returns The rounded microsecond count as integer text.
 */
function ticksToMicroseconds(ticks: bigint, numerator: bigint, denominator: bigint): string {
  const scaled = ticks * numerator * 1_000_000n;
  const magnitude = scaled < 0n ? -scaled : scaled;
  const rounded = (magnitude + denominator / 2n) / denominator;
  return String(scaled < 0n ? -rounded : rounded);
}
