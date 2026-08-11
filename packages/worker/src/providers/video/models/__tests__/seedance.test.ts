// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from "vitest";

import { buildRequest } from "@worker/providers/video/models/seedance.js";

/**
 * #1904 — the source fields `seedance-1.5-pro-i2v` puts on the wire, per
 * provider. Same rule as the Kling family: the conversion belongs to the
 * model on that provider. BytePlus takes `image_url` / `end_image_url`;
 * WaveSpeed's `bytedance/seedance-v1.5-pro/image-to-video` takes `image` /
 * `last_image`. Three of the four names differ from ours, the fourth
 * (`image` on WaveSpeed) happens to agree — and is stated all the same.
 */
const FIRST = "https://cdn.test/first.png";
const LAST = "https://cdn.test/last.png";

describe("seedance buildRequest — source field names per provider (#1904)", () => {
  it("sends WaveSpeed `image` + `last_image`", async () => {
    const [prompt, api] = await buildRequest(
      "a wave breaks",
      "seedance-1.5-pro-i2v",
      { image: FIRST, end_image: LAST, resolution: "720p" },
      "wavespeed",
    );

    expect(prompt).toBe("a wave breaks");
    expect(api.image).toBe(FIRST);
    expect(api.last_image).toBe(LAST);
    expect("end_image" in api).toBe(false);
    expect("image_url" in api).toBe(false);
  });

  it("sends BytePlus `image_url` + `end_image_url`", async () => {
    const [, api] = await buildRequest(
      "a wave breaks",
      "seedance-1.5-pro-i2v",
      { image: FIRST, end_image: LAST },
      "byteplus",
    );

    expect(api.image_url).toBe(FIRST);
    expect(api.end_image_url).toBe(LAST);
    expect("image" in api).toBe(false);
    expect("end_image" in api).toBe(false);
    expect("last_image" in api).toBe(false);
  });

  it("leaves a slot the request did not carry off the wire entirely", async () => {
    const [, ws] = await buildRequest(
      "x",
      "seedance-1.5-pro-i2v",
      { image: FIRST },
      "wavespeed",
    );
    expect("last_image" in ws).toBe(false);

    const [, bp] = await buildRequest(
      "x",
      "seedance-1.5-pro-i2v",
      { image: FIRST },
      "byteplus",
    );
    expect("end_image_url" in bp).toBe(false);
  });
});
