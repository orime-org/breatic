// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { MatroskaTrackScale, MatroskaTrackMetadata, MatroskaBlockMetadata } from "@shared/upload/video-source-ledger-types.js";
export type { MatroskaTrackScale, MatroskaTrackMetadata, MatroskaBlockMetadata } from "@shared/upload/video-source-ledger-types.js";

import { open } from "node:fs/promises";

/** Immutable source bytes with exact integer random-access offsets. */
export interface MatroskaByteSource {
  size: bigint;
  read: (offset: bigint, length: number) => Promise<Uint8Array>;
}
/** All metadata resource ceilings are supplied by the caller. */
export interface MatroskaReadLimits { metadataBytes: number; elementCount: number; maxBlocks: number }
/** Complete bounded container metadata; no decoded or legal presentation schedule. */
export interface MatroskaMetadata {
  timestampScaleNs: string;
  tracks: MatroskaTrackMetadata[];
  blocks: MatroskaBlockMetadata[];
}

/**
 * Read exact EBML metadata while skipping compressed frame payloads.
 * @param source - Immutable source bytes with exact offsets.
 * @param limits - Caller-frozen cumulative resource ceilings.
 * @returns Complete container facts without decoding or display policy.
 * @throws {Error} When metadata, source IO or a frozen ceiling fails.
 */
export async function inspectMatroskaMetadata(source: MatroskaByteSource, limits: MatroskaReadLimits): Promise<MatroskaMetadata> {
  validateLimits(limits);
  if (typeof source.size !== "bigint" || source.size < 0n) throw metadataError("invalid_element", "Invalid immutable source size");
  return new MatroskaReader(source, limits).inspect();
}

/**
 * Read a trusted local immutable object using the same bounded byte-source contract.
 * @param path - Trusted downloaded source object.
 * @param limits - Caller-frozen metadata ceilings.
 * @returns Complete container facts after closing the source handle.
 * @throws {Error} When the file, metadata or resource limits fail.
 */
export async function inspectMatroskaFile(path: string, limits: MatroskaReadLimits): Promise<MatroskaMetadata> {
  validateLimits(limits);
  const file = await open(path, "r");
  try {
    const stat = await file.stat({ bigint: true });
    return await inspectMatroskaMetadata({ size: stat.size, read: async (offset, length) => {
      const bytes = Buffer.alloc(length);
      let filled = 0;
      while (filled < length) {
        const result = await file.read(bytes, filled, length - filled, offset + BigInt(filled));
        if (result.bytesRead === 0) break;
        filled += result.bytesRead;
      }
      return bytes.subarray(0, filled);
    } }, limits);
  } finally { await file.close(); }
}

interface MetadataElement { id: string; offset: bigint; start: bigint; end: bigint; unknown: boolean }
interface Vint { value: bigint; width: number; bytes: Uint8Array }
interface ClusterResult { next?: MetadataElement; end: bigint; blocks: MatroskaBlockMetadata[] }
type UnboundBlock = Omit<MatroskaBlockMetadata, "clusterTimestampTicks">;
const LEVEL_ONE = new Set(["114d9b74", "1549a966", "1654ae6b", "1f43b675", "1c53bb6b", "1941a469", "1043a770", "1254c367"]);

/** Validate frozen resource ceilings before even opening a local source.
 * @throws {Error} When a ceiling is not a positive safe integer.
 */
function validateLimits(limits: MatroskaReadLimits): void {
  for (const value of [limits.metadataBytes, limits.elementCount, limits.maxBlocks]) {
    if (!Number.isSafeInteger(value) || value <= 0) throw metadataError("invalid_limits", "Metadata ceilings must be positive safe integers");
  }
}

/** Classify a metadata failure while retaining an original IO cause.
 * @throws {never} Never.
 */
function metadataError(code: string, message: string, cause?: unknown): Error & { code: string } {
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), { code });
}

/** Read only the bounded metadata hierarchy and block headers of one immutable document. */
class MatroskaReader {
  private bytesRead = 0;
  private elementsRead = 0;
  private blocksRead = 0;

  /** Bind an immutable source and validated operational ceilings.
   * @throws {never} Never.
   */
  constructor(private readonly source: MatroskaByteSource, private readonly limits: MatroskaReadLimits) {}

  /** Read a complete range without padding, rounding offsets or crossing the cumulative budget.
   * @throws {Error} When bounds, budget or the underlying source fails.
   */
  private async read(offset: bigint, length: number, end = this.source.size): Promise<Uint8Array> {
    if (offset < 0n || !Number.isSafeInteger(length) || length < 0 || offset + BigInt(length) > end || end > this.source.size) throw metadataError("invalid_element", "Metadata range crosses its source or parent");
    if (length > this.limits.metadataBytes - this.bytesRead) throw metadataError("resource_limit", "Metadata byte ceiling exceeded");
    this.bytesRead += length;
    let bytes: Uint8Array;
    try { bytes = await this.source.read(offset, length); }
    catch (cause) { throw metadataError("read_failed", "Metadata source read failed", cause); }
    if (bytes.byteLength !== length) throw metadataError("truncated_read", "Metadata source returned incomplete bytes");
    return bytes;
  }

  /** Decode a bounded VINT, retaining its original bytes for element IDs.
   * @throws {Error} When a marker, width, extent or resource budget is invalid.
   */
  private async vint(offset: bigint, end: bigint, maximumWidth = 8): Promise<Vint> {
    const first = (await this.read(offset, 1, end))[0]!;
    let width = 1;
    let marker = 0x80;
    while (marker !== 0 && (first & marker) === 0) { marker >>= 1; width += 1; }
    if (marker === 0 || width > maximumWidth) throw metadataError("invalid_element", "Invalid EBML VINT marker or width");
    const bytes = new Uint8Array(width);
    bytes[0] = first;
    if (width > 1) bytes.set(await this.read(offset + 1n, width - 1, end), 1);
    let value = BigInt(first & (marker - 1));
    for (let index = 1; index < width; index += 1) value = value * 256n + BigInt(bytes[index]!);
    return { value, width, bytes };
  }

  /** Read one element header, keeping unknown-size state separate from a known parent boundary.
   * @throws {Error} When an element crosses a parent or exhausts metadata resources.
   */
  private async element(offset: bigint, end: bigint): Promise<MetadataElement> {
    if (this.elementsRead >= this.limits.elementCount) throw metadataError("resource_limit", "Metadata element ceiling exceeded");
    this.elementsRead += 1;
    const id = await this.vint(offset, end, 4);
    const size = await this.vint(offset + BigInt(id.width), end);
    const start = offset + BigInt(id.width + size.width);
    const unknown = size.value === (1n << BigInt(size.width * 7)) - 1n;
    const bound = unknown ? end : start + size.value;
    if (bound > end) throw metadataError("invalid_element", "Element extent crosses its declared parent");
    return { id: Buffer.from(id.bytes).toString("hex"), offset, start, end: bound, unknown };
  }

  /** Enumerate a known-size master without reading any unknown child's payload.
   * @throws {Error} When a child lacks an allowed explicit extent or exceeds the parent.
   */
  private async children(parent: MetadataElement): Promise<MetadataElement[]> {
    if (parent.unknown) throw metadataError("unsupported_structure", "Unknown-size metadata hierarchy is not supported here");
    const result: MetadataElement[] = [];
    let offset = parent.start;
    while (offset < parent.end) {
      const child = await this.element(offset, parent.end);
      if (child.unknown) throw metadataError("unsupported_structure", "Unknown-size metadata child has no supported hierarchy");
      result.push(child); offset = child.end;
    }
    return result;
  }

  /** Resolve one singleton fact without silently selecting a duplicate.
   * @throws {Error} When a singleton is duplicated or a required field is missing.
   */
  private unique(elements: MetadataElement[], id: string, required = false): MetadataElement | undefined {
    const matches = elements.filter((element) => element.id === id);
    if (matches.length > 1) throw metadataError("duplicate_metadata", "Duplicate singleton metadata");
    if (required && matches.length === 0) throw metadataError("missing_metadata", "Missing required metadata");
    return matches[0];
  }

  /** Decode an exact signed or unsigned EBML integer, including a normative empty value.
   * @throws {Error} When its width, extent or cumulative budget is invalid.
   */
  private async integer(element: MetadataElement, signed = false, empty = 0n): Promise<bigint> {
    const width = element.end - element.start;
    if (width > 8n) throw metadataError("invalid_element", "EBML integer exceeds its wire width");
    if (width === 0n) return empty;
    const bytes = await this.read(element.start, Number(width), element.end);
    let value = 0n;
    for (const byte of bytes) value = value * 256n + BigInt(byte);
    return signed && (bytes[0]! & 0x80) !== 0 ? value - (1n << (width * 8n)) : value;
  }

  /** Retain the exact positive IEEE representation, with the format's empty default.
   * @throws {Error} When the encoded scale has invalid width or no finite positive value.
   */
  private async scale(element: MetadataElement | undefined): Promise<MatroskaTrackScale> {
    if (element === undefined || element.end === element.start) return { numerator: "1", denominator: "1" };
    const width = element.end - element.start;
    if (width !== 4n && width !== 8n) throw metadataError("invalid_element", "Invalid IEEE track-scale width");
    const bytes = await this.read(element.start, Number(width), element.end);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const raw = width === 4n ? BigInt(view.getUint32(0)) : view.getBigUint64(0);
    const mantissaBits = width === 4n ? 23n : 52n;
    const exponentBits = width === 4n ? 8n : 11n;
    const exponentMask = (1n << exponentBits) - 1n;
    const exponent = (raw >> mantissaBits) & exponentMask;
    if ((raw >> (mantissaBits + exponentBits)) !== 0n || exponent === exponentMask) throw metadataError("invalid_element", "Track scale must be finite and positive");
    let numerator = raw & ((1n << mantissaBits) - 1n);
    if (exponent !== 0n) numerator += 1n << mantissaBits;
    if (numerator === 0n) throw metadataError("invalid_element", "Track scale must be positive");
    const bias = (1n << (exponentBits - 1n)) - 1n;
    const power = (exponent === 0n ? 1n - bias : exponent - bias) - mantissaBits;
    let denominator = 1n;
    if (power >= 0n) numerator <<= power;
    else denominator <<= -power;
    while ((numerator & 1n) === 0n && (denominator & 1n) === 0n) { numerator >>= 1n; denominator >>= 1n; }
    return { numerator: numerator.toString(), denominator: denominator.toString() };
  }

  /** Decode one actual track's fields, leaving absent DefaultDuration unknown.
   * @throws {Error} When a required identity, field width or singleton is invalid.
   */
  private async track(element: MetadataElement): Promise<MatroskaTrackMetadata> {
    const fields = await this.children(element);
    const number = await this.integer(this.unique(fields, "d7", true)!);
    const uid = await this.integer(this.unique(fields, "73c5", true)!);
    const type = await this.integer(this.unique(fields, "83", true)!);
    const codec = this.unique(fields, "86", true)!;
    const codecId = new TextDecoder("utf-8", { fatal: true }).decode(await this.read(codec.start, Number(codec.end - codec.start), codec.end)).replace(/\0+$/u, "");
    if (number <= 0n || uid <= 0n || type <= 0n || codecId.length === 0) throw metadataError("invalid_element", "Invalid required track identity");
    const flag = this.unique(fields, "b9");
    const enabled = flag === undefined ? 1n : await this.integer(flag, false, 1n);
    if (enabled !== 0n && enabled !== 1n) throw metadataError("invalid_element", "Invalid track enabled flag");
    const duration = this.unique(fields, "23e383");
    const delay = this.unique(fields, "56aa");
    return { trackNumber: number.toString(), trackUid: uid.toString(), trackType: type.toString(), codecId, enabled: enabled === 1n,
      defaultDurationNs: duration === undefined ? null : (await this.integer(duration)).toString(),
      trackTimestampScale: await this.scale(this.unique(fields, "23314f")), codecDelayNs: delay === undefined ? "0" : (await this.integer(delay)).toString() };
  }

  /** Read complete block and lace headers, leaving all codec bytes untouched.
   * @throws {Error} When the header, lacing sizes or resource ceilings fail.
   */
  private async block(element: MetadataElement, kind: "simple" | "group", duration: string | null, padding: string | null): Promise<UnboundBlock> {
    if (this.blocksRead >= this.limits.maxBlocks) throw metadataError("resource_limit", "Metadata block ceiling exceeded");
    const track = await this.vint(element.start, element.end);
    if (track.value === 0n) throw metadataError("invalid_element", "A block requires a positive track number");
    let offset = element.start + BigInt(track.width);
    const header = await this.read(offset, 3, element.end);
    const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
    const flags = header[2]!;
    const lacing = (["none", "xiph", "fixed", "ebml"] as const)[(flags >> 1) & 3]!;
    offset += 3n;
    let frameCount = 1;
    const sizes: bigint[] = [];
    if (lacing !== "none") {
      frameCount = (await this.read(offset, 1, element.end))[0]! + 1; offset += 1n;
      for (let index = 0; index < frameCount - 1 && lacing !== "fixed"; index += 1) {
        let size: bigint;
        if (lacing === "xiph") {
          size = 0n;
          let byte: number;
          do { byte = (await this.read(offset, 1, element.end))[0]!; offset += 1n; size += BigInt(byte); } while (byte === 255);
        } else {
          const encoded = await this.vint(offset, element.end); offset += BigInt(encoded.width);
          size = index === 0 ? encoded.value : sizes[index - 1]! + encoded.value - ((1n << BigInt(encoded.width * 7 - 1)) - 1n);
        }
        if (size < 0n) throw metadataError("invalid_element", "Negative laced frame size");
        sizes.push(size);
      }
    }
    const dataBytes = element.end - offset;
    if (sizes.reduce((sum, size) => sum + size, 0n) > dataBytes || (lacing === "fixed" && dataBytes % BigInt(frameCount) !== 0n)) throw metadataError("invalid_element", "Laced frame sizes exceed the actual codec payload");
    const blockOrdinal = this.blocksRead; this.blocksRead += 1;
    return { blockOrdinal, kind, elementOffset: element.offset.toString(), dataOffset: offset.toString(), dataBytes: dataBytes.toString(),
      trackNumber: track.value.toString(), relativeTimestampTicks: String(view.getInt16(0)), invisible: (flags & 8) !== 0,
      lacing, frameCount, blockDurationTicks: duration, discardPaddingNs: padding };
  }

  /** Read a BlockGroup's unique Block and independent duration/padding fields.
   * @throws {Error} When its children or required block are malformed.
   */
  private async group(element: MetadataElement): Promise<UnboundBlock> {
    const fields = await this.children(element);
    const duration = this.unique(fields, "9b");
    const padding = this.unique(fields, "75a2");
    return this.block(this.unique(fields, "a1", true)!, "group", duration === undefined ? null : (await this.integer(duration)).toString(), padding === undefined ? null : (await this.integer(padding, true)).toString());
  }

  /** Finish a complete cluster, returning an already-read sibling header at unknown-size boundaries.
   * @throws {Error} When timing, hierarchy, headers or resource ceilings fail.
   */
  private async cluster(element: MetadataElement): Promise<ClusterResult> {
    let offset = element.start;
    let timestamp: bigint | undefined;
    let next: MetadataElement | undefined;
    const blocks: UnboundBlock[] = [];
    while (offset < element.end) {
      const child = await this.element(offset, element.end);
      if (element.unknown && (LEVEL_ONE.has(child.id) || child.id === "1a45dfa3" || child.id === "18538067")) { next = child; break; }
      if (LEVEL_ONE.has(child.id)) throw metadataError("invalid_element", "Segment-level element occurs inside a known-size cluster");
      if (child.unknown) throw metadataError("unsupported_structure", "Unknown-size cluster child has no supported hierarchy");
      if (child.id === "e7") {
        if (timestamp !== undefined) throw metadataError("duplicate_metadata", "Duplicate cluster timestamp");
        timestamp = await this.integer(child);
      } else if (child.id === "a3") blocks.push(await this.block(child, "simple", null, null));
      else if (child.id === "a0") blocks.push(await this.group(child));
      offset = child.end;
    }
    if (timestamp === undefined) throw metadataError("missing_metadata", "Missing cluster timestamp");
    return { ...(next === undefined ? {} : { next }), end: next?.offset ?? element.end, blocks: blocks.map((block) => ({ ...block, clusterTimestampTicks: timestamp.toString() })) };
  }

  /** Traverse one whole Segment, permitting Info and Tracks after an unknown-size cluster.
   * @throws {Error} When required metadata, supported hierarchy or a full-source bound fails.
   */
  private async segment(element: MetadataElement): Promise<MatroskaMetadata> {
    let offset = element.start;
    let next: MetadataElement | undefined;
    let timestampScaleNs: string | undefined;
    let tracks: MatroskaTrackMetadata[] | undefined;
    const blocks: MatroskaBlockMetadata[] = [];
    while (offset < element.end) {
      const child = next ?? await this.element(offset, element.end); next = undefined;
      if (child.id === "1a45dfa3" || child.id === "18538067") throw metadataError("unsupported_structure", "Multiple documents or Segments need explicit selection");
      if (child.id === "1f43b675") {
        const cluster = await this.cluster(child); blocks.push(...cluster.blocks); offset = cluster.end; next = cluster.next; continue;
      }
      if (child.unknown) throw metadataError("unsupported_structure", "Unknown-size Segment child has no supported hierarchy");
      if (child.id === "1549a966") {
        if (timestampScaleNs !== undefined) throw metadataError("unsupported_structure", "Repeated Info requires a recurring-metadata contract");
        const clock = this.unique(await this.children(child), "2ad7b1");
        const scale = clock === undefined ? 1000000n : await this.integer(clock, false, 1000000n);
        if (scale <= 0n) throw metadataError("invalid_element", "Timestamp scale must be positive");
        timestampScaleNs = scale.toString();
      } else if (child.id === "1654ae6b") {
        if (tracks !== undefined) throw metadataError("unsupported_structure", "Repeated Tracks require a recurring-metadata contract");
        tracks = [];
        for (const entry of await this.children(child)) if (entry.id === "ae") tracks.push(await this.track(entry));
      }
      offset = child.end;
    }
    if (timestampScaleNs === undefined || tracks === undefined || tracks.length === 0) throw metadataError("missing_metadata", "Missing required Segment timing or tracks");
    return { timestampScaleNs, tracks, blocks };
  }

  /** Read a complete EBML document without treating a completed prefix as the complete source.
   * @throws {Error} When metadata, source IO or cumulative ceilings fail.
   */
  async inspect(): Promise<MatroskaMetadata> {
    let offset = 0n;
    let result: MatroskaMetadata | undefined;
    let headerRead = false;
    while (offset < this.source.size) {
      const element = await this.element(offset, this.source.size);
      if (element.id === "1a45dfa3") {
        if (headerRead || result !== undefined) throw metadataError("unsupported_structure", "Multiple EBML documents need an explicit selection contract");
        await this.children(element); headerRead = true;
      } else if (element.id === "18538067") {
        if (!headerRead) throw metadataError("missing_metadata", "Missing EBML header");
        if (result !== undefined) throw metadataError("unsupported_structure", "Multiple Segments need an explicit selection contract");
        result = await this.segment(element);
      } else if (element.unknown) throw metadataError("unsupported_structure", "Unknown-size root element has no supported hierarchy");
      offset = element.end;
    }
    if (result === undefined) throw metadataError("missing_metadata", "Missing Matroska Segment");
    return result;
  }
}
