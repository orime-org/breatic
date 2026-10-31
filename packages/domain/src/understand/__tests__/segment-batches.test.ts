// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { groupLongMediaSegments } from "@domain/understand/segment-batches.js";

const segments = [
  { id: "segment-0", url: "https://media.example/0.mp3", sizeBytes: 3, startUs: "0", endUs: "1" },
  { id: "segment-1", url: "https://media.example/1.mp3", sizeBytes: 2, startUs: "1", endUs: "2" },
  { id: "segment-2", url: "https://media.example/2.mp3", sizeBytes: 2, startUs: "2", endUs: "3" },
  { id: "segment-3", url: "https://media.example/3.mp3", sizeBytes: 1, startUs: "3", endUs: "4" },
];

describe("groupLongMediaSegments", () => {
  it("sends consecutive segments together within each request budget", () => {
    expect(groupLongMediaSegments(segments, { maxBytes: 5, maxItems: 3 })).toEqual([
      segments.slice(0, 2),
      segments.slice(2),
    ]);
  });

  it("preserves order while respecting both item and byte limits", () => {
    fc.assert(fc.property(
      fc.array(fc.integer({ min: 1, max: 20 }), { minLength: 1, maxLength: 40 }),
      fc.integer({ min: 1, max: 40 }),
      fc.integer({ min: 1, max: 12 }),
      (sizes, maxBytes, maxItems) => {
        const eligible = sizes.filter((size) => size <= maxBytes).map((size, index) => ({
          url: `https://media.example/${String(index)}.mp3`,
          sizeBytes: size,
          startUs: String(index),
          endUs: String(index + 1),
        }));
        const batches = groupLongMediaSegments(eligible, { maxBytes, maxItems });

        expect(batches.flat()).toEqual(eligible);
        for (const batch of batches) {
          expect(batch.length).toBeLessThanOrEqual(maxItems);
          expect(batch.reduce((total, segment) => total + segment.sizeBytes, 0)).toBeLessThanOrEqual(maxBytes);
        }
      },
    ));
  });

  it("rejects a segment larger than the caller request budget", () => {
    expect(() => groupLongMediaSegments([
      { url: "https://media.example/large.mp3", sizeBytes: 6, startUs: "0", endUs: "1" },
    ], { maxBytes: 5, maxItems: 3 })).toThrow(RangeError);
  });
});
