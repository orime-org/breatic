// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { planLongMediaSegments } from "@breatic/shared";

const limits = {
  audioCoreSeconds: 300,
  videoCoreSeconds: 60,
  maxActiveLeaves: 512,
};

describe("planLongMediaSegments", () => {
  it("plans one source-file timeline as consecutive non-overlapping audio cores", () => {
    const plan = planLongMediaSegments([{
      mediaInputId: "audio-input-0",
      descriptor: { inputKind: "source_file", mediaKind: "audio" },
      sourceRange: { startUs: "5000000", endUs: "610000000" },
    }], limits);

    expect(plan).toEqual([
      {
        id: "audio-input-0:5000000:305000000",
        mediaInputId: "audio-input-0",
        descriptor: { inputKind: "source_file", mediaKind: "audio" },
        core: { startUs: "5000000", endUs: "305000000" },
        decode: { startUs: "5000000", endUs: "305000000" },
      },
      {
        id: "audio-input-0:305000000:605000000",
        mediaInputId: "audio-input-0",
        descriptor: { inputKind: "source_file", mediaKind: "audio" },
        core: { startUs: "305000000", endUs: "605000000" },
        decode: { startUs: "305000000", endUs: "605000000" },
      },
      {
        id: "audio-input-0:605000000:610000000",
        mediaInputId: "audio-input-0",
        descriptor: { inputKind: "source_file", mediaKind: "audio" },
        core: { startUs: "605000000", endUs: "610000000" },
        decode: { startUs: "605000000", endUs: "610000000" },
      },
    ]);
  });

  it("uses video core duration for a video source file", () => {
    const plan = planLongMediaSegments([{
      mediaInputId: "view-0",
      descriptor: { inputKind: "source_file", mediaKind: "video" },
      sourceRange: { startUs: "10000000", endUs: "130000000" },
    }], limits);

    expect(plan.map(({ core, decode }) => ({ core, decode }))).toEqual([
      {
        core: { startUs: "10000000", endUs: "70000000" },
        decode: { startUs: "10000000", endUs: "70000000" },
      },
      {
        core: { startUs: "70000000", endUs: "130000000" },
        decode: { startUs: "70000000", endUs: "130000000" },
      },
    ]);
  });

  it("counts active leaves for one source and rejects channel-derived input sets", () => {
    const inputs = [
      {
        mediaInputId: "audio-0",
        descriptor: { inputKind: "source_file" as const, mediaKind: "audio" as const },
        sourceRange: { startUs: "0", endUs: "305000000" },
      },
      {
        mediaInputId: "video-0",
        descriptor: { inputKind: "source_file" as const, mediaKind: "video" as const },
        sourceRange: { startUs: "0", endUs: "61000000" },
      },
    ];

    expect(() => planLongMediaSegments(inputs, { ...limits, maxActiveLeaves: 4 })).toThrow(RangeError);
    expect(() => planLongMediaSegments([inputs[0]!], { ...limits, maxActiveLeaves: 1 })).toThrow(RangeError);
  });

  it("preserves contiguous coverage and decode bounds for arbitrary valid source times", () => {
    fc.assert(fc.property(
      fc.bigInt({ min: -(10n ** 15n), max: 10n ** 15n }),
      fc.integer({ min: 1, max: 20_000_000 }),
      fc.integer({ min: 1, max: 600 }),
      (startUs, durationUs, coreSeconds) => {
        const endUs = startUs + BigInt(durationUs);
        const plan = planLongMediaSegments([{
          mediaInputId: "audio-0",
          descriptor: { inputKind: "source_file", mediaKind: "audio" },
          sourceRange: { startUs: String(startUs), endUs: String(endUs) },
        }], {
          audioCoreSeconds: coreSeconds,
          videoCoreSeconds: coreSeconds,
          maxActiveLeaves: durationUs,
        });

        expect(plan[0]?.core.startUs).toBe(String(startUs));
        expect(plan.at(-1)?.core.endUs).toBe(String(endUs));
        for (const [index, segment] of plan.entries()) {
          expect(segment.decode).toEqual(segment.core);
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
      descriptor: { inputKind: "source_file" as const, mediaKind: "audio" as const },
      sourceRange: { startUs: "0", endUs: "10" },
    };

    expect(() => planLongMediaSegments([input, input], limits)).toThrow(RangeError);
    expect(() => planLongMediaSegments([{ ...input, sourceRange: { startUs: "10", endUs: "10" } }], limits)).toThrow(RangeError);
  });
});
