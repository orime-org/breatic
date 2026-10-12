// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect } from "vitest";

import { uprightKeyFor } from "@shared/upload/upright.js";

const UUID = "0b6c2a54-3f7d-4e8a-9c1b-5d2e7f4a8b90";

describe("uprightKeyFor", () => {
  it("names the upright picture beside the original, before its extension", () => {
    expect(uprightKeyFor(`image/2026-10-10/1790000000000_${UUID}.jpg`)).toBe(
      `image/2026-10-10/1790000000000_${UUID}_upright.jpg`,
    );
  });

  it("keeps the original's extension, since the format does not change", () => {
    expect(uprightKeyFor(`image/2026-10-10/1_${UUID}.webp`)).toBe(
      `image/2026-10-10/1_${UUID}_upright.webp`,
    );
  });

  it("appends the marker to a key with no extension", () => {
    expect(uprightKeyFor(`image/2026-10-10/1_${UUID}`)).toBe(`image/2026-10-10/1_${UUID}_upright`);
  });
});
