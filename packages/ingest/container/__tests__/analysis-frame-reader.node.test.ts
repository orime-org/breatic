// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { Readable } from "node:stream";
import { getEventListeners } from "node:events";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { readAnalysisFrames, type AnalysisRawFrame } from "../analysis-frame-reader.js";

const SOURCE = Buffer.from(Array.from({ length: 24 }, (_, index) => index));

/**
 * Collect owned raw frames without deriving expected bytes from the reader.
 * @param source - A binary output pipe owned by this read.
 * @param signal - This read's cancellation lifetime.
 * @param expectedFrameCount - The exact selected source ledger length.
 * @returns The fully read frames, only after normal exhaustion.
 * @throws {Error} When reading or the selected frame count fails.
 */
async function collect(source: Readable, signal = new AbortController().signal, expectedFrameCount = 2): Promise<AnalysisRawFrame[]> {
  const frames: AnalysisRawFrame[] = [];
  for await (const frame of readAnalysisFrames({ source, width: 2, height: 2, expectedFrameCount, signal })) frames.push(frame);
  return frames;
}

/**
 * Form legal binary transport chunks, preserving every byte in order.
 * @param sizes - Positive requested boundaries independent of frame size.
 * @returns A finite binary stream containing exactly A then B.
 * @throws {never} Never.
 */
function chunked(sizes: readonly number[]): Readable {
  const chunks: Buffer[] = []; let offset = 0;
  for (const size of sizes) {
    if (offset >= SOURCE.length) break;
    chunks.push(SOURCE.subarray(offset, offset + size)); offset += size;
  }
  if (offset < SOURCE.length) chunks.push(SOURCE.subarray(offset));
  return Readable.from(chunks);
}

describe("analysis raw BGR frame stream", () => {
  it.each([[24], [12, 12], [1, 2, 4, 3, 2, 4, 8]])("reassembles A and B from chunks %j", async (...sizes) => {
    const frames = await collect(chunked(sizes));
    expect(frames.map((frame) => ({ frameIndex: frame.frameIndex, bytes: [...frame.bytes] }))).toEqual([
      { frameIndex: 0, bytes: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
      { frameIndex: 1, bytes: [12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23] },
    ]);
    expect(frames[0]!.bytes.buffer === frames[1]!.bytes.buffer && frames[0]!.bytes.byteOffset === frames[1]!.bytes.byteOffset).toBe(false);
  });

  it("preserves any legal byte partition", async () => {
    await fc.assert(fc.asyncProperty(fc.array(fc.integer({ min: 1, max: 24 }), { maxLength: 30 }), async (sizes) => {
      const frames = await collect(chunked(sizes));
      expect(frames.map((frame) => [...frame.bytes])).toEqual([[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], [12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23]]);
    }), { numRuns: 60 });
  });

  it("keeps a BGR blue pixel in its original channels", async () => {
    const source = Readable.from([Buffer.from([255, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9])]);
    const [frame] = await collect(source, undefined, 1);
    expect([...frame!.bytes.subarray(0, 3)]).toEqual([255, 0, 0]);
  });

  it.each(Array.from({ length: 24 }, (_, index) => index))("refuses incomplete source byte length %s", async (length) => {
    const source = Readable.from([SOURCE.subarray(0, length)]);
    await expect(collect(source)).rejects.toThrow(); expect(source.destroyed).toBe(true);
  });

  it("refuses an extra complete frame", async () => {
    const source = Readable.from([Buffer.concat([SOURCE, Buffer.alloc(12)])]);
    await expect(collect(source)).rejects.toThrow(); expect(source.destroyed).toBe(true);
  });

  it("retains the exact frame count when the transport writes an extra partial frame", async () => {
    const source = Readable.from([Buffer.concat([SOURCE, Buffer.from([99])])]);
    await expect(collect(source)).rejects.toThrow(); expect(source.destroyed).toBe(true);
  });

  it("does not pull bytes after an early cancellation", async () => {
    let reads = 0; const source = new Readable({ read() { reads += 1; } });
    const controller = new AbortController(); controller.abort();
    await expect(collect(source, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(reads).toBe(0); expect(source.destroyed).toBe(true);
  });

  it.each([0, 7, 12])("cancels a pending pipe after %s bytes and discards a late chunk", async (received) => {
    let opened!: () => void; const active = new Promise<void>((resolve) => { opened = resolve; });
    const source = new Readable({ read() { opened(); } });
    const controller = new AbortController(); const pending = collect(source, controller.signal);
    await Promise.race([active, pending]);
    if (received > 0) source.push(SOURCE.subarray(0, received));
    controller.abort(); source.push(SOURCE);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(source.destroyed).toBe(true); expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it("releases the pipe when the consumer fails after its first complete frame", async () => {
    const source = new Readable({ read() { this.push(SOURCE.subarray(0, 12)); } });
    const consume = async (): Promise<void> => {
      for await (const frame of readAnalysisFrames({ source, width: 2, height: 2, expectedFrameCount: 2, signal: new AbortController().signal })) {
        expect([...frame.bytes]).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
        throw new Error("detector-failed");
      }
    };
    await expect(consume()).rejects.toThrow("detector-failed"); expect(source.destroyed).toBe(true);
  });

  it("keeps another source alive when A is cancelled", async () => {
    let opened!: () => void; const active = new Promise<void>((resolve) => { opened = resolve; });
    const a = new Readable({ read() { opened(); } });
    const b = chunked([4, 8, 7, 5]); const controller = new AbortController();
    const first = collect(a, controller.signal); await Promise.race([active, first]); controller.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    expect((await collect(b)).map((frame) => [...frame.bytes])).toEqual([[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], [12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23]]);
  });

  it("cancels after A has actually been delivered without accepting a partial result", async () => {
    let sent = false;
    const source = new Readable({ read() { if (!sent) { sent = true; this.push(SOURCE.subarray(0, 12)); } } });
    const controller = new AbortController();
    const frames = readAnalysisFrames({ source, width: 2, height: 2, expectedFrameCount: 2, signal: controller.signal });
    const first = await frames.next();
    expect(first.done).toBe(false); expect([...first.value!.bytes]).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    const pending = frames.next(); controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(source.destroyed).toBe(true); expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it("closes its pipe and listener when the consumer ends the iterator", async () => {
    const source = chunked([12, 12]); const controller = new AbortController();
    const frames = readAnalysisFrames({ source, width: 2, height: 2, expectedFrameCount: 2, signal: controller.signal });
    expect((await frames.next()).done).toBe(false);
    await frames.return(); expect(source.destroyed).toBe(true);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it("preserves a source failure while closing its read", async () => {
    const error = new Error("source-pipe-failed");
    const source = new Readable({ read() { this.destroy(error); } });
    await expect(collect(source)).rejects.toBe(error); expect(source.destroyed).toBe(true);
  });

  it("refuses nonbinary output instead of interpreting text as raw pixels", async () => {
    const source = Readable.from(["not-bgr"]);
    await expect(collect(source)).rejects.toBeInstanceOf(TypeError); expect(source.destroyed).toBe(true);
  });

  it.each([[0, 2, 2], [2, 0, 2], [2, 2, 0], [1.5, 2, 2], [2, 2, 1.5], [Infinity, 2, 2], [Number.MAX_SAFE_INTEGER, 2, 2]])("rejects impossible frame geometry %j", async (width, height, expectedFrameCount) => {
    const source = Readable.from([SOURCE]);
    const consume = async (): Promise<void> => {
      for await (const frame of readAnalysisFrames({ source, width, height, expectedFrameCount, signal: new AbortController().signal })) void frame;
    };
    await expect(consume()).rejects.toBeInstanceOf(RangeError); expect(source.destroyed).toBe(true);
  });
});
