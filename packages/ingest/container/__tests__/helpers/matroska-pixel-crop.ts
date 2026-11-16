// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * A Matroska file with PixelCrop elements written into its first track's Video element (EBML ids 0x54AA bottom, 0x54BB top,
 * 0x54CC left, 0x54DD right), every enclosing element's size grown to match.
 * @param bytes - The file.
 * @param crop - The pixels cropped at each edge.
 * @returns The new file.
 */
export function pixelCropped(bytes: Buffer, crop: { top?: number; bottom?: number; left?: number; right?: number }): Buffer {
  const id = (at: number): [number, number] => { let length = 1; while (!(bytes[at]! & (0x80 >> (length - 1)))) length += 1; return [bytes.readUIntBE(at, length), length]; };
  const size = (at: number): [number, number] => {
    let length = 1; while (!(bytes[at]! & (0x80 >> (length - 1)))) length += 1;
    let value = bytes[at]! & ((0x80 >> (length - 1)) - 1);
    for (let i = 1; i < length; i += 1) value = value * 256 + bytes[at + i]!;
    return [value, length];
  };
  const find = (start: number, end: number, target: number): [number, number, number, number] => {
    for (let at = start; at < end;) {
      const [found, idLength] = id(at); const [length, sizeLength] = size(at + idLength);
      if (found === target) return [at, idLength, sizeLength, length];
      at += idLength + sizeLength + length;
    }
    throw new Error(`No element ${target.toString(16)}`);
  };
  const [, headerId, headerSize, headerLength] = find(0, bytes.length, 0x1a45dfa3);
  const chain = [find(headerId + headerSize + headerLength, bytes.length, 0x18538067)];
  for (const target of [0x1654ae6b, 0xae, 0xe0]) { const [at, idLength, sizeLength, length] = chain.at(-1)!; chain.push(find(at + idLength + sizeLength, at + idLength + sizeLength + length, target)); }
  const elements = Buffer.from([[0x54, 0xaa, crop.bottom], [0x54, 0xbb, crop.top], [0x54, 0xcc, crop.left], [0x54, 0xdd, crop.right]]
    .filter(([, , value]) => value !== undefined).flatMap(([a, b, value]) => [a!, b!, 0x81, value!]));
  const [videoAt, videoId, videoSize, videoLength] = chain.at(-1)!;
  const end = videoAt + videoId + videoSize + videoLength;
  const out = Buffer.concat([bytes.subarray(0, end), elements, bytes.subarray(end)]);
  for (const [at, idLength, sizeLength, length] of chain) {
    let value = length + elements.length;
    for (let i = sizeLength - 1; i >= 0; i -= 1) { out[at + idLength + i] = value & 0xff; value = Math.floor(value / 256); }
    out[at + idLength] = out[at + idLength]! | (0x80 >> (sizeLength - 1));
  }
  return out;
}
