// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Where a video's cut frame goes (#209 + #210, acceptance A5).
 *
 * The key is derived from the object the frame comes out of, so asking twice
 * for the same upload names the same place. A finish request is replay-safe
 * and does get re-delivered; a fresh random key on each delivery would put a
 * second PNG in R2 that no ledger row names and no reclaim list holds — which
 * is the leak #188 recorded, on a different path.
 */

import { describe, it, expect } from "vitest";

import { coverRequestFor } from "@domain/asset/asset.service.js";

const VIDEO_KEY = "video/2026-09-10/1789040933407_657ff94b-5fd7-41ba-8492.mp4";

describe("the key a video's cover is written to", () => {
  it("is the same on every ask for one upload", () => {
    const first = coverRequestFor("video/mp4", VIDEO_KEY);
    const second = coverRequestFor("video/mp4", VIDEO_KEY);

    expect(first?.key).toBe(second?.key);
  });

  it("sits beside the object it was cut from", () => {
    const asked = coverRequestFor("video/mp4", VIDEO_KEY);

    expect(asked?.key).toBe(
      "video/2026-09-10/1789040933407_657ff94b-5fd7-41ba-8492_cover.png",
    );
  });

  it("differs between two uploads", () => {
    const one = coverRequestFor("video/mp4", VIDEO_KEY);
    const other = coverRequestFor(
      "video/mp4",
      "video/2026-09-10/1789040999999_aaaabbbb-cccc-dddd-eeee.mp4",
    );

    expect(one?.key).not.toBe(other?.key);
  });

  it("keeps the key whole when the object has no extension", () => {
    const asked = coverRequestFor("video/mp4", "video/2026-09-10/1789040933407_abc");

    expect(asked?.key).toBe("video/2026-09-10/1789040933407_abc_cover.png");
  });
});

describe("media with no frame to cut", () => {
  it.each([
    ["image/png", "image/2026-09-10/1_a.png"],
    ["audio/mpeg", "audio/2026-09-10/1_a.mp3"],
    ["text/plain", "other/2026-09-10/1_a.txt"],
  ])("asks for no cover for %s", (contentType, key) => {
    expect(coverRequestFor(contentType, key)).toBeUndefined();
  });
});
