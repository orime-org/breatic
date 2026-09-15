// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from "vitest";

import {
  hasCoverFrame,
  isStorableMediaType,
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
  it("accepts the formats a model can be given", () => {
    expect(isUploadableMediaType("image/png")).toBe(true);
    expect(isUploadableMediaType("image/jpeg")).toBe(true);
    expect(isUploadableMediaType("image/webp")).toBe(true);
    expect(isUploadableMediaType("video/mp4")).toBe(true);
    expect(isUploadableMediaType("video/webm")).toBe(true);
    expect(isUploadableMediaType("video/quicktime")).toBe(true);
    expect(isUploadableMediaType("audio/mpeg")).toBe(true);
    expect(isUploadableMediaType("audio/wav")).toBe(true);
    expect(isUploadableMediaType("audio/mp4")).toBe(true);
    expect(isUploadableMediaType("audio/webm")).toBe(true);
  });

  it("refuses everything outside them", () => {
    expect(isUploadableMediaType("text/html")).toBe(false);
    expect(isUploadableMediaType("application/pdf")).toBe(false);
    expect(isUploadableMediaType("application/octet-stream")).toBe(false);
    expect(isUploadableMediaType("model/gltf-binary")).toBe(false);
    expect(isUploadableMediaType("")).toBe(false);
  });

  // Markup describing a picture, which no model reads and which every browser
  // runs the scripts in. A family test admits it because it is an image by
  // family and not by content, which is the reason the gate names formats.
  it("refuses svg, which is a document rather than an encoded picture", () => {
    expect(isUploadableMediaType("image/svg+xml")).toBe(false);
  });

  it("refuses a format inside an accepted family that a model cannot read", () => {
    expect(isUploadableMediaType("image/x-icon")).toBe(false);
    expect(isUploadableMediaType("video/x-ms-wmv")).toBe(false);
    expect(isUploadableMediaType("audio/x-aiff")).toBe(false);
  });

  it("refuses a family name that is only a prefix of the word", () => {
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

describe("hasCoverFrame", () => {
  it("says a video has one", () => {
    expect(hasCoverFrame("video/mp4")).toBe(true);
    expect(hasCoverFrame("video/webm")).toBe(true);
    expect(hasCoverFrame("video/quicktime")).toBe(true);
  });

  it("says nothing else does", () => {
    expect(hasCoverFrame("image/png")).toBe(false);
    expect(hasCoverFrame("audio/mpeg")).toBe(false);
    expect(hasCoverFrame("application/octet-stream")).toBe(false);
    expect(hasCoverFrame("")).toBe(false);
  });

  it("reads the essence, not the header it arrived in", () => {
    // Both lanes that ask reach it with a value a source declared. One has
    // already been reduced; the other carries whatever the header said.
    expect(hasCoverFrame("video/mp4; codecs=avc1")).toBe(true);
    expect(hasCoverFrame("VIDEO/MP4")).toBe(true);
    expect(hasCoverFrame("image/png,video/mp4")).toBe(false);
  });

  it("refuses a family name that is only a prefix of the word", () => {
    expect(hasCoverFrame("videos/mp4")).toBe(false);
    expect(hasCoverFrame("video")).toBe(false);
  });
});

describe("isUploadableMediaType — one format, more than one name", () => {
  // The registry carries historical names for some of these, and the name a
  // caller happens to hold depends on who it asked: a browser and an operating
  // system report an .m4a as `audio/x-m4a` as readily as `audio/mp4`, and so
  // does a reader of the stored bytes. Asking "do we take this type" has to
  // answer the same for every name of the same format, or the answer depends
  // on which lane the question came from.
  it("takes an m4a under either of its names", () => {
    expect(isUploadableMediaType("audio/mp4")).toBe(true);
    expect(isUploadableMediaType("audio/x-m4a")).toBe(true);
  });

  it("takes a wav under either of its names", () => {
    expect(isUploadableMediaType("audio/wav")).toBe(true);
    expect(isUploadableMediaType("audio/x-wav")).toBe(true);
  });

  it("takes an mp3 under either of its names", () => {
    expect(isUploadableMediaType("audio/mpeg")).toBe(true);
    expect(isUploadableMediaType("audio/mp3")).toBe(true);
  });

  it("still refuses a format nothing here reads", () => {
    expect(isUploadableMediaType("image/svg+xml")).toBe(false);
    expect(isUploadableMediaType("application/zip")).toBe(false);
    expect(isUploadableMediaType("image/x-png-but-not-really")).toBe(false);
  });
});

describe("isStorableMediaType — what R2 may hold, which is a wider question", () => {
  // Everything a person may put on a canvas, and on top of it what our own
  // generators produce. A 3D model is nothing a canvas file picker offers and
  // nothing a model can be handed, and it still has to reach storage: the
  // three_d task type writes `model/gltf-binary` and its two configured
  // providers are live.
  it("holds everything a person may upload", () => {
    for (const type of [
      "image/png", "image/jpeg", "image/webp",
      "video/mp4", "video/webm", "video/quicktime",
      "audio/mpeg", "audio/wav", "audio/mp4", "audio/webm",
    ]) {
      expect(isStorableMediaType(type)).toBe(true);
    }
  });

  it("holds what our own generators produce beyond that", () => {
    expect(isStorableMediaType("model/gltf-binary")).toBe(true);
  });

  it("refuses what neither a person nor a generator gives us", () => {
    expect(isStorableMediaType("image/svg+xml")).toBe(false);
    expect(isStorableMediaType("application/zip")).toBe(false);
    expect(isStorableMediaType("text/html")).toBe(false);
  });

  // This list is read against a type taken off bytes, so it is written in the
  // spellings bytes produce. A name no reader can answer with protects
  // nothing, however plausible it looks beside the ones that do: JSON has no
  // signature, and a reader calls it `text/plain`.
  it("is spelled the way bytes read, not the way a producer declares", () => {
    expect(isStorableMediaType("application/json")).toBe(false);
  });

  it("reads an alias the same way the upload gate does", () => {
    expect(isStorableMediaType("audio/x-m4a")).toBe(true);
  });
});
