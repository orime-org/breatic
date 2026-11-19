// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { IsoBmffByteSource, IsoBmffCompositionRun, IsoBmffCompositionShift, IsoBmffDecodeRun } from "@ingest/container/iso-bmff-metadata.js";

export const SAMPLE_METADATA_LIMITS = { metadataBytes: 16384, boxCount: 128 };
export interface SampleRead { offset: bigint; length: number }
export interface SampleTrackFixture {
  trackId?: number;
  mediaTimescale?: number;
  mediaDuration?: number;
  trackDuration?: number;
  sampleBoxes?: readonly Buffer[];
}

/** Encode an ordinary atom independently from the metadata reader.
 * @throws {RangeError} When the fixture cannot fit the atom's unsigned size.
 */
export function sampleAtom(kind: string, payload: Uint8Array): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(payload.byteLength + 8, 0);
  header.write(kind, 4, 4, "ascii");
  return Buffer.concat([header, payload]);
}

/** Encode a real full-box stts table, retaining compressed runs.
 * @throws {RangeError} When a value exceeds its actual uint32 binary domain.
 */
export function sampleStts(runs: readonly IsoBmffDecodeRun[]): Buffer {
  const payload = Buffer.alloc(8 + runs.length * 8);
  payload.writeUInt32BE(runs.length, 4);
  for (const [index, run] of runs.entries()) {
    payload.writeUInt32BE(run.sampleCount, 8 + index * 8);
    payload.writeUInt32BE(Number(BigInt(run.deltaTicks)), 12 + index * 8);
  }
  return sampleAtom("stts", payload);
}

/** Encode the actual version-dependent composition-offset binary fields.
 * @throws {RangeError} When a fixture exceeds that version's integer domain.
 */
export function sampleCtts(version: 0 | 1, runs: readonly IsoBmffCompositionRun[]): Buffer {
  const payload = Buffer.alloc(8 + runs.length * 8);
  payload[0] = version;
  payload.writeUInt32BE(runs.length, 4);
  for (const [index, run] of runs.entries()) {
    payload.writeUInt32BE(run.sampleCount, 8 + index * 8);
    if (version === 0) payload.writeUInt32BE(Number(BigInt(run.offsetTicks)), 12 + index * 8);
    else payload.writeInt32BE(Number(BigInt(run.offsetTicks)), 12 + index * 8);
  }
  return sampleAtom("ctts", payload);
}

/** Encode all five signed cslg fields at the actual version's width.
 * @throws {RangeError} When a fixture exceeds its signed integer domain.
 */
export function sampleCslg(shift: IsoBmffCompositionShift): Buffer {
  const width = shift.version === 0 ? 4 : 8;
  const payload = Buffer.alloc(4 + width * 5);
  payload[0] = shift.version;
  const values = [shift.compositionToDtsShift, shift.leastDecodeToDisplayDelta, shift.greatestDecodeToDisplayDelta, shift.compositionStartTime, shift.compositionEndTime];
  for (const [index, value] of values.entries()) {
    if (width === 4) payload.writeInt32BE(Number(BigInt(value)), 4 + index * width);
    else payload.writeBigInt64BE(BigInt(value), 4 + index * width);
  }
  return sampleAtom("cslg", payload);
}

/** Wrap sample tables inside their own identified trak/mdia/minf/stbl hierarchy.
 * @throws {RangeError} When a fixed header value cannot fit its binary field.
 */
export function sampleTrack(input: SampleTrackFixture = {}): Buffer {
  const tkhd = Buffer.alloc(84);
  tkhd.writeUIntBE(3, 1, 3);
  tkhd.writeUInt32BE(input.trackId ?? 7, 12);
  tkhd.writeUInt32BE(input.trackDuration ?? 120, 20);
  const mdhd = Buffer.alloc(24);
  mdhd.writeUInt32BE(input.mediaTimescale ?? 1000, 12);
  mdhd.writeUInt32BE(input.mediaDuration ?? 120, 16);
  return sampleAtom("trak", Buffer.concat([
    sampleAtom("tkhd", tkhd),
    sampleAtom("mdia", Buffer.concat([sampleAtom("mdhd", mdhd), sampleAtom("minf", sampleAtom("stbl", Buffer.concat(input.sampleBoxes ?? [])))])),
  ]));
}

/** Build a real no-elst movie; movie extent is intentionally independent from sample timing.
 * @throws {RangeError} When the movie duration is outside the fixture's uint32 field.
 */
export function sampleMovie(tracks: readonly Buffer[], movieDuration = 4000): Buffer {
  const mvhd = Buffer.alloc(100);
  mvhd.writeUInt32BE(1000, 12);
  mvhd.writeUInt32BE(movieDuration, 16);
  return sampleAtom("moov", Buffer.concat([sampleAtom("mvhd", mvhd), ...tracks]));
}

/** Supply exact binary bytes and record bounded metadata IO without mocking parsing.
 * @throws {never} Never.
 */
export function sampleByteSource(bytes: Uint8Array, reads: SampleRead[] = []): IsoBmffByteSource {
  return { size: BigInt(bytes.byteLength), read: async (offset, length) => {
    reads.push({ offset, length });
    return bytes.subarray(Number(offset), Number(offset) + length);
  } };
}
