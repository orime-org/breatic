// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Reading a download URL apart.
 *
 * Asserted on the function rather than through a request: what a wrong shape
 * answers over HTTP is the same 404 an absent object answers, so a test
 * driving it that way cannot tell the two apart and passes whichever one it
 * really exercised.
 */

import { describe, it, expect } from "vitest";
import { downloadTarget } from "@ingest/download.js";

describe("reading a download URL apart", () => {
  it("takes everything after the prefix as the key", () => {
    expect(downloadTarget("/download/image/2026-08-13/abc.png")).toBe(
      "image/2026-08-13/abc.png",
    );
  });

  it("decodes each segment on its own", () => {
    expect(downloadTarget("/download/image/a%2Fb/x.png")).toBe("image/a/b/x.png");
  });

  it("decodes a percent-encoded segment", () => {
    expect(
      downloadTarget(`/download/image/${encodeURIComponent("封面.png")}`),
    ).toBe("image/封面.png");
  });

  it("is not a download URL with nothing after the prefix", () => {
    expect(downloadTarget("/download/")).toBeNull();
  });

  it("is not a download URL under another prefix", () => {
    expect(downloadTarget("/uploads/abc/parts/1")).toBeNull();
  });

  it("refuses a malformed percent sequence", () => {
    expect(downloadTarget("/download/image/%E0%A4%A.png")).toBeNull();
  });
});
