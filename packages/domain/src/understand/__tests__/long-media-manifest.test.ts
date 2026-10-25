// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { replaceMediaManifestLeaf } from "@breatic/shared";

const initial = {
  revision: 4,
  leaves: [
    { id: "parent", mediaInputId: "audio-0", startUs: "0", endUs: "10000000" },
    { id: "other", mediaInputId: "audio-1", startUs: "0", endUs: "20000000" },
  ],
};

describe("replaceMediaManifestLeaf", () => {
  it("creates a successor revision that replaces one parent with complete ordered children", () => {
    const next = replaceMediaManifestLeaf(initial, {
      expectedRevision: 4,
      parentLeafId: "parent",
      children: [
        { id: "left", mediaInputId: "audio-0", startUs: "0", endUs: "4000000" },
        { id: "right", mediaInputId: "audio-0", startUs: "4000000", endUs: "10000000" },
      ],
    });

    expect(next).toEqual({
      revision: 5,
      leaves: [
        { id: "left", mediaInputId: "audio-0", startUs: "0", endUs: "4000000" },
        { id: "right", mediaInputId: "audio-0", startUs: "4000000", endUs: "10000000" },
        initial.leaves[1],
      ],
    });
    expect(initial.revision).toBe(4);
    expect(initial.leaves[0]?.id).toBe("parent");
  });

  it("rejects a stale revision, a coverage gap, and a child from another media input", () => {
    const request = {
      parentLeafId: "parent",
      children: [
        { id: "left", mediaInputId: "audio-0", startUs: "0", endUs: "4000000" },
        { id: "right", mediaInputId: "audio-0", startUs: "4000000", endUs: "10000000" },
      ],
    };
    expect(() => replaceMediaManifestLeaf(initial, { ...request, expectedRevision: 3 })).toThrow();
    expect(() => replaceMediaManifestLeaf(initial, {
      expectedRevision: 4,
      parentLeafId: "parent",
      children: [
        { id: "left", mediaInputId: "audio-0", startUs: "0", endUs: "4000000" },
        { id: "right", mediaInputId: "audio-0", startUs: "5000000", endUs: "10000000" },
      ],
    })).toThrow(RangeError);
    expect(() => replaceMediaManifestLeaf(initial, {
      expectedRevision: 4,
      parentLeafId: "parent",
      children: [
        { id: "left", mediaInputId: "audio-0", startUs: "0", endUs: "4000000" },
        { id: "right", mediaInputId: "audio-1", startUs: "4000000", endUs: "10000000" },
      ],
    })).toThrow(RangeError);
  });

  it("keeps exact coverage when the parent is split at any interior microsecond", () => {
    fc.assert(fc.property(
      fc.bigInt({ min: -(10n ** 15n), max: 10n ** 15n }),
      fc.bigInt({ min: 1n, max: 10n ** 12n }),
      fc.bigInt({ min: 1n, max: 10n ** 12n }),
      (startUs, leftWidthUs, rightWidthUs) => {
        const splitUs = startUs + leftWidthUs;
        const endUs = splitUs + rightWidthUs;
        const parent = { id: "parent", mediaInputId: "audio-0", startUs: String(startUs), endUs: String(endUs) };
        const next = replaceMediaManifestLeaf({ revision: 4, leaves: [parent] }, {
          expectedRevision: 4,
          parentLeafId: parent.id,
          children: [
            { id: "left", mediaInputId: parent.mediaInputId, startUs: parent.startUs, endUs: String(splitUs) },
            { id: "right", mediaInputId: parent.mediaInputId, startUs: String(splitUs), endUs: parent.endUs },
          ],
        });

        expect(next.revision).toBe(5);
        expect(BigInt(next.leaves[0]?.startUs ?? "0")).toBe(startUs);
        expect(BigInt(next.leaves[0]?.endUs ?? "0")).toBe(BigInt(next.leaves[1]?.startUs ?? "0"));
        expect(BigInt(next.leaves[1]?.endUs ?? "0")).toBe(endUs);
      },
    ), { numRuns: 200 });
  });
});
