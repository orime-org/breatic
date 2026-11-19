// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { IsoBmffEdit, IsoBmffCompositionShift, IsoBmffSampleTiming, IsoBmffTrackMetadata } from "@shared/upload/video-source-ledger-types.js";
export type { IsoBmffEdit, IsoBmffDecodeRun, IsoBmffCompositionRun, IsoBmffCompositionShift, IsoBmffSampleTiming, IsoBmffTrackMetadata } from "@shared/upload/video-source-ledger-types.js";

import { open } from "node:fs/promises";

/** A read-only immutable byte object; offsets retain the full source integer domain. */
export interface IsoBmffByteSource {
  size: bigint;
  read: (offset: bigint, length: number) => Promise<Uint8Array>;
}
/** Caller-frozen resource ceilings, with no operational defaults in the reader. */
export interface IsoBmffReadLimits { metadataBytes: number; boxCount: number }
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
  validateLimits(limits);
  if (typeof source.size !== "bigint" || source.size < 0n) throw metadataError("invalid_box", "Invalid source size");
  return new MetadataReader(source, limits).inspect();
}

/**
 * Read an already downloaded local object through bounded random-access metadata IO.
 * @param path - The trusted immutable local file.
 * @param limits - Frozen metadata resource ceilings.
 * @returns Complete owned clock/edit facts after closing the file.
 * @throws {Error} When opening, reading or validating fails.
 */
export async function inspectIsoBmffFile(path: string, limits: IsoBmffReadLimits): Promise<IsoBmffMetadata> {
  validateLimits(limits);
  const file = await open(path, "r");
  try {
    const stat = await file.stat({ bigint: true });
    return await inspectIsoBmffMetadata({
      size: stat.size,
      read: async (offset, length) => {
        const bytes = Buffer.alloc(length);
        let filled = 0;
        while (filled < length) {
          const result = await file.read(bytes, filled, length - filled, offset + BigInt(filled));
          if (result.bytesRead === 0) break;
          filled += result.bytesRead;
        }
        return bytes.subarray(0, filled);
      },
    }, limits);
  } finally {
    await file.close();
  }
}


interface MetadataBox { kind: string; start: bigint; end: bigint }
interface HeaderClock { timescale: string; duration: string }
interface TrackHeader { trackId: number; trackFlags: number; duration: string }
interface SampleRuns { version: 0 | 1; entries: { sampleCount: number; value: string }[] }

/** Construct a classified metadata failure without replacing the underlying IO cause.
 * @throws {never} Never.
 */
function metadataError(code: string, message: string, cause?: unknown): Error & { code: string } {
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), { code });
}

/** Check caller-frozen ceilings before accessing a source or allocating read buffers.
 * @throws {Error} When either ceiling is not a positive safe integer.
 */
function validateLimits(limits: IsoBmffReadLimits): void {
  if (!Number.isSafeInteger(limits.metadataBytes) || limits.metadataBytes <= 0 || !Number.isSafeInteger(limits.boxCount) || limits.boxCount <= 0) {
    throw metadataError("invalid_limits", "Metadata ceilings must be positive safe integers");
  }
}

/** Traverse only the fixed metadata hierarchy, sharing one cumulative IO budget. */
class MetadataReader {
  private bytesRead = 0;
  private boxesRead = 0;

  /** Bind an immutable source and validated caller ceilings.
   * @throws {never} Never.
   */
  constructor(private readonly source: IsoBmffByteSource, private readonly limits: IsoBmffReadLimits) {}

  /** Read an exact bounded range; a partial source response is never padded.
   * @throws {Error} When bounds, budgets or actual IO fail.
   */
  private async read(offset: bigint, length: number): Promise<Uint8Array> {
    if (offset < 0n || !Number.isSafeInteger(length) || length < 0 || offset + BigInt(length) > this.source.size) {
      throw metadataError("invalid_box", "Metadata read crosses source bounds");
    }
    if (length > this.limits.metadataBytes - this.bytesRead) throw metadataError("resource_limit", "Metadata byte ceiling exceeded");
    this.bytesRead += length;
    let bytes: Uint8Array;
    try { bytes = await this.source.read(offset, length); }
    catch (cause) { throw metadataError("read_failed", "Metadata source read failed", cause); }
    if (bytes.byteLength !== length) throw metadataError("truncated_read", "Metadata source returned an incomplete range");
    return bytes;
  }

  /** Scan direct children while skipping all payloads by their exact integer extents.
   * @throws {Error} When a box is malformed or traversal exceeds the frozen budget.
   */
  private async children(start: bigint, end: bigint): Promise<MetadataBox[]> {
    const boxes: MetadataBox[] = [];
    let offset = start;
    while (offset < end) {
      if (end - offset < 8n) throw metadataError("invalid_box", "Incomplete box header within parent");
      if (this.boxesRead >= this.limits.boxCount) throw metadataError("resource_limit", "Metadata box ceiling exceeded");
      this.boxesRead += 1;
      const bytes = await this.read(offset, 8);
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const size32 = view.getUint32(0);
      const kind = String.fromCharCode(bytes[4]!, bytes[5]!, bytes[6]!, bytes[7]!);
      let headerLength = 8n;
      let size = BigInt(size32);
      if (size32 === 1) {
        if (end - offset < 16n) throw metadataError("invalid_box", "Incomplete extended box header");
        const extended = await this.read(offset + 8n, 8);
        size = new DataView(extended.buffer, extended.byteOffset, extended.byteLength).getBigUint64(0);
        headerLength = 16n;
      } else if (size32 === 0) {
        size = this.source.size - offset;
      }
      if (size < headerLength || size > end - offset) throw metadataError("invalid_box", "Box extent crosses its parent or source");
      boxes.push({ kind, start: offset + headerLength, end: offset + size });
      offset += size;
    }
    return boxes;
  }

  /** Read a complete standard fixed header after validating its full-box version.
   * @throws {Error} When a version or the required payload length is invalid.
   */
  private async fixedHeader(box: MetadataBox, length0: number, length1: number): Promise<DataView> {
    if (box.end - box.start < 4n) throw metadataError("invalid_box", "Incomplete full-box header");
    const prefix = await this.read(box.start, 4);
    const version = prefix[0]!;
    if (version !== 0 && version !== 1) throw metadataError("unsupported_version", "Unsupported metadata full-box version");
    const length = version === 0 ? length0 : length1;
    if (box.end - box.start < BigInt(length)) throw metadataError("invalid_box", "Incomplete metadata header payload");
    const rest = await this.read(box.start + 4n, length - 4);
    const complete = new Uint8Array(length);
    complete.set(prefix); complete.set(rest, 4);
    return new DataView(complete.buffer);
  }

  /** Decode an unsigned movie or media clock without interpreting its duration as a window.
   * @throws {Error} When a header or its clock divisor is invalid.
   */
  private async clock(box: MetadataBox): Promise<HeaderClock> {
    const view = await this.fixedHeader(box, box.kind === "mvhd" ? 100 : 24, box.kind === "mvhd" ? 112 : 36);
    const version = view.getUint8(0);
    const timescale = view.getUint32(version === 0 ? 12 : 20);
    if (timescale === 0) throw metadataError("invalid_clock", "Metadata timescale must be positive");
    const duration = version === 0 ? BigInt(view.getUint32(16)) : view.getBigUint64(24);
    return { timescale: String(timescale), duration: duration.toString() };
  }

  /** Decode track identity, enabled flags and its complete unsigned duration fact.
   * @throws {Error} When the track header cannot be read exactly.
   */
  private async trackHeader(box: MetadataBox): Promise<TrackHeader> {
    const view = await this.fixedHeader(box, 84, 96);
    const version = view.getUint8(0);
    const trackFlags = (view.getUint8(1) << 16) | (view.getUint8(2) << 8) | view.getUint8(3);
    return { trackId: view.getUint32(version === 0 ? 12 : 20), trackFlags, duration: (version === 0 ? BigInt(view.getUint32(20)) : view.getBigUint64(28)).toString() };
  }

  /** Preserve every edit and the entire signed fixed-point rate, including unsupported rates.
   * @throws {Error} When an edit version, count, payload or budget is invalid.
   */
  private async editList(box: MetadataBox): Promise<IsoBmffEdit[]> {
    if (box.end - box.start < 8n) throw metadataError("invalid_box", "Incomplete edit-list header");
    const prefix = await this.read(box.start, 8);
    const view = new DataView(prefix.buffer, prefix.byteOffset, prefix.byteLength);
    const version = view.getUint8(0);
    if (version !== 0 && version !== 1) throw metadataError("unsupported_version", "Unsupported edit-list version");
    const count = view.getUint32(4);
    const stride = version === 0 ? 12 : 20;
    const length = count * stride;
    if (BigInt(length) > box.end - box.start - 8n) throw metadataError("invalid_box", "Edit count exceeds its complete payload");
    const bytes = await this.read(box.start + 8n, length);
    const entries = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const edits: IsoBmffEdit[] = [];
    for (let index = 0; index < count; index += 1) {
      const offset = index * stride;
      edits.push({
        segmentDurationMovieTicks: (version === 0 ? BigInt(entries.getUint32(offset)) : entries.getBigUint64(offset)).toString(),
        mediaTimeTrackTicks: (version === 0 ? BigInt(entries.getInt32(offset + 4)) : entries.getBigInt64(offset + 8)).toString(),
        mediaRateFixed16_16: String(entries.getInt32(offset + (version === 0 ? 8 : 16))),
      });
    }
    return edits;
  }

  /** Read compressed sample runs with their actual full-box signedness.
   * @param box - The track's stts or ctts table.
   * @returns Exact counts and integer deltas or composition offsets.
   * @throws {Error} When a version, extent or cumulative read budget fails.
   */
  private async sampleRuns(box: MetadataBox): Promise<SampleRuns> {
    if (box.end - box.start < 8n) throw metadataError("invalid_box", "Incomplete sample timing header");
    const prefix = await this.read(box.start, 8);
    const header = new DataView(prefix.buffer, prefix.byteOffset, prefix.byteLength);
    const version = header.getUint8(0);
    if (version !== 0 && (box.kind !== "ctts" || version !== 1)) {
      throw metadataError("unsupported_version", "Unsupported sample timing version");
    }
    const count = header.getUint32(4);
    const length = count * 8;
    if (BigInt(length) > box.end - box.start - 8n) throw metadataError("invalid_box", "Sample timing count exceeds its payload");
    const bytes = await this.read(box.start + 8n, length);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const entries: SampleRuns["entries"] = [];
    for (let index = 0; index < count; index += 1) {
      entries.push({ sampleCount: view.getUint32(index * 8), value: String(version === 1 ? view.getInt32(index * 8 + 4) : view.getUint32(index * 8 + 4)) });
    }
    return { version, entries };
  }

  /** Preserve the five signed composition-shift facts without choosing a display window.
   * @param box - The selected track's cslg box.
   * @returns The actual version and exact signed fields.
   * @throws {Error} When the version, extent or read budget fails.
   */
  private async compositionShift(box: MetadataBox): Promise<IsoBmffCompositionShift> {
    const view = await this.fixedHeader(box, 24, 44);
    const version = view.getUint8(0) as 0 | 1;
    const values: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      values.push((version === 0 ? BigInt(view.getInt32(4 + index * 4)) : view.getBigInt64(4 + index * 8)).toString());
    }
    return { version, compositionToDtsShift: values[0]!, leastDecodeToDisplayDelta: values[1]!, greatestDecodeToDisplayDelta: values[2]!, compositionStartTime: values[3]!, compositionEndTime: values[4]! };
  }

  /** Traverse this track's sample tables under the existing cumulative metadata ceilings.
   * @param mediaChildren - Direct children of the identified track's mdia box.
   * @returns Sample timing when stts exists, preserving the old absent-field shape otherwise.
   * @throws {Error} When hierarchy, timing versions, duplicates or budgets fail.
   */
  private async sampleTiming(mediaChildren: MetadataBox[]): Promise<IsoBmffSampleTiming | undefined> {
    const minf = this.unique(mediaChildren, "minf", false);
    if (!minf) return undefined;
    const stbl = this.unique(await this.children(minf.start, minf.end), "stbl", false);
    if (!stbl) return undefined;
    const tables = await this.children(stbl.start, stbl.end);
    const stts = this.unique(tables, "stts", false);
    const ctts = this.unique(tables, "ctts", false);
    const cslg = this.unique(tables, "cslg", false);
    if (!stts) return undefined;
    const decode = await this.sampleRuns(stts);
    const composition = ctts ? await this.sampleRuns(ctts) : null;
    return {
      decodeRuns: decode.entries.map((entry) => ({ sampleCount: entry.sampleCount, deltaTicks: entry.value })),
      cttsVersion: composition?.version ?? null,
      compositionRuns: composition?.entries.map((entry) => ({ sampleCount: entry.sampleCount, offsetTicks: entry.value })) ?? null,
      compositionShift: cslg ? await this.compositionShift(cslg) : null,
    };
  }

  /** Select one required child without silently discarding duplicate metadata.
   * @throws {Error} When a required child is absent or multiple matching children exist.
   */
  private unique(boxes: MetadataBox[], kind: string, required: boolean): MetadataBox | undefined {
    const matches = boxes.filter((box) => box.kind === kind);
    if (matches.length > 1) throw metadataError("duplicate_metadata", `Duplicate ${kind} metadata`);
    if (required && matches.length === 0) throw metadataError("missing_metadata", `Missing ${kind} metadata`);
    return matches[0];
  }

  /** Bind media and edit facts to the identified track independent of child order.
   * @throws {Error} When required facts are absent, duplicated or malformed.
   */
  private async track(box: MetadataBox): Promise<IsoBmffTrackMetadata> {
    const children = await this.children(box.start, box.end);
    const header = await this.trackHeader(this.unique(children, "tkhd", true)!);
    const media = this.unique(children, "mdia", true)!;
    const mediaChildren = await this.children(media.start, media.end);
    const clock = await this.clock(this.unique(mediaChildren, "mdhd", true)!);
    const editContainer = this.unique(children, "edts", false);
    let edits: IsoBmffEdit[] | null = null;
    if (editContainer) {
      const edit = this.unique(await this.children(editContainer.start, editContainer.end), "elst", false);
      if (edit) edits = await this.editList(edit);
    }
    const sampleTiming = await this.sampleTiming(mediaChildren);
    return { trackId: header.trackId, trackFlags: header.trackFlags, durationMovieTicks: header.duration, mediaTimescale: clock.timescale, mediaDurationTicks: clock.duration, edits, ...(sampleTiming === undefined ? {} : { sampleTiming }) };
  }

  /** Inspect a single movie and every identified track using only bounded metadata reads.
   * @throws {Error} When any required metadata or resource invariant fails.
   */
  async inspect(): Promise<IsoBmffMetadata> {
    const top = await this.children(0n, this.source.size);
    const movies = top.filter((box) => box.kind === "moov");
    if (movies.length > 1) throw metadataError("unsupported_structure", "Multiple movie boxes require an explicit selection contract");
    if (movies.length === 0) throw metadataError("missing_metadata", "Missing movie metadata");
    const movie = movies[0]!;
    const children = await this.children(movie.start, movie.end);
    const clock = await this.clock(this.unique(children, "mvhd", true)!);
    const tracks: IsoBmffTrackMetadata[] = [];
    const identities = new Set<number>();
    for (const box of children) {
      if (box.kind !== "trak") continue;
      const track = await this.track(box);
      if (identities.has(track.trackId)) throw metadataError("duplicate_metadata", "Duplicate track identity");
      identities.add(track.trackId); tracks.push(track);
    }
    return { movieTimescale: clock.timescale, movieDurationTicks: clock.duration, tracks };
  }
}
