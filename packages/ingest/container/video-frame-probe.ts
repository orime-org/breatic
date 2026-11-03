// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/** One decoded video sample in presentation order on its source clock. */
export interface VideoSourceFrame { frameIndex: number; pts: number }

/** A complete ordered decoded frame sequence and its independently resolved endpoint. */
export interface VideoFrameTable { frames: readonly VideoSourceFrame[]; videoEnd: number }

/** Complete decoded raw frames and their encoded source metadata. */
export interface VideoFrameProbe {
  frameTable: VideoFrameTable;
  timeBase: string;
  width: number;
  height: number;
  rotation: number;
  hasAudio: boolean;
}

/**
 * Reads an object from the ffprobe response without coercing missing fields.
 * @param value - One parsed JSON value.
 * @returns Its named fields.
 * @throws {TypeError} When the value is not an object.
 */
function probeObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Expected an ffprobe object");
  }
  return value as Record<string, unknown>;
}

/**
 * Reads a finite decimal timestamp without treating empty text as zero.
 * @param value - A JSON number or decimal field emitted by ffprobe.
 * @returns The finite source-clock number.
 * @throws {TypeError} When the field is absent or not a finite decimal.
 */
function probeNumber(value: unknown): number {
  if (typeof value !== "number" && (typeof value !== "string" || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value))) {
    throw new TypeError("Expected a finite ffprobe number");
  }
  const number = Number(value);
  if (!Number.isFinite(number)) throw new TypeError("Expected a finite ffprobe number");
  return number;
}

/**
 * Reads positive integer pixel dimensions from the selected video stream.
 * @param value - Its encoded dimension.
 * @returns The positive integral pixel count.
 * @throws {TypeError} When the dimension is invalid.
 */
function probeDimension(value: unknown): number {
  const number = probeNumber(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new TypeError("Expected a positive video dimension");
  return number;
}

/**
 * Validates the exact rational source clock instead of estimating a frame rate.
 * @param value - The stream time_base string.
 * @returns The original rational string.
 * @throws {TypeError} When either rational component is invalid.
 */
function probeTimeBase(value: unknown): string {
  if (typeof value !== "string" || !/^\d+\/\d+$/.test(value)) throw new TypeError("Expected a rational video time base");
  for (const component of value.split("/")) {
    const number = Number(component);
    if (!Number.isSafeInteger(number) || number <= 0) throw new TypeError("Expected a positive video time base");
  }
  return value;
}

/**
 * Reads decoded raw frame facts without applying presentation-window edits.
 * @param report - Stream metadata and the complete primary-video frame response.
 * @returns Decoded source frames and independent stream metadata.
 * @throws {TypeError} When frame timing, source geometry or clock fields are invalid.
 */
export function parseVideoFrameProbe(report: unknown): VideoFrameProbe {
  const raw = probeObject(report);
  if (!Array.isArray(raw.streams) || !Array.isArray(raw.frames) || raw.frames.length === 0) {
    throw new TypeError("Expected streams and a complete nonempty video frame response");
  }
  const streams = raw.streams.map(probeObject);
  const video = streams.find((stream) => stream.codec_type === "video");
  if (!video) throw new TypeError("Expected a primary video stream");
  const width = probeDimension(video.width);
  const height = probeDimension(video.height);
  const timeBase = probeTimeBase(video.time_base);
  const frames = raw.frames.map((value, frameIndex) => {
    const frame = probeObject(value);
    const timestamp = frame.best_effort_timestamp_time === undefined ? frame.pts_time : frame.best_effort_timestamp_time;
    return { frameIndex, pts: probeNumber(timestamp) };
  });
  if (frames.some((frame, index) => index > 0 && frame.pts < frames[index - 1]!.pts)) {
    throw new TypeError("Expected presentation-ordered decoded video frames");
  }
  const last = probeObject(raw.frames[raw.frames.length - 1]);
  const duration = probeNumber(last.duration_time === undefined ? last.pkt_duration_time : last.duration_time);
  const videoEnd = frames[frames.length - 1]!.pts + duration;
  if (duration <= 0 || !Number.isFinite(videoEnd) || videoEnd <= frames[frames.length - 1]!.pts) {
    throw new TypeError("Expected a positive finite last-frame duration");
  }
  const sideData = Array.isArray(video.side_data_list) ? video.side_data_list.map(probeObject) : [];
  const rotationValue = sideData.find((entry) => entry.rotation !== undefined)?.rotation;
  return {
    frameTable: { frames, videoEnd }, timeBase, width, height,
    rotation: rotationValue === undefined ? 0 : probeNumber(rotationValue),
    hasAudio: streams.some((stream) => stream.codec_type === "audio"),
  };
}
