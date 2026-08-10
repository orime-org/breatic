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
