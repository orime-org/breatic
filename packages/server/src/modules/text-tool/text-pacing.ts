// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * How a text tool's answer is paced out to the reader (inner#1860).
 *
 * The model sends its text in bursts: the whole answer often lands within
 * half a second of the first word. The reader should see it being written,
 * so each burst goes out a word at a time, `delayMs` apart — but never for
 * longer than `burstMaxMs` per burst: a long burst goes out several words at a
 * time, so a long translation is not held back minutes after the model has
 * finished. Words are found with `Intl.Segmenter`, which splits CJK text as
 * well (the AI SDK's own advice for CJK).
 *
 * The model's hidden reasoning is dropped first: the text tools never use it,
 * and pacing it would hold the first word of the answer back.
 */

import { smoothStream, type StreamTextTransform, type ToolSet } from "ai";

/**
 * A chunker for `smoothStream`: the next piece of the buffer to send.
 *
 * It sees the buffer before every tick. When the buffer has grown since the
 * last tick a new burst has arrived, and the number of words per tick is set
 * again so that what is now waiting goes out within `burstMaxMs`.
 * @param delayMs - The pause between ticks.
 * @param burstMaxMs - The longest one burst may take to go out.
 * @returns The chunker; one per stream, since it remembers the burst it is in.
 */
export function burstChunker(delayMs: number, burstMaxMs: number): (buffer: string) => string | null {
  const segmenter = new Intl.Segmenter(undefined, { granularity: "word" });
  const ticks = delayMs > 0 ? Math.max(1, Math.floor(burstMaxMs / delayMs)) : Number.POSITIVE_INFINITY;
  let left = 0;
  let perTick = 1;
  return (buffer) => {
    if (buffer.length === 0) return null;
    const words = [...segmenter.segment(buffer)].map((part) => part.segment);
    if (buffer.length > left) perTick = Math.max(1, Math.ceil(words.length / ticks));
    const piece = words.slice(0, perTick).join("");
    left = buffer.length - piece.length;
    return piece;
  };
}

/**
 * The transforms a text tool's model stream goes through, in order.
 * @param pace - The pause between ticks and the budget of one burst.
 * @param pace.delayMs - The pause between ticks.
 * @param pace.burstMaxMs - The longest one burst may take to go out.
 * @returns Drop the reasoning, then pace the answer.
 */
export function textPacing<TOOLS extends ToolSet>(pace: { delayMs: number; burstMaxMs: number }): StreamTextTransform<TOOLS>[] {
  /**
   * Drops the model's reasoning from its stream.
   * @returns The transform stream.
   */
  const dropReasoning: StreamTextTransform<TOOLS> = () => new TransformStream({
    /**
     * Passes every part but the reasoning text.
     * @param part - A part of the model stream.
     * @param controller - Where parts go on.
     */
    transform(part, controller): void {
      if (part.type !== "reasoning-delta") controller.enqueue(part);
    },
  });
  return [dropReasoning, smoothStream<TOOLS>({ delayInMs: pace.delayMs, chunking: burstChunker(pace.delayMs, pace.burstMaxMs) })];
}
