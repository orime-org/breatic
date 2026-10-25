// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/** A read-only immutable byte object; offsets retain the full source integer domain. */
export interface IsoBmffByteSource {
  size: bigint;
  read: (offset: bigint, length: number) => Promise<Uint8Array>;
}
/** Caller-frozen resource ceilings, with no operational defaults in the reader. */
export interface IsoBmffReadLimits { metadataBytes: number; boxCount: number }
/** Complete source edit facts; fixed rate is the original signed 32-bit 16.16 integer. */
export interface IsoBmffEdit {
  segmentDurationMovieTicks: string;
  mediaTimeTrackTicks: string;
  mediaRateFixed16_16: string;
}
/** One explicitly identified track, without inferring its codec or legal display extent. */
export interface IsoBmffTrackMetadata {
  trackId: number;
  trackFlags: number;
  durationMovieTicks: string;
  mediaTimescale: string;
  mediaDurationTicks: string;
  edits: IsoBmffEdit[] | null;
}
/** Integer container facts only; decoder and native playback observations remain separate. */
export interface IsoBmffMetadata {
  movieTimescale: string;
  movieDurationTicks: string;
  tracks: IsoBmffTrackMetadata[];
}

/**
 * Read bounded movie/track clocks and complete edit facts without loading media payloads.
 * @param source - Immutable bytes with exact source offsets.
 * @param limits - Frozen metadata IO and box-count ceilings.
 * @returns Owned integer facts, without selecting or decoding presentation frames.
 * @throws {Error} When metadata validation or the caller's budget fails.
 */
export async function inspectIsoBmffMetadata(source: IsoBmffByteSource, limits: IsoBmffReadLimits): Promise<IsoBmffMetadata> {
  void source; void limits;
  throw new Error("ISO-BMFF metadata implementation awaits independent RED");
}

/**
 * Read an already downloaded local object through bounded random-access metadata IO.
 * @param path - The trusted immutable local file.
 * @param limits - Frozen metadata resource ceilings.
 * @returns Complete owned clock/edit facts after closing the file.
 * @throws {Error} When opening, reading or validating fails.
 */
export async function inspectIsoBmffFile(path: string, limits: IsoBmffReadLimits): Promise<IsoBmffMetadata> {
  void path; void limits;
  throw new Error("ISO-BMFF file adapter awaits independent RED");
}
