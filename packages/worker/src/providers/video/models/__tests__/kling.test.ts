// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from "vitest";

import { buildRequest } from "@worker/providers/video/models/kling.js";

/**
 * #1904 — the source fields `kling-o3-pro-i2v` puts on the wire, per provider.
 *
 * Our own param names travel our API; the conversion to what one vendor calls
 * them belongs to the model on that provider. KlingAI's official
 * `/v1/videos/image2video` takes `image` and `image_tail`; WaveSpeed's
 * `kwaivgi/kling-video-o3-pro/image-to-video` takes `image` and `end_image`.
 * The names agree on the first frame and differ on the last one, which is
 * exactly why both are stated rather than passed through.
 */
const FIRST = "https://cdn.test/first.png";
const LAST = "https://cdn.test/last.png";

describe("kling buildRequest — source field names per provider (#1904)", () => {
  it("sends KlingAI `image` + `image_tail`", async () => {
    const [prompt, api] = await buildRequest(
      "a lantern drifts",
      "kling-o3-pro-i2v",
      { image: FIRST, end_image: LAST, duration: 5 },
      "klingai",
    );

    expect(prompt).toBe("a lantern drifts");
    expect(api.image).toBe(FIRST);
    expect(api.image_tail).toBe(LAST);
    // The names the family table would have sent. KlingAI accepts neither.
    expect("image_url" in api).toBe(false);
    expect("tail_image_url" in api).toBe(false);
    // Our own name never reaches the vendor.
    expect("end_image" in api).toBe(false);
  });

  it("sends WaveSpeed `image` + `end_image`", async () => {
    const [, api] = await buildRequest(
      "a lantern drifts",
      "kling-o3-pro-i2v",
      { image: FIRST, end_image: LAST, generate_audio: true },
      "wavespeed",
    );

    expect(api.image).toBe(FIRST);
    expect(api.end_image).toBe(LAST);
    expect("image_url" in api).toBe(false);
    expect("image_tail" in api).toBe(false);
  });

  it("keeps the other conversions each provider already did", async () => {
    const [, ws] = await buildRequest(
      "x",
      "kling-o3-pro-i2v",
      { image: FIRST, generate_audio: true },
      "wavespeed",
    );
    expect(ws.sound).toBe(true);
    expect("generate_audio" in ws).toBe(false);

    const [, kai] = await buildRequest(
      "x",
      "kling-o3-pro-i2v",
      { image: FIRST, duration: 5 },
      "klingai",
    );
    // KlingAI's official API wants the duration as a string.
    expect(kai.duration).toBe("5");
  });

  it("leaves a slot the request did not carry off the wire entirely", async () => {
    // The vendor reads the key's presence, so an absent end frame must not
    // arrive as an empty value.
    const [, kai] = await buildRequest(
      "x",
      "kling-o3-pro-i2v",
      { image: FIRST },
      "klingai",
    );
    expect("image_tail" in kai).toBe(false);

    const [, ws] = await buildRequest(
      "x",
      "kling-o3-pro-i2v",
      { image: FIRST },
      "wavespeed",
    );
    expect("end_image" in ws).toBe(false);
  });
});

/**
 * #1927 — the field names `kling-o3-pro-ref` puts on the wire.
 *
 * Unlike the case above, this one is a regression guard rather than a bug
 * being fixed: the reference array happens to be called `images` on both
 * sides, so it would travel correctly today by falling through the family
 * table untouched. Stating it is the rule (user 2026-08-10) — a name that
 * agrees by coincidence is indistinguishable from one nobody ever checked,
 * and the first model whose vendor calls it something else would be found out
 * by a failed generation rather than by this file.
 */
const REF_IMAGES = ["https://cdn.test/a.png", "https://cdn.test/b.png"];

describe("kling buildRequest — reference-to-video field names (#1927)", () => {
  it("sends WaveSpeed the reference array as `images`", async () => {
    const [prompt, api] = await buildRequest(
      "the two of them walk into frame",
      "kling-o3-pro-ref",
      { images: REF_IMAGES, duration: 5 },
      "wavespeed",
    );

    expect(prompt).toBe("the two of them walk into frame");
    expect(api.images).toEqual(REF_IMAGES);
  });

  it("still converts the audio flag the family renames", async () => {
    // The model states only what is its own; whatever the family has always
    // done still applies underneath it.
    const [, api] = await buildRequest(
      "the two of them walk into frame",
      "kling-o3-pro-ref",
      { images: REF_IMAGES, generate_audio: true },
      "wavespeed",
    );

    expect(api.sound).toBe(true);
    expect("generate_audio" in api).toBe(false);
  });
});
