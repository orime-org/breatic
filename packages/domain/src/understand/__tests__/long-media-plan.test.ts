// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { planLongMediaSegments } from "@breatic/shared";

const limits = {
  audioCoreSeconds: 300,
  videoCoreSeconds: 60,
  overlapSeconds: 2,
  maxActiveLeaves: 512,
};

describe("planLongMediaSegments", () => {
  it("plans source-time audio cores with clamped decode overlap", () => {
    const plan = planLongMediaSegments([{
      mediaInputId: "audio-input-0",
      descriptor: { inputKind: "audio_channel", audioStreamIndex: 1, audioChannelIndex: 0 },
      sourceRange: { startUs: "5000000", endUs: "610000000" },
    }], limits);

    expect(plan).toEqual([
      {
        id: "audio-input-0:5000000:305000000",
        mediaInputId: "audio-input-0",
        descriptor: { inputKind: "audio_channel", audioStreamIndex: 1, audioChannelIndex: 0 },
        core: { startUs: "5000000", endUs: "305000000" },
        decode: { startUs: "5000000", endUs: "307000000" },
      },
      {
        id: "audio-input-0:305000000:605000000",
        mediaInputId: "audio-input-0",
        descriptor: { inputKind: "audio_channel", audioStreamIndex: 1, audioChannelIndex: 0 },
        core: { startUs: "305000000", endUs: "605000000" },
        decode: { startUs: "303000000", endUs: "607000000" },
      },
      {
        id: "audio-input-0:605000000:610000000",
        mediaInputId: "audio-input-0",
        descriptor: { inputKind: "audio_channel", audioStreamIndex: 1, audioChannelIndex: 0 },
        core: { startUs: "605000000", endUs: "610000000" },
        decode: { startUs: "603000000", endUs: "610000000" },
      },
    ]);
  });

  it("uses video core duration for each audio-backed video view", () => {
    const plan = planLongMediaSegments([{
      mediaInputId: "view-0",
      descriptor: { inputKind: "video_channel", videoStreamIndex: 0, audioStreamIndex: 2, audioChannelIndex: 1 },
      sourceRange: { startUs: "10000000", endUs: "130000000" },
    }], limits);

    expect(plan.map(({ core, decode }) => ({ core, decode }))).toEqual([
      {
        core: { startUs: "10000000", endUs: "70000000" },
        decode: { startUs: "10000000", endUs: "72000000" },
      },
      {
        core: { startUs: "70000000", endUs: "130000000" },
        decode: { startUs: "68000000", endUs: "130000000" },
      },
    ]);
  });

  it("counts active leaves across all media inputs", () => {
    const inputs = [
      {
        mediaInputId: "audio-0",
        descriptor: { inputKind: "audio_channel" as const, audioStreamIndex: 0, audioChannelIndex: 0 },
        sourceRange: { startUs: "0", endUs: "305000000" },
      },
      {
        mediaInputId: "video-0",
        descriptor: { inputKind: "video_silent" as const, videoStreamIndex: 0 },
        sourceRange: { startUs: "0", endUs: "61000000" },
      },
    ];

    expect(planLongMediaSegments(inputs, { ...limits, maxActiveLeaves: 4 })).toHaveLength(4);
    expect(() => planLongMediaSegments(inputs, { ...limits, maxActiveLeaves: 3 })).toThrow(RangeError);
  });

  it("preserves contiguous coverage and decode bounds for arbitrary valid source times", () => {
    fc.assert(fc.property(
      fc.bigInt({ min: -(10n ** 15n), max: 10n ** 15n }),
      fc.integer({ min: 1, max: 20_000_000 }),
      fc.integer({ min: 1, max: 600 }),
      fc.integer({ min: 0, max: 20 }),
      (startUs, durationUs, coreSeconds, overlapSeconds) => {
        const endUs = startUs + BigInt(durationUs);
        const plan = planLongMediaSegments([{
          mediaInputId: "audio-0",
          descriptor: { inputKind: "audio_channel", audioStreamIndex: 0, audioChannelIndex: 0 },
          sourceRange: { startUs: String(startUs), endUs: String(endUs) },
        }], {
          audioCoreSeconds: coreSeconds,
          videoCoreSeconds: coreSeconds,
          overlapSeconds,
          maxActiveLeaves: durationUs,
        });

        expect(plan[0]?.core.startUs).toBe(String(startUs));
        expect(plan.at(-1)?.core.endUs).toBe(String(endUs));
        for (const [index, segment] of plan.entries()) {
          expect(BigInt(segment.decode.startUs)).toBeLessThanOrEqual(BigInt(segment.core.startUs));
          expect(BigInt(segment.decode.endUs)).toBeGreaterThanOrEqual(BigInt(segment.core.endUs));
          expect(BigInt(segment.decode.startUs)).toBeGreaterThanOrEqual(startUs);
          expect(BigInt(segment.decode.endUs)).toBeLessThanOrEqual(endUs);
          if (index > 0) expect(plan[index - 1]?.core.endUs).toBe(segment.core.startUs);
        }
      },
    ), { numRuns: 200 });
  });

  it("rejects duplicate media identities and a source range that is not positive", () => {
    const input = {
      mediaInputId: "audio-0",
      descriptor: { inputKind: "audio_channel" as const, audioStreamIndex: 0, audioChannelIndex: 0 },
      sourceRange: { startUs: "0", endUs: "10" },
    };

    expect(() => planLongMediaSegments([input, input], limits)).toThrow(RangeError);
    expect(() => planLongMediaSegments([{ ...input, sourceRange: { startUs: "10", endUs: "10" } }], limits)).toThrow(RangeError);
  });
});
