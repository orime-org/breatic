// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The one AAC encode estimate (inner#1306 test plan §97 D24-3, D7-1; frames-split §5.4 估算 and 待实测 rows).
 *
 * A job whose only encoding is one AAC track costs its start plus the audio seconds over the frozen AAC rate
 * (`encoding.encoder.aacEncodeSecondsPerSecond`): the dispatched copy's audio (D7-1), a lip-sync stem, and the lip-sync
 * stitch, which joins the video chunks by packet copy and encodes the one mixed track over `timeline.duration` (D24-3).
 * The shared function is named here, in the style of `estimateVideoJobSeconds`: `estimateAudioEncodeSeconds(audioSeconds,
 * { startSeconds, aacEncodeSecondsPerSecond })`; it is read by name so this file compiles before it exists.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import * as plan from "@shared/mini-tools/video-encode-plan.js";

type Estimate = (audioSeconds: number, rates: { startSeconds: number; aacEncodeSecondsPerSecond: number }) => number;

/**
 * The shared estimate, failing clearly while it does not exist.
 * @returns It.
 */
function estimate(): Estimate {
  const found = (plan as unknown as { estimateAudioEncodeSeconds?: Estimate }).estimateAudioEncodeSeconds;
  expect(found, "estimateAudioEncodeSeconds is exported from video-encode-plan").toBeTypeOf("function");
  return found!;
}

describe("the AAC encode estimate of a stitch, a stem and a dispatched copy (§97 D24-3, D7-1)", () => {
  it("AE01 the lip-sync stitch over an 11 s timeline at 100 audio seconds per second, start 3 s, is 3.11 s", () => {
    expect(estimate()(11, { startSeconds: 3, aacEncodeSecondsPerSecond: 100 })).toBeCloseTo(3.11, 12);
  });

  it("AE02 no audio costs the start alone", () => {
    expect(estimate()(0, { startSeconds: 3, aacEncodeSecondsPerSecond: 100 })).toBe(3);
  });

  it("AE03 is start + audio seconds ÷ rate for any finite inputs (no video work: chunks are joined by packet copy)", () => {
    fc.assert(fc.property(
      fc.double({ min: 0, max: 7200, noNaN: true }), fc.double({ min: 0, max: 10, noNaN: true }), fc.double({ min: 0.5, max: 1000, noNaN: true }),
      (audio, start, rate) => {
        expect(estimate()(audio, { startSeconds: start, aacEncodeSecondsPerSecond: rate })).toBeCloseTo(start + audio / rate, 9);
      }));
  });
});
