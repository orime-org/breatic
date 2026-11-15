// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import type { MatroskaPhysicalVideoProbe, PhysicalVideoProbe } from "@shared/upload/video-source-ledger-types.js";
export type { MatroskaPhysicalVideoProbe, PhysicalVideoProbe } from "@shared/upload/video-source-ledger-types.js";

import type { MatroskaMetadata } from "@ingest/container/matroska-metadata.js";

/**
 * Bind original selected FFprobe frame tokens to exact Matroska block headers.
 * @param streamMetadata - Original stream facts from the same immutable source.
 * @param physicalFrameBytes - Complete original frame JSON, including packet positions.
 * @param matroska - Bounded metadata from those same bytes.
 * @returns Dense selected frames and their actual Matroska track and block identities.
 * @throws {TypeError} When source facts or complete one-frame block association fail.
 * @throws {SyntaxError} When the original frame JSON is incomplete.
 */
export function parseMatroskaPhysicalVideoProbe(streamMetadata: unknown, physicalFrameBytes: Buffer, matroska: MatroskaMetadata): MatroskaPhysicalVideoProbe {
  const streams = probeObject(streamMetadata).streams;
  if (!Array.isArray(streams)) throw new TypeError("Expected original video stream metadata");
  const selected = streams.map(probeObject).find((stream) => stream.codec_type === "video");
  if (selected === undefined || typeof selected.index !== "number" || !Number.isSafeInteger(selected.index) || selected.index < 0 || streams.map(probeObject).filter((stream) => stream.index === selected.index).length !== 1) {
    throw new TypeError("Expected an unambiguous selected video stream");
  }
  const streamIndex = selected.index;
  const sourceTimeBase = probeTimeBase(selected.time_base);
  // The immutable reader supplies file-order, non-overlapping header intervals.
  // Index them once: each decoded position then costs a binary search instead
  // of scanning every audio and video block again for every frame.
  const headers = matroska.blocks.map((block) => ({ block, start: BigInt(block.elementOffset), end: BigInt(block.dataOffset) }));
  for (const [index, header] of headers.entries()) {
    if (header.start < 0n || header.end <= header.start || (index > 0 && headers[index - 1]!.end > header.start)) throw new TypeError("Expected unambiguous file-order block headers");
  }
  const parsed: unknown = JSON.parse(physicalFrameBytes.toString("utf8"),
    (key: string, value: unknown, context?: { source?: string }): unknown =>
      (key === "pts" || key === "pkt_pos") && typeof value === "number" ? context?.source : value);
  const values = probeObject(parsed).frames;
  if (!Array.isArray(values)) throw new TypeError("Expected complete original frame facts");
  const frames: MatroskaPhysicalVideoProbe["frames"] = [];
  const seen = new Set<number>();
  let trackNumber: string | undefined;
  for (const value of values) {
    const frame = probeObject(value);
    if (frame.stream_index !== streamIndex) continue;
    if (frame.media_type !== "video" || typeof frame.pts !== "string" || !/^-?\d+$/u.test(frame.pts) || typeof frame.pkt_pos !== "string" || !/^\d+$/u.test(frame.pkt_pos)) throw new TypeError("Expected exact selected-video PTS and original packet position");
    const position = BigInt(frame.pkt_pos);
    let low = 0;
    let high = headers.length;
    while (low < high) {
      const middle = low + Math.floor((high - low) / 2);
      if (headers[middle]!.start < position) low = middle + 1;
      else high = middle;
    }
    const header = headers[low - 1];
    if (header === undefined || position >= header.end) throw new TypeError("Packet position does not identify a source block header");
    const block = header.block;
    if (seen.has(block.blockOrdinal) || block.lacing !== "none" || block.frameCount !== 1) throw new TypeError("Expected a complete one-frame block association");
    if (trackNumber !== undefined && trackNumber !== block.trackNumber) throw new TypeError("Selected frames cross Matroska tracks");
    trackNumber = block.trackNumber;
    seen.add(block.blockOrdinal);
    frames.push({ rawDecodeOrdinal: frames.length, ptsTicks: frame.pts, blockOrdinal: block.blockOrdinal });
  }
  const tracks = matroska.tracks.filter((track) => track.trackNumber === trackNumber);
  if (frames.length === 0 || tracks.length !== 1 || tracks[0]!.trackType !== "1" || matroska.blocks.filter((block) => block.trackNumber === trackNumber).length !== frames.length) throw new TypeError("Expected complete selected video-track provenance");
  return { streamIndex, trackNumber: tracks[0]!.trackNumber, trackUid: tracks[0]!.trackUid, sourceTimeBase, frames };
}

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
 * Read the selected stream's positive ISO track identifier without prefix parsing.
 * @throws {TypeError} When the identifier is not a positive uint32.
 */
function probeTrackId(value: unknown): number {
  if (typeof value === "number") {
    if (Number.isInteger(value) && value > 0 && value <= 0xffffffff) return value;
  } else if (typeof value === "string" && /^(?:\d+|0[xX][\da-fA-F]+)$/.test(value)) {
    const id = BigInt(value);
    if (id > 0n && id <= 0xffffffffn) return Number(id);
  }
  throw new TypeError("Expected a positive uint32 video track identifier");
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

/**
 * Read original physical FFprobe bytes without rounding integer PTS.
 * @param metadata - Original stream metadata from the same immutable source.
 * @param physicalFrameBytes - Complete v:0 frame stdout produced with ignore_editlist enabled.
 * @throws {TypeError} When the selected stream, track, source clock or frame facts are invalid.
 * @throws {SyntaxError} When the original frame stdout is not complete JSON.
 */
export function parsePhysicalVideoProbe(metadata: unknown, physicalFrameBytes: Buffer): PhysicalVideoProbe {
  const streams = probeObject(metadata).streams;
  if (!Array.isArray(streams)) throw new TypeError("Expected original video stream metadata");
  const selected = streams.find((value: unknown) => typeof value === "object" && value !== null && !Array.isArray(value)
    && (value as Record<string, unknown>).codec_type === "video") as Record<string, unknown> | undefined;
  if (!selected || typeof selected.index !== "number" || !Number.isSafeInteger(selected.index) || selected.index < 0) {
    throw new TypeError("Expected a selected video stream index");
  }
  const streamIndex = selected.index;
  if (streams.filter((value: unknown) => typeof value === "object" && value !== null && !Array.isArray(value)
    && (value as Record<string, unknown>).index === streamIndex).length !== 1) {
    throw new TypeError("Expected an unambiguous selected video stream");
  }
  const trackId = probeTrackId(selected.id);
  const sourceTimeBase = probeTimeBase(selected.time_base);
  // Node 24 supplies the original primitive token before Number rounding.
  const parsed: unknown = JSON.parse(physicalFrameBytes.toString("utf8"),
    (key: string, value: unknown, context?: { source?: string }): unknown =>
      key === "pts" && typeof value === "number" ? context?.source : value);
  const values = probeObject(parsed).frames;
  if (!Array.isArray(values) || values.length === 0) throw new TypeError("Expected complete physical video frames");
  const frames = values.map((value: unknown, rawDecodeOrdinal: number) => {
    const frame = probeObject(value);
    if (frame.media_type !== "video" || frame.stream_index !== streamIndex
      || typeof frame.pts !== "string" || !/^-?\d+$/.test(frame.pts)) {
      throw new TypeError("Expected exact physical PTS from the selected video stream");
    }
    return { rawDecodeOrdinal, ptsTicks: frame.pts };
  });
  return { streamIndex, trackId, sourceTimeBase, frames };
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

/** Tagged ffprobe `color_space` values and the matrix the plan records for them. */
export const TAGGED_MATRICES: Readonly<Record<string, string>> = { bt709: "bt709", smpte170m: "bt601", bt470bg: "bt601", bt2020nc: "bt2020nc" };

/**
 * Resolve the colour matrix once for the plan (§4.3): a tag is kept; an untagged or `unknown` stream is BT.709 when its
 * coded height is at least 720 and BT.601 otherwise, whatever its rotation.
 * @param stream - The selected ffprobe stream.
 * @returns The matrix.
 * @throws {TypeError} When an untagged stream has no positive integer coded height.
 */
export function resolveVideoColorMatrix(stream: Record<string, unknown>): string {
  const tag = stream.color_space;
  if (typeof tag === "string" && tag !== "" && tag !== "unknown") return Object.hasOwn(TAGGED_MATRICES, tag) ? TAGGED_MATRICES[tag]! : tag;
  const height = stream.height;
  if (typeof height !== "number" || !Number.isSafeInteger(height) || height <= 0) throw new TypeError("Expected the coded video height");
  return height >= 720 ? "bt709" : "bt601";
}

/**
 * The display size (§4.3): the width scaled by SAR and truncated as FFmpeg `scale=iw*sar:ih`, SAR 0:1 read as 1:1, then
 * sides swapped for a ±90 display rotation; a mirror (rotation -180 or 0) keeps them.
 * @param stream - The selected ffprobe stream.
 * @returns The display width and height.
 * @throws {TypeError} When the coded size, SAR or rotation is malformed.
 */
export function videoDisplayGeometry(stream: Record<string, unknown>): { width: number; height: number } {
  const { width, height } = stream;
  if (typeof width !== "number" || typeof height !== "number" || !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    throw new TypeError("Expected the coded video size");
  }
  let displayWidth = width;
  const sar = stream.sample_aspect_ratio;
  if (sar !== undefined) {
    const match = typeof sar === "string" ? /^(\d+):(\d+)$/u.exec(sar) : null;
    if (match === null) throw new TypeError("Expected a sample aspect ratio");
    const [num, den] = [BigInt(match[1]!), BigInt(match[2]!)];
    if (num > 0n && den > 0n) displayWidth = Number((BigInt(width) * num) / den);
  }
  const sideData = Array.isArray(stream.side_data_list) ? stream.side_data_list.map(probeObject) : [];
  const rotation = sideData.find((entry) => entry.side_data_type === "Display Matrix")?.rotation ?? 0;
  if (typeof rotation !== "number" || !Number.isFinite(rotation)) throw new TypeError("Expected a display rotation");
  return Math.abs(rotation) % 180 === 90 ? { width: height, height: displayWidth } : { width: displayWidth, height };
}
