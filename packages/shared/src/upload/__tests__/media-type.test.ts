// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from "vitest";

import {
  isUploadableMediaType,
  reduceMediaType,
} from "@shared/upload/media-type.js";

describe("reduceMediaType", () => {
  it("drops the parameters after a semicolon", () => {
    expect(reduceMediaType("image/png; charset=utf-8")).toBe("image/png");
  });

  it("keeps only the first value when the header carries commas", () => {
    // A browser honours the LAST parsable value here, so the essence the gate
    // reads has to be the first one — measured in Chromium, "video/mp4,text/html"
    // renders as HTML and runs the scripts in it.
    expect(reduceMediaType("video/mp4,text/html")).toBe("video/mp4");
  });

  it("cuts at whichever separator comes first", () => {
    expect(reduceMediaType("video/mp4; boundary=x,text/html")).toBe("video/mp4");
    expect(reduceMediaType("video/mp4,text/html; charset=utf-8")).toBe(
      "video/mp4",
    );
  });

  it("trims surrounding whitespace", () => {
    expect(reduceMediaType("  video/mp4  ")).toBe("video/mp4");
    expect(reduceMediaType("video/mp4 , text/html")).toBe("video/mp4");
  });

  it("lowercases, because a media type is case-insensitive", () => {
    expect(reduceMediaType("VIDEO/MP4")).toBe("video/mp4");
    expect(reduceMediaType("Image/PNG; Charset=UTF-8")).toBe("image/png");
  });

  it("answers an empty string for a header that is absent or blank", () => {
    expect(reduceMediaType(null)).toBe("");
    expect(reduceMediaType(undefined)).toBe("");
    expect(reduceMediaType("")).toBe("");
    expect(reduceMediaType("   ")).toBe("");
    expect(reduceMediaType(";charset=utf-8")).toBe("");
  });
});

describe("isUploadableMediaType", () => {
  it("accepts the three families the canvas stores", () => {
    expect(isUploadableMediaType("image/png")).toBe(true);
    expect(isUploadableMediaType("video/mp4")).toBe(true);
    expect(isUploadableMediaType("audio/mpeg")).toBe(true);
  });

  it("refuses everything outside them", () => {
    expect(isUploadableMediaType("text/html")).toBe(false);
    expect(isUploadableMediaType("application/pdf")).toBe(false);
    expect(isUploadableMediaType("application/octet-stream")).toBe(false);
    expect(isUploadableMediaType("model/gltf-binary")).toBe(false);
    expect(isUploadableMediaType("")).toBe(false);
  });

  it("refuses a family name that is only a prefix of the word", () => {
    // "imagevideo/x" starts with "image" but not with "image/".
    expect(isUploadableMediaType("imagevideo/x")).toBe(false);
    expect(isUploadableMediaType("images/png")).toBe(false);
    expect(isUploadableMediaType("image")).toBe(false);
  });

  it("refuses what a comma-carrying header reduces to when that is not a media kind", () => {
    expect(isUploadableMediaType(reduceMediaType("text/html,image/png"))).toBe(
      false,
    );
  });

  it("never lets a comma-carrying header through as it arrived", () => {
    // The pair has to admit this header AND strip it. Admitting it is not
    // enough: the raw string starts with "video/" too, so a gate that only
    // asked whether it is uploadable would hand the whole thing to storage,
    // and a reader would be served the last value in it.
    const raw = "video/mp4,text/html";
    const reduced = reduceMediaType(raw);
    expect(isUploadableMediaType(reduced)).toBe(true);
    expect(reduced).toBe("video/mp4");
  });
});
