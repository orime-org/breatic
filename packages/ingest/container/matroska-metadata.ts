// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/** Immutable source bytes with exact integer random-access offsets. */
export interface MatroskaByteSource {
  size: bigint;
  read: (offset: bigint, length: number) => Promise<Uint8Array>;
}
/** All metadata resource ceilings are supplied by the caller. */
export interface MatroskaReadLimits { metadataBytes: number; elementCount: number; maxBlocks: number }
/** Exact rational value of the original IEEE-754 track-scale representation. */
export interface MatroskaTrackScale { numerator: string; denominator: string }
/** Track identity and effective format defaults, without choosing a video stream. */
export interface MatroskaTrackMetadata {
  trackNumber: string;
  trackUid: string;
  trackType: string;
  codecId: string;
  enabled: boolean;
  defaultDurationNs: string | null;
  trackTimestampScale: MatroskaTrackScale;
  codecDelayNs: string;
}
/** Physical block facts in file order; offsets never identify a BlockGroup wrapper. */
export interface MatroskaBlockMetadata {
  blockOrdinal: number;
  kind: "simple" | "group";
  /** Absolute byte offset of the SimpleBlock or internal Block element ID. */
  elementOffset: string;
  /** First codec frame byte, after the complete block and lace headers. */
  dataOffset: string;
  /** Total codec frame payload bytes, excluding every metadata header. */
  dataBytes: string;
  trackNumber: string;
  clusterTimestampTicks: string;
  relativeTimestampTicks: string;
  invisible: boolean;
  lacing: "none" | "xiph" | "fixed" | "ebml";
  frameCount: number;
  blockDurationTicks: string | null;
  discardPaddingNs: string | null;
}
/** Complete bounded container metadata; no decoded or legal presentation schedule. */
export interface MatroskaMetadata {
  timestampScaleNs: string;
  tracks: MatroskaTrackMetadata[];
  blocks: MatroskaBlockMetadata[];
}

/**
 * Read exact EBML metadata while skipping compressed frame payloads.
 * @throws {Error} Until the independently specified reader is implemented.
 */
export async function inspectMatroskaMetadata(source: MatroskaByteSource, limits: MatroskaReadLimits): Promise<MatroskaMetadata> {
  void source; void limits;
  throw Object.assign(new Error("Matroska metadata reader is not implemented"), { code: "not_implemented" });
}

/**
 * Read a trusted local immutable object using the same bounded byte-source contract.
 * @throws {Error} Until the independently specified file adapter is implemented.
 */
export async function inspectMatroskaFile(path: string, limits: MatroskaReadLimits): Promise<MatroskaMetadata> {
  void path; void limits;
  throw Object.assign(new Error("Matroska file reader is not implemented"), { code: "not_implemented" });
}
