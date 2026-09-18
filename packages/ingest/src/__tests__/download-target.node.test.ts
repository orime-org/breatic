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
  it("takes the last segment as the name and the rest as the key", () => {
    expect(downloadTarget("/download/image/2026-08-13/abc.png/cover.png")).toEqual({
      key: "image/2026-08-13/abc.png",
      filename: "cover.png",
    });
  });

  it("decodes a percent-encoded name", () => {
    expect(
      downloadTarget(`/download/image/abc.png/${encodeURIComponent("封面.png")}`),
    ).toEqual({ key: "image/abc.png", filename: "封面.png" });
  });

  it("decodes each key segment on its own", () => {
    expect(downloadTarget("/download/image/a%2Fb/x.png")).toEqual({
      key: "image/a/b",
      filename: "x.png",
    });
  });

  it("keeps a separator inside the name out of the name", () => {
    expect(downloadTarget("/download/image/abc.png/a%2Fb.png")?.filename).toBe(
      "a_b.png",
    );
  });

  it("is not a download URL without a name after the key", () => {
    expect(downloadTarget("/download/abc.png")).toBeNull();
  });

  it("is not a download URL under another prefix", () => {
    expect(downloadTarget("/uploads/abc/parts/1")).toBeNull();
  });

  it("refuses a malformed percent sequence", () => {
    expect(downloadTarget("/download/image/abc.png/%E0%A4%A.png")).toBeNull();
  });
});
