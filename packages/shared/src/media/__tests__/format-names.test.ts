// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The word a format goes by on screen.
 *
 * Two gates name a format while refusing a file, and their sentences can sit
 * one node apart in the same list — so what matters here is that one table
 * answers both, and that it still answers for the formats it does not list,
 * which is most of what a refusal is handed.
 */

import { describe, expect, it } from "vitest";

import { formatNameOf, formatPhrase } from "@shared/media/format-names.js";
import { uploadableFormatList } from "@shared/upload/media-type.js";

describe("what to call the format a file is in", () => {
  it("gives a listed type the word a reader uses for it", () => {
    expect(formatNameOf("audio/mpeg")).toBe("MP3");
    expect(formatNameOf("video/quicktime")).toBe("MOV");
    expect(formatNameOf("image/jpeg")).toBe("JPG");
  });

  // One subtype is two formats depending on the medium, which is why the
  // table is keyed on the whole type.
  it("tells an M4A from an MP4", () => {
    expect(formatNameOf("audio/mp4")).toBe("M4A");
    expect(formatNameOf("video/mp4")).toBe("MP4");
  });

  it("falls back to the subtype for a format the table does not list", () => {
    expect(formatNameOf("image/tiff")).toBe("TIFF");
    expect(formatNameOf("audio/flac")).toBe("FLAC");
  });

  // An .avi arrives as `video/x-msvideo` and a .wmv as `video/x-ms-wmv`;
  // neither registry prefix is part of what anybody calls the file.
  it("drops the registry prefix before capitalising", () => {
    expect(formatNameOf("video/x-msvideo")).toBe("MSVIDEO");
    expect(formatNameOf("audio/vnd.wave")).toBe("WAVE");
  });

  it("names nothing when there is no type to name", () => {
    expect(formatNameOf(undefined)).toBeNull();
    expect(formatNameOf(null)).toBeNull();
    expect(formatNameOf("application")).toBeNull();
    expect(formatNameOf("image/")).toBeNull();
  });
});

describe("the two gates spell from one table", () => {
  // The upload gate's own sentence is built from the same words the reading
  // gate names a refused file with, so a format both know cannot come to be
  // spelled two ways.
  it("spells a format the same whichever gate names it", () => {
    for (const type of ["image/png", "video/quicktime", "audio/mpeg"]) {
      const word = formatNameOf(type);
      expect(word).not.toBeNull();
      const medium = type.split("/")[0] as "image" | "video" | "audio";
      expect(uploadableFormatList(medium).split(" / ")).toContain(word);
    }
  });

  it("strings several names together with one separator", () => {
    expect(formatPhrase(["MP3", "WAV"])).toBe("MP3 / WAV");
    expect(uploadableFormatList("image")).toBe(
      formatPhrase(["PNG", "JPG", "WebP"]),
    );
  });
});
