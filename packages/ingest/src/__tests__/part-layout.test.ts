// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Judging one part against the layout a ticket signed (#173, design §4.2).
 *
 * The layout is a bound on what an upload may put into R2: `totalParts` parts
 * of `partSize` each, the last one short. R2 itself accepts part numbers far
 * past that, so nothing outside this check keeps an upload inside what its
 * ticket authorised.
 */

import { describe, it, expect } from "vitest";
import { partLayoutRefusal } from "@ingest/part-layout.js";

const LAYOUT = { partSize: 1000, totalParts: 3 };

describe("a part that fits the signed layout", () => {
  it("takes a non-final part of exactly one part", () => {
    expect(partLayoutRefusal(1, 1000, LAYOUT)).toBeNull();
  });

  it("takes a final part shorter than one part", () => {
    expect(partLayoutRefusal(3, 1, LAYOUT)).toBeNull();
  });

  it("takes a final part of exactly one part", () => {
    expect(partLayoutRefusal(3, 1000, LAYOUT)).toBeNull();
  });

  it("takes a single-part upload of one byte", () => {
    expect(partLayoutRefusal(1, 1, { partSize: 1000, totalParts: 1 })).toBeNull();
  });
});

describe("a part that does not", () => {
  it("refuses a final part carrying no bytes", () => {
    expect(partLayoutRefusal(1, 0, { partSize: 1000, totalParts: 1 })).not.toBeNull();
  });

  it("refuses a number below one", () => {
    expect(partLayoutRefusal(0, 1000, LAYOUT)).not.toBeNull();
  });

  it("refuses a number past the last part", () => {
    expect(partLayoutRefusal(4, 1000, LAYOUT)).not.toBeNull();
  });

  it("refuses a number far past it, which R2 would otherwise accept", () => {
    expect(partLayoutRefusal(9999, 1000, LAYOUT)).not.toBeNull();
  });

  it("refuses a non-final part shorter than one part", () => {
    expect(partLayoutRefusal(2, 999, LAYOUT)).not.toBeNull();
  });

  it("refuses a non-final part longer than one part", () => {
    expect(partLayoutRefusal(2, 1001, LAYOUT)).not.toBeNull();
  });

  it("refuses a final part longer than one part", () => {
    expect(partLayoutRefusal(3, 1001, LAYOUT)).not.toBeNull();
  });

  it("says which of the two it was", () => {
    expect(partLayoutRefusal(4, 1000, LAYOUT)).not.toEqual(
      partLayoutRefusal(2, 999, LAYOUT),
    );
  });
});
