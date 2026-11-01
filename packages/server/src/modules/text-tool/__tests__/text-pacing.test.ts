// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * How a text tool's answer is paced out (inner#1860, implementation review
 * round 1): words go out one or a few at a time, every burst the model sends
 * is out within its time budget however long it is, and the model's hidden
 * reasoning is dropped before any of it is paced.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { burstChunker, textPacing } from "@server/modules/text-tool/text-pacing.js";

/**
 * Runs one burst through a chunker the way the smoother does: ask for the
 * next piece until it has none.
 * @param next - The chunker.
 * @param burst - The text that arrived.
 * @returns The pieces, in order.
 */
function drain(next: (buffer: string) => string | null, burst: string): string[] {
  const pieces: string[] = [];
  let buffer = burst;
  for (let piece = next(buffer); piece !== null; piece = next(buffer)) {
    pieces.push(piece);
    buffer = buffer.slice(piece.length);
  }
  return pieces;
}

describe("burstChunker", () => {
  it("sends a short burst word by word", () => {
    const pieces = drain(burstChunker(20, 1500), "One two three.");

    expect(pieces.join("")).toBe("One two three.");
    expect(pieces).toEqual(["One", " ", "two", " ", "three", "."]);
  });

  it("sends any burst within its budget, as whole prefixes, losing nothing", () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom("雨", "猫", "the ", "cat ", "。", "\n", "カメラ", "달린다 "), { maxLength: 4000, size: 'max' }), (parts) => {
        const burst = parts.join("");
        const pieces = drain(burstChunker(20, 1500), burst);
        expect(pieces.join("")).toBe(burst);
        expect(pieces.length).toBeLessThanOrEqual(Math.ceil(1500 / 20));
      }),
      { numRuns: 60 },
    );
  });

  it("measures a new burst afresh when it arrives before the last one is out", () => {
    const next = burstChunker(20, 100);
    const first = "a ".repeat(50);
    let buffer = first;
    const piece = next(buffer)!;
    buffer = buffer.slice(piece.length) + "b ".repeat(200);

    const rest = drain(next, buffer);

    expect(rest.join("")).toBe(buffer);
    expect(rest.length).toBeLessThanOrEqual(Math.ceil(100 / 20));
  });
});

describe("textPacing", () => {
  it("passes the answer through whole and drops the reasoning before pacing", async () => {
    const parts = [
      { type: "reasoning-delta", id: "r", text: "thinking about it" },
      { type: "text-delta", id: "t", text: "Hello there, " },
      { type: "reasoning-delta", id: "r", text: "more thought" },
      { type: "text-delta", id: "t", text: "reader." },
      { type: "finish-step" },
    ];
    let stream = new ReadableStream<Record<string, unknown>>({
      start(controller) {
        for (const part of parts) controller.enqueue(part);
        controller.close();
      },
    });
    for (const transform of textPacing({ delayMs: 0, burstMaxMs: 0 })) {
      stream = stream.pipeThrough((transform as unknown as (o: object) => TransformStream)({ tools: {}, stopStream: () => undefined }));
    }

    const out: Record<string, unknown>[] = [];
    for await (const part of stream as unknown as AsyncIterable<Record<string, unknown>>) out.push(part);

    expect(out.some((part) => part.type === "reasoning-delta")).toBe(false);
    expect(out.filter((part) => part.type === "text-delta").map((part) => part.text).join("")).toBe("Hello there, reader.");
    expect(out.at(-1)?.type).toBe("finish-step");
  });
});
