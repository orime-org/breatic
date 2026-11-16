// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import type { PhysicalVideoProbe } from "@shared/upload/video-source-ledger-types.js";

import { naturalSize } from "@ingest/media-metadata.js";

/**
 * Read one original probe object without coercing missing facts.
 * @throws {TypeError} When the value is not an object.
 */
function probeObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Expected a physical video probe object");
  }
  return value as Record<string, unknown>;
}

/**
 * Preserve the positive source rational's original components without rounding.
 * @throws {TypeError} When either clock component is absent or non-positive.
 */
function probeTimeBase(value: unknown): PhysicalVideoProbe["sourceTimeBase"] {
  if (typeof value === "string") {
    const match = /^(\d+)\/(\d+)$/.exec(value);
    if (match && BigInt(match[1]!) > 0n && BigInt(match[2]!) > 0n) {
      return { numerator: match[1]!, denominator: match[2]! };
    }
  }
  throw new TypeError("Expected a positive exact video time base");
}

/** One selected-stream packet in decode order, its numbers kept as the probe wrote them. */
export interface PhysicalVideoPacket { rawDecodeOrdinal: number; ptsTicks: string; dtsTicks?: string; durationTicks: string | null; keyframe: boolean; position: string | null }
/** The selected video stream's packets and clock. */
export interface PhysicalVideoPackets { streamIndex: number; sourceTimeBase: PhysicalVideoProbe["sourceTimeBase"]; packets: PhysicalVideoPacket[] }

/**
 * The packet-level demux probe of §5.1 step 2: pts, dts, duration, flags and pos of the selected stream, no decoding.
 * @param input - The source path.
 * @param input.input - The source path.
 * @param input.streamIndex - The selected video stream index.
 * @param input.iso - Whether the source is ISO BMFF, whose edit list is read separately and ignored here.
 * @returns The ffprobe arguments.
 * @throws {never} Never.
 */
export function videoPacketProbeArgs(input: { input: string; streamIndex: number; iso: boolean }): string[] {
  // nofillin: a packet's duration is the one the file stores, never FFmpeg's estimate from its frame rate (§4.2.1).
  return ["-v", "error", "-protocol_whitelist", "file", "-fflags", "+nofillin", ...(input.iso ? ["-ignore_editlist", "1"] : []),
    "-select_streams", String(input.streamIndex), "-show_packets", "-show_entries", "packet=stream_index,pts,dts,duration,flags,pos", "-of", "json", input.input];
}

/**
 * Read the packet probe without rounding: a packet's decode order is its source ordinal, a zero or missing duration is
 * undeclared, flags starting with `K` mark a keyframe, a missing pos is null and a missing dts is left out.
 * @param metadata - Stream metadata from the same immutable source.
 * @param packetBytes - Complete packet JSON from {@link videoPacketProbeArgs}.
 * @returns The selected stream's packets.
 * @throws {TypeError} When the selected stream, clock or a packet fact is invalid.
 * @throws {SyntaxError} When the packet stdout is not complete JSON.
 */
export function parsePhysicalVideoPackets(metadata: unknown, packetBytes: Buffer): PhysicalVideoPackets {
  const streams = probeObject(metadata).streams;
  if (!Array.isArray(streams)) throw new TypeError("Expected original video stream metadata");
  const selected = streams.map(probeObject).find((stream) => stream.codec_type === "video");
  if (selected === undefined || typeof selected.index !== "number" || !Number.isSafeInteger(selected.index) || selected.index < 0 || streams.map(probeObject).filter((stream) => stream.index === selected.index).length !== 1) {
    throw new TypeError("Expected an unambiguous selected video stream");
  }
  const streamIndex = selected.index;
  const sourceTimeBase = probeTimeBase(selected.time_base);
  const parsed: unknown = JSON.parse(packetBytes.toString("utf8"),
    (key: string, value: unknown, context?: { source?: string }): unknown =>
      (key === "pts" || key === "dts" || key === "duration" || key === "pos") && typeof value === "number" ? context?.source : value);
  const values = probeObject(parsed).packets;
  if (!Array.isArray(values) || values.length === 0) throw new TypeError("Expected complete selected-video packets");
  const packets = values.map((value: unknown, rawDecodeOrdinal: number): PhysicalVideoPacket => {
    const packet = probeObject(value);
    const { pts, dts, duration, flags, pos } = packet;
    if (packet.stream_index !== streamIndex || typeof pts !== "string" || !/^-?\d+$/u.test(pts) || typeof flags !== "string" ||
      (dts !== undefined && (typeof dts !== "string" || !/^-?\d+$/u.test(dts))) ||
      (duration !== undefined && (typeof duration !== "string" || !/^\d+$/u.test(duration))) ||
      (pos !== undefined && (typeof pos !== "string" || !/^\d+$/u.test(pos)))) {
      throw new TypeError("Expected exact selected-video packet pts, dts, duration, flags and position");
    }
    return {
      rawDecodeOrdinal, ptsTicks: pts, ...(dts === undefined ? {} : { dtsTicks: dts }), durationTicks: duration === undefined || BigInt(duration) === 0n ? null : duration,
      keyframe: flags.startsWith("K"), position: pos ?? null,
    };
  });
  return { streamIndex, sourceTimeBase, packets };
}

/**
 * Tagged ffprobe `color_space` values and the matrix the plan records for them: every matrix the recipes decode (swscale and
 * zscale) and the copy tags (H.264/HEVC matrix_coefficients, VP9 color_space).
 */
export const TAGGED_MATRICES: Readonly<Record<string, string>> = { bt709: "bt709", smpte170m: "bt601", bt470bg: "bt601", bt2020nc: "bt2020nc", smpte240m: "smpte240m", fcc: "fcc" };

/**
 * Resolve the colour matrix once for the plan (§4.3): a tag in `TAGGED_MATRICES` is kept; any other stream is BT.709 when its
 * coded height is at least 720 and BT.601 otherwise, whatever its rotation. That covers untagged and `unknown` streams,
 * RGB-coded ones (`gbr`: PNG, FFV1 RGB, whose frames the scaler converts with no input matrix) and matrices the recipes
 * cannot decode.
 * @param stream - The selected ffprobe stream.
 * @returns The matrix.
 * @throws {TypeError} When an untagged stream has no positive integer coded height.
 */
export function resolveVideoColorMatrix(stream: Record<string, unknown>): string {
  const tag = stream.color_space;
  if (typeof tag === "string" && Object.hasOwn(TAGGED_MATRICES, tag)) return TAGGED_MATRICES[tag]!;
  const height = stream.height;
  if (typeof height !== "number" || !Number.isSafeInteger(height) || height <= 0) throw new TypeError("Expected the coded video height");
  return height >= 720 ? "bt709" : "bt601";
}

/**
 * The display size (§4.3): the size Chromium shows the coded picture at (`naturalSize`): a sample aspect ratio above 1
 * widens it and below 1 makes it taller, rounded; SAR 0:1 reads as square; a ±90 display rotation swaps the sides and a
 * mirror (rotation -180 or 0) keeps them. Container cropping is not shown.
 * @param stream - The selected ffprobe stream.
 * @returns The display width and height.
 * @throws {TypeError} When the coded size, SAR or rotation is malformed.
 */
export function videoDisplayGeometry(stream: Record<string, unknown>): { width: number; height: number } {
  const { width, height } = stream;
  if (typeof width !== "number" || typeof height !== "number" || !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    throw new TypeError("Expected the coded video size");
  }
  const sar = stream.sample_aspect_ratio;
  let ratio: { numerator: number; denominator: number } | undefined;
  if (sar !== undefined) {
    const match = typeof sar === "string" ? /^(\d+):(\d+)$/u.exec(sar) : null;
    if (match === null) throw new TypeError("Expected a sample aspect ratio");
    ratio = { numerator: Number(match[1]), denominator: Number(match[2]) };
  }
  const sideData = Array.isArray(stream.side_data_list) ? stream.side_data_list.map(probeObject) : [];
  const rotation = sideData.find((entry) => entry.side_data_type === "Display Matrix")?.rotation ?? 0;
  if (typeof rotation !== "number" || !Number.isFinite(rotation)) throw new TypeError("Expected a display rotation");
  return naturalSize(width, height, ratio, Math.abs(rotation) % 180 === 90);
}
