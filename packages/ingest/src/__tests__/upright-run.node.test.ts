// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from "vitest";
import { UPRIGHT_OBJECT_HOST, uprightArgs, uprightObjectUrl } from "@ingest/upright-run.js";

describe("uprightArgs", () => {
  it("re-encodes a JPEG at the configured quality, keeping its colour profile", () => {
    expect(uprightArgs({ contentType: "image/jpeg", lossless: false, quality: 90 })).toEqual([
      "autorot",
      "stdin",
      ".jpg[Q=90,keep=icc]",
    ]);
  });

  it("keeps a lossless WebP lossless", () => {
    expect(uprightArgs({ contentType: "image/webp", lossless: true, quality: 90 })).toEqual([
      "autorot",
      "stdin",
      ".webp[lossless,keep=icc]",
    ]);
  });

  it("re-encodes a lossy WebP at the configured quality", () => {
    expect(uprightArgs({ contentType: "image/webp", lossless: false, quality: 85 })).toEqual([
      "autorot",
      "stdin",
      ".webp[Q=85,keep=icc]",
    ]);
  });

  it("writes a PNG losslessly", () => {
    expect(uprightArgs({ contentType: "image/png", lossless: false, quality: 90 })).toEqual([
      "autorot",
      "stdin",
      ".png[keep=icc]",
    ]);
  });

  it("refuses a type it cannot write back", () => {
    expect(uprightArgs({ contentType: "image/gif", lossless: false, quality: 90 })).toBeNull();
  });
});

describe("uprightObjectUrl", () => {
  it("names the key on the host only the write-back handler answers", () => {
    expect(uprightObjectUrl("image/2026-10-10/a b.jpg")).toBe(`http://${UPRIGHT_OBJECT_HOST}/image/2026-10-10/a%20b.jpg`);
  });
});
