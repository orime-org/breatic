// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from "vitest";

import { storageKey } from "@core/infra/storage/index.js";

/**
 * storageKey dotted-ext contract (#1630). The key template appends `ext`
 * verbatim (`{ts}_{uuid}{ext}`), so the CALLER owns the format: `ext` must
 * be a dotted extension (".png"), a compound dotted suffix ("_cover.jpg"),
 * or "" for none. A bare "png" is a caller bug — storageKey (the single
 * choke point every key flows through) fails fast rather than silently
 * producing a dot-less "..._<uuid>png". The check is `includes('.')` (not
 * startsWith), so compound suffixes like "_cover.jpg" satisfy the contract.
 */
describe("storageKey — dotted-ext contract (#1630)", () => {
  const base = { userId: "u", projectId: "p", taskType: "image" as const };

  it("appends a dotted extension verbatim (AIGC '.png', local '.mp4')", () => {
    expect(storageKey({ ...base, ext: ".png" })).toMatch(/[0-9a-f]\.png$/);
    expect(storageKey({ ...base, ext: ".png" })).not.toMatch(/\.\.png$/);
    expect(storageKey({ ...base, ext: ".mp4" })).toMatch(/\.mp4$/);
  });

  it("accepts a compound dotted suffix (video-cover '_cover.jpg')", () => {
    const key = storageKey({ ...base, ext: "_cover.jpg" });
    expect(key.endsWith("_cover.jpg")).toBe(true);
    expect(key.endsWith("._cover.jpg")).toBe(false);
  });

  it("accepts an empty ext as no extension (no lone trailing dot)", () => {
    const key = storageKey({ ...base, ext: "" });
    expect(key.endsWith(".")).toBe(false);
    expect(key).toMatch(/[0-9a-f-]$/);
  });

  it("THROWS on a bare (dot-less) extension — the caller must dot it", () => {
    expect(() => storageKey({ ...base, ext: "png" })).toThrow(/dotted/);
    expect(() => storageKey({ ...base, ext: "bin" })).toThrow(/dotted/);
  });

  it("keeps the userId/projectId/taskType/date prefix intact", () => {
    expect(storageKey({ ...base, ext: ".png" })).toMatch(
      /^u\/p\/image\/\d{4}-\d{2}-\d{2}\/\d+_[0-9a-f-]+\.png$/,
    );
  });
});
