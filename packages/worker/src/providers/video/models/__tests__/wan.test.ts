// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from "vitest";

import { buildRequest } from "@worker/providers/video/models/wan.js";

/**
 * #1918 — what `wan-2.2-animate` puts on the wire.
 *
 * Its only upstream, WaveSpeed's `wavespeed-ai/wan-2.2/animate`, requires the
 * character image and the driving video whose motion is transferred onto it,
 * and takes a `mode` selecting animation over character replacement. The
 * first two are ours to map by name. The third the vendor lists as optional
 * and already defaults to `animate`; this family sends it anyway, to state
 * the intent rather than inherit it.
 *
 * Every mapped name is written out even where both sides use the same word:
 * that is what keeps our vocabulary and the vendor's independent (user
 * 2026-08-10), so a vendor rename is one line rather than a hunt.
 */
const CHARACTER = "https://cdn.test/character.png";
const DRIVING = "https://cdn.test/driving.mp4";

describe("wan buildRequest — wan-2.2-animate (#1918)", () => {
  it("sends the character image and the driving video under WaveSpeed's names", async () => {
    const [prompt, api] = await buildRequest(
      "the dancer keeps her red coat",
      "wan-2.2-animate",
      {
        image: CHARACTER,
        video: DRIVING,
        resolution: "480p",
        seed: -1,
      },
      "wavespeed",
    );

    expect(prompt).toBe("the dancer keeps her red coat");
    expect(api.image).toBe(CHARACTER);
    expect(api.video).toBe(DRIVING);
    expect(api.resolution).toBe("480p");
  });

  it("always selects animation, and never as something the user could set", async () => {
    const [, api] = await buildRequest(
      "the dancer keeps her red coat",
      "wan-2.2-animate",
      { image: CHARACTER, video: DRIVING },
      "wavespeed",
    );

    // The upstream field takes "animate" or "replace". Replacing a character
    // in an existing video is a mini-tool operation, not generation (#1917),
    // so this model only ever animates.
    expect(api.mode).toBe("animate");
  });

  it("sends nothing for a source the request does not carry", async () => {
    // A driving video that was never picked must not arrive as an empty
    // value: the upstream reads a source field's presence.
    const [, api] = await buildRequest(
      "the dancer keeps her red coat",
      "wan-2.2-animate",
      { image: CHARACTER, video: null, seed: -1 },
      "wavespeed",
    );

    expect("video" in api).toBe(false);
    // The catalog's "random" sentinel goes out under no name at all. The
    // vendor spells its own default the same way, so sending it would be
    // equivalent -- this does not lean on that staying true.
    expect("seed" in api).toBe(false);
  });
});
