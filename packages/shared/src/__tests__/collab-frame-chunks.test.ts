// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The collab chunking contract shared by web and collab (inner#1585): the
 * single-frame cap, the declaration frame and the sender that splits a large
 * binary message into a declaration plus chunks on the same socket.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  COLLAB_FRAME_MAX_BYTES,
  collabChunkHeaderSchema,
  sendInChunks,
} from "@shared/index.js";

const F = 131_072;

/**
 * Deterministic pseudo-random bytes, so misplaced, repeated or truncated
 * chunks show up in a byte comparison.
 * @param n - Length.
 * @param seed - Seed.
 * @returns The bytes.
 */
function msg(n: number, seed = 1): Uint8Array {
  const out = new Uint8Array(n);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < n; i++) {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    out[i] = x & 0xff;
  }
  return out;
}

/**
 * Run the sender and collect what it hands to the socket.
 * @param bytes - The message.
 * @returns Every frame in order.
 */
function collect(bytes: Uint8Array): Array<string | Uint8Array> {
  const out: Array<string | Uint8Array> = [];
  sendInChunks(bytes, (frame) => out.push(frame));
  return out;
}

/**
 * Concatenate the binary frames after the declaration.
 * @param frames - Frames as sent.
 * @returns The joined bytes.
 */
function joined(frames: Array<string | Uint8Array>): Uint8Array {
  return Buffer.concat(frames.filter((f): f is Uint8Array => typeof f !== "string"));
}

/**
 * Compare bytes with a memcmp; deep equality on megabyte arrays takes seconds.
 * @param actual - Bytes produced.
 * @param expected - Bytes wanted.
 * @returns Whether they are identical.
 */
function same(actual: unknown, expected: Uint8Array): boolean {
  if (!(actual instanceof Uint8Array)) return false;
  return Buffer.compare(
    Buffer.from(actual.buffer, actual.byteOffset, actual.byteLength),
    Buffer.from(expected.buffer, expected.byteOffset, expected.byteLength),
  ) === 0;
}

describe("collab frame chunks", () => {
  it("S01 exports the cap, the header schema and the sender from the package entry", () => {
    expect(COLLAB_FRAME_MAX_BYTES).toBe(131072);
    expect(collabChunkHeaderSchema).toBeDefined();
    expect(sendInChunks).toBeTypeOf("function");
  });

  it.each([0, 1, 65_536, 131_071, 131_072])("S02 sends %i bytes as one unchanged binary frame", (n) => {
    const m = msg(n);
    const out = collect(m);
    expect(out).toHaveLength(1);
    expect(typeof out[0]).not.toBe("string");
    expect(same(out[0], m)).toBe(true);
  });

  it("S03 splits a message one byte over the cap into a declaration and two chunks", () => {
    const m = msg(131_073);
    const out = collect(m);
    expect(out).toHaveLength(3);
    expect(typeof out[0]).toBe("string");
    expect(JSON.parse(out[0] as string)).toEqual({ type: "chunked", bytes: 131073 });
    expect((out[1] as Uint8Array).byteLength).toBe(131_072);
    expect((out[2] as Uint8Array).byteLength).toBe(1);
    expect(same(joined(out), m)).toBe(true);
  });

  it.each([
    [262_144, [F, F]],
    [262_145, [F, F, 1]],
    [1_200_000, [...Array<number>(9).fill(F), 20_352]],
    [3_145_728, Array<number>(24).fill(F)],
    [10_551_296, [...Array<number>(80).fill(F), 65_536]],
  ])("S04 cuts %i bytes into the expected chunks", (n, sizes) => {
    const m = msg(n);
    const out = collect(m);
    expect(JSON.parse(out[0] as string)).toEqual({ type: "chunked", bytes: n });
    const chunks = out.slice(1) as Uint8Array[];
    expect(chunks.map((c) => c.byteLength)).toEqual(sizes);
    expect(chunks).toHaveLength(Math.ceil(n / F));
    expect(same(joined(out), m)).toBe(true);
  });

  it("S05 chunks the viewed bytes of an offset view", () => {
    const buf = msg(131_073 + 14);
    const view = new Uint8Array(buf.buffer, 7, 131_073);
    const out = collect(view);
    expect(same(joined(out), view)).toBe(true);
    expect(same(joined(out), buf.subarray(0, 131_073))).toBe(false);
  });

  it("S06 sends the declaration first and every chunk before returning", () => {
    const calls: Array<string | number> = [];
    sendInChunks(msg(300_000), (frame) => calls.push(typeof frame === "string" ? "text" : frame.byteLength));
    expect(calls).toEqual(["text", 131_072, 131_072, 37_856]);
  });

  it.each([
    [{ type: "chunked", bytes: 131073 }, true],
    [{ type: "chunked", bytes: 10551296 }, true],
    [{ type: "chunked", bytes: 1e15 }, true],
    [{ type: "chunked", bytes: 131072 }, false],
    [{ type: "chunked", bytes: 131071 }, false],
    [{ type: "chunked", bytes: 0 }, false],
    [{ type: "chunked", bytes: -1 }, false],
    [{ type: "chunked", bytes: 131073.5 }, false],
    [{ type: "chunked", bytes: "131073" }, false],
    [{ type: "chunked", bytes: null }, false],
    [{ type: "chunked" }, false],
    [{ bytes: 131073 }, false],
    [{ type: "Chunked", bytes: 131073 }, false],
    [{ type: "chunk", bytes: 131073 }, false],
    [[], false],
    ["chunked", false],
    [null, false],
  ])("S07 header schema on %j accepts: %s", (input, ok) => {
    expect(collabChunkHeaderSchema.safeParse(input).success).toBe(ok);
  });

  it("S07 accepts a header with an extra key and keeps only type and bytes", () => {
    const parsed = collabChunkHeaderSchema.safeParse({ type: "chunked", bytes: 131073, extra: 1 });
    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual({ type: "chunked", bytes: 131073 });
  });

  it.each([262_144, 262_145, 1_200_000, 3_145_728, 10_551_296])(
    "S08 the declaration the sender writes for %i bytes passes the receiver's schema",
    (n) => {
      const out = collect(msg(n));
      const parsed = collabChunkHeaderSchema.safeParse(JSON.parse(out[0] as string));
      expect(parsed.success).toBe(true);
      expect(parsed.data?.bytes).toBe(n);
    },
  );

  it("SP01 any bytes split and joined again equal the input, every frame within the cap", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constantFrom(0, 1, F - 1, F, F + 1, 2 * F - 1, 2 * F, 2 * F + 1, 3 * F),
          fc.integer({ min: 0, max: 4 * F }),
        ),
        fc.integer(),
        (n, seed) => {
          const m = msg(n, seed);
          const out = collect(m);
          if (n <= F) {
            expect(out).toHaveLength(1);
            expect(typeof out[0]).not.toBe("string");
            expect(same(out[0], m)).toBe(true);
            return;
          }
          expect(typeof out[0]).toBe("string");
          expect(collabChunkHeaderSchema.parse(JSON.parse(out[0] as string)).bytes).toBe(n);
          const chunks = out.slice(1);
          expect(chunks).toHaveLength(Math.ceil(n / F));
          chunks.forEach((c, i) => {
            expect(typeof c).not.toBe("string");
            const len = (c as Uint8Array).byteLength;
            expect(len).toBeGreaterThanOrEqual(1);
            expect(len).toBeLessThanOrEqual(F);
            if (i < chunks.length - 1) expect(len).toBe(F);
          });
          expect(same(joined(out), m)).toBe(true);
        },
      ),
      { numRuns: 200 },
    );
  });
});
