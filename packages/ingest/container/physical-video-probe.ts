// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/** Exact physical video facts retain their original selected stream and integer clock. */
export interface PhysicalVideoProbe {
  streamIndex: number;
  trackId: number;
  sourceTimeBase: { numerator: string; denominator: string };
  frames: { rawDecodeOrdinal: number; ptsTicks: string }[];
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
