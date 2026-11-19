// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { MatroskaByteSource } from "@ingest/container/matroska-metadata.js";

export interface MetadataReadRequest { offset: bigint; length: number }

/** Encode the format's unsigned VINT data; all-one size values remain reserved.
 * @throws {RangeError} When the value does not fit the requested VINT width.
 */
export function vint(value: bigint, width?: number): Buffer {
  let length = width ?? 1;
  while (width === undefined && value >= (1n << BigInt(length * 7)) - 1n && length < 8) length += 1;
  if (value < 0n || length < 1 || length > 8 || value >= (1n << BigInt(length * 7)) - 1n) throw new RangeError("Invalid fixture VINT");
  let encoded = value | (1n << BigInt(length * 7));
  const bytes = Buffer.alloc(length);
  for (let index = length - 1; index >= 0; index -= 1) { bytes[index] = Number(encoded & 255n); encoded >>= 8n; }
  return bytes;
}

/** Wrap literal EBML IDs and bytes without calling the reader under test.
 * @throws {RangeError} When the body cannot be represented by a legal size VINT.
 */
export function element(id: string, body: Uint8Array, unknown = false): Buffer {
  return Buffer.concat([Buffer.from(id, "hex"), unknown ? Buffer.from("01ffffffffffffff", "hex") : vint(BigInt(body.length)), body]);
}

/** Encode an exact unsigned integer in its stated big-endian width.
 * @throws {RangeError} When the integer is outside the requested wire domain.
 */
export function uint(value: bigint, width = 8): Buffer {
  if (value < 0n || value >= 1n << BigInt(width * 8)) throw new RangeError("Invalid fixture unsigned integer");
  const bytes = Buffer.alloc(width);
  let remaining = value;
  for (let index = width - 1; index >= 0; index -= 1) { bytes[index] = Number(remaining & 255n); remaining >>= 8n; }
  return bytes;
}

/** Encode a signed two's-complement integer, without applying a clock transform.
 * @throws {RangeError} When the integer is outside the requested signed width.
 */
export function sint(value: bigint, width = 8): Buffer {
  const sign = 1n << BigInt(width * 8 - 1);
  if (value < -sign || value >= sign) throw new RangeError("Invalid fixture signed integer");
  return uint(value < 0n ? (1n << BigInt(width * 8)) + value : value, width);
}

/** Assemble one explicitly identified track and any original optional fields.
 * @throws {RangeError} When an integer cannot be encoded.
 */
export function trackEntry(number = 3n, uid = 4n, extra: Buffer[] = [], type = 1n, codec = "V_VP9"): Buffer {
  return element("ae", Buffer.concat([
    element("d7", uint(number)), element("73c5", uint(uid)), element("83", uint(type, 1)), element("86", Buffer.from(codec, "ascii")), ...extra,
  ]));
}

/** Build Info with required writer names and the supplied original clock elements.
 * @throws {RangeError} When a body exceeds the EBML size domain.
 */
export function info(extra: Buffer[] = [element("2ad7b1", uint(1000000n))]): Buffer {
  return element("1549a966", Buffer.concat([element("4d80", Buffer.from("fixture")), element("5741", Buffer.from("fixture")), ...extra]));
}

/** Preserve the exact block header and codec bytes specified by each independent case.
 * @throws {RangeError} When a timestamp or track VINT is unrepresentable.
 */
export function block(relative: number, options: { track?: bigint; flags?: number; lace?: number[]; payload?: Buffer; group?: boolean; duration?: bigint; padding?: bigint; groupPrefix?: Buffer[] } = {}): Buffer {
  const header = Buffer.alloc(3); header.writeInt16BE(relative, 0); header[2] = options.flags ?? 0;
  const body = Buffer.concat([vint(options.track ?? 3n), header, Buffer.from(options.lace ?? []), options.payload ?? Buffer.from("112233", "hex")]);
  const encoded = element(options.group ? "a1" : "a3", body);
  if (!options.group) return encoded;
  return element("a0", Buffer.concat([
    ...(options.groupPrefix ?? []), encoded,
    ...(options.duration === undefined ? [] : [element("9b", uint(options.duration))]),
    ...(options.padding === undefined ? [] : [element("75a2", sint(options.padding))]),
  ]));
}

/** Assemble a cluster at its explicit segment timestamp, preserving all physical blocks.
 * @throws {RangeError} When a timestamp or body cannot be represented.
 */
export function cluster(timestamp: bigint, children: Buffer[], unknown = false): Buffer {
  return element("1f43b675", Buffer.concat([element("e7", uint(timestamp)), ...children]), unknown);
}

/** Build a real EBML header and single Segment; the codec payload need not decode.
 * @throws {RangeError} When a body cannot be represented.
 */
export function document(children: Buffer[], unknown = false, version = 4): Buffer {
  const header = element("1a45dfa3", Buffer.concat([
    element("4286", uint(1n, 1)), element("42f7", uint(1n, 1)), element("42f2", uint(4n, 1)), element("42f3", uint(8n, 1)),
    element("4282", Buffer.from("matroska")), element("4287", uint(BigInt(version), 1)), element("4285", uint(2n, 1)),
  ]));
  return Buffer.concat([header, element("18538067", Buffer.concat(children), unknown)]);
}

/** Expose original fixture bytes and record every actual reader request.
 * @throws {never} Never.
 */
export function byteSource(bytes: Uint8Array, reads: MetadataReadRequest[] = []): MatroskaByteSource {
  return { size: BigInt(bytes.length), read: async (offset, length) => {
    reads.push({ offset, length });
    return bytes.subarray(Number(offset), Number(offset) + length);
  } };
}

/** Locate an unambiguous literal byte sequence to express independently encoded offsets.
 * @throws {Error} When the fixture is ambiguous or does not contain the sequence.
 */
export function uniqueOffset(bytes: Buffer, needle: Buffer): number {
  const offset = bytes.indexOf(needle);
  if (offset < 0 || bytes.indexOf(needle, offset + 1) !== -1) throw new Error("Fixture offset is not unique");
  return offset;
}
