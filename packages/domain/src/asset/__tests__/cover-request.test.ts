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
 *
 * Naming one is all this does. Whether there is a frame to cut is read off the
 * stored bytes at the edge, which is the only place that has seen them (#240) —
 * so a key is named for every upload and the edge narrows. Deciding it here,
 * from what the caller declared, left a real MP4 that someone announced as
 * `audio/mpeg` with no key to put a poster at, silently and forever.
 */

import { describe, it, expect } from "vitest";

import { coverRequestFor } from "@domain/asset/asset.service.js";

const VIDEO_KEY = "video/2026-09-10/1789040933407_657ff94b-5fd7-41ba-8492.mp4";

describe("the key a video's cover is written to", () => {
  it("is the same on every ask for one upload", () => {
    const first = coverRequestFor(VIDEO_KEY);
    const second = coverRequestFor(VIDEO_KEY);

    expect(first.key).toBe(second.key);
  });

  it("sits beside the object it was cut from", () => {
    const asked = coverRequestFor(VIDEO_KEY);

    expect(asked.key).toBe(
      "video/2026-09-10/1789040933407_657ff94b-5fd7-41ba-8492_cover.png",
    );
  });

  it("differs between two uploads", () => {
    const one = coverRequestFor(VIDEO_KEY);
    const other = coverRequestFor(
      "video/2026-09-10/1789040999999_aaaabbbb-cccc-dddd-eeee.mp4",
    );

    expect(one.key).not.toBe(other.key);
  });

  it("keeps the key whole when the object has no extension", () => {
    const asked = coverRequestFor("video/2026-09-10/1789040933407_abc");

    expect(asked.key).toBe("video/2026-09-10/1789040933407_abc_cover.png");
  });
});

// Nobody on this side has seen a byte. What an upload was announced as says
// nothing about what is in it, and the edge refuses to cut a frame off
// anything but a video anyway — so a key costs nothing and its absence cannot
// be undone later.
describe("an upload nobody has looked at yet", () => {
  it.each([
    "image/2026-09-10/1_a.png",
    "audio/2026-09-10/1_a.mp3",
    "other/2026-09-10/1_a.txt",
  ])("is named a place for a frame all the same (%s)", (key) => {
    expect(coverRequestFor(key).key).toBe(`${key.replace(/\.[^./]+$/, "")}_cover.png`);
  });
});
