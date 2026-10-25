// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { readLongMediaProbeReport, type LongMediaProbeReport } from "@shared/media/long-media-probe.js";
import type { MediaInputDescriptor } from "@shared/media/long-media-schema.js";

import { realVideoStream } from "@ingest/media-metadata.js";
import { readProbeOutput } from "@ingest/probe-command.js";

interface RawStream {
  index?: number;
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  channels?: number;
  channel_layout?: string;
  sample_rate?: string;
  start_pts?: string | number;
  duration_ts?: string | number;
  time_base?: string;
}

interface StreamTiming {
  startUs: string;
  endUs: string;
  timeBase: { numerator: string; denominator: string };
}

/**
 * Convert measured ffprobe facts into a validated long-media report.
 * @param stdout - The JSON output from ffprobe.
 * @param sourceFingerprint - The hash measured for the immutable R2 source.
 * @param profileVersion - The frozen media conversion profile version.
 * @returns A strict report with one required input per audio channel.
 * @throws {Error} When stream timing or media facts are incomplete or invalid.
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
  type ProbeStreamFact = LongMediaProbeReport["streams"][number];
  const streams: ProbeStreamFact[] = probedStreams.flatMap((item): ProbeStreamFact[] => {
    if (item.codec_type !== "audio" && item.codec_type !== "video") return [];
    if (item.index === undefined || !Number.isSafeInteger(item.index) || item.index < 0) {
      throw new Error("The long media stream index is missing");
    }
    const timing = streamTiming(item);
    if (item.codec_name === undefined || item.codec_name.length === 0) {
      throw new Error("The long media stream codec is missing");
    }
    if (item.codec_type === "audio") {
      const sampleRate = Number(item.sample_rate);
      if (item.channels === undefined || item.channels < 1 || !Number.isSafeInteger(sampleRate) || sampleRate < 1) {
        throw new Error("The long media audio channel count or sample rate is missing");
      }
      return [{
        index: item.index,
        kind: "audio",
        codec: item.codec_name,
        channels: item.channels,
        channelLayout: item.channel_layout ?? "unknown",
        channelMembers: Array.from({ length: item.channels }, (_unused, channelIndex) => ({ channelIndex, member: "unknown" })),
        sampleRate,
        ...timing,
      }];
    }
    if (item.width === undefined || item.width < 1 || item.height === undefined || item.height < 1) {
      throw new Error("The long media video dimensions are missing");
    }
    return [{
      index: item.index,
      kind: "video",
      codec: item.codec_name,
      width: item.width,
      height: item.height,
      ...timing,
    }];
  });
  const videoStreamIndex = selectedVideo?.index ?? null;
  const audioStreams = streams.filter((item) => item.kind === "audio");
  const mediaInputs: LongMediaProbeReport["mediaInputs"] = audioStreams.flatMap((audio): LongMediaProbeReport["mediaInputs"] => {
    const audioRange = { startUs: audio.startUs, endUs: audio.endUs };
    return Array.from({ length: audio.channels }, (_unused, audioChannelIndex) => {
      const descriptor: MediaInputDescriptor = videoStreamIndex === null
        ? { inputKind: "audio_channel", audioStreamIndex: audio.index, audioChannelIndex }
        : { inputKind: "video_channel", videoStreamIndex, audioStreamIndex: audio.index, audioChannelIndex };
      const mediaInputId = JSON.stringify({ sourceFingerprint, descriptor, profileVersion });
      const video = streams.find((item) => item.kind === "video" && item.index === videoStreamIndex);
      return video?.kind === "video"
        ? {
            mediaInputId,
            descriptor,
            sourceRange: rangeEnvelope({ startUs: video.startUs, endUs: video.endUs }, audioRange),
            videoRange: { startUs: video.startUs, endUs: video.endUs },
            audioRange,
          }
        : { mediaInputId, descriptor, sourceRange: audioRange, audioRange };
    });
  });
  if (videoStreamIndex !== null && audioStreams.length === 0) {
    const video = streams.find((item) => item.kind === "video" && item.index === videoStreamIndex);
    if (video?.kind === "video") {
      const descriptor = { inputKind: "video_silent" as const, videoStreamIndex };
      mediaInputs.push({
        mediaInputId: JSON.stringify({ sourceFingerprint, descriptor, profileVersion }),
        descriptor,
        sourceRange: { startUs: video.startUs, endUs: video.endUs },
        videoRange: { startUs: video.startUs, endUs: video.endUs },
      });
    }
  }
  return readLongMediaProbeReport({
    version: 1,
    sourceFingerprint,
    selectedVideoStreamIndex: videoStreamIndex,
    streams,
    mediaInputs,
  });
}

/**
 * Convert exact stream PTS facts to integer microseconds.
 * @param raw - One ffprobe stream.
 * @returns Its measured start, end and source time base.
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
    timeBase: { numerator: parts[0]!, denominator: parts[1]! },
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

/**
 * Find the time envelope of video and audio ranges.
 * @param video - The selected video stream range.
 * @param audio - One audio channel's stream range.
 * @returns The minimum start and maximum end.
 */
function rangeEnvelope(
  video: { startUs: string; endUs: string },
  audio: { startUs: string; endUs: string },
): { startUs: string; endUs: string } {
  return {
    startUs: BigInt(video.startUs) < BigInt(audio.startUs) ? video.startUs : audio.startUs,
    endUs: BigInt(video.endUs) > BigInt(audio.endUs) ? video.endUs : audio.endUs,
  };
}
