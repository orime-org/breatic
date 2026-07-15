// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Cross-modality execute-gate rule (#1675). Pins the (modality, mode) → source
 * type mapping, the wire `sourcesByMode` computation, and the server gate
 * `violatesSourceRequirement` — including the multi-source `talking_head`
 * (image + audio) and the hybrid (t2i+i2i) source-less escape hatch. Critical
 * path (billing pre-check gate), so every branch is pinned.
 */

import { describe, it, expect } from "vitest";
import {
  computeSourcesByMode,
  violatesSourceRequirement,
} from "@domain/model-catalog/source-requirement.js";

describe("computeSourcesByMode (#1675)", () => {
  it("maps image i2i/edit → image, t2i → []", () => {
    expect(computeSourcesByMode("image", ["t2i", "i2i"])).toEqual({
      t2i: [],
      i2i: ["image"],
    });
  });

  it("maps video edit → video, i2v → image (mode name is modality-scoped)", () => {
    expect(computeSourcesByMode("video", "edit")).toEqual({ edit: ["video"] });
    expect(computeSourcesByMode("video", "i2v")).toEqual({ i2v: ["image"] });
  });

  it("maps talking_head → BOTH image + audio", () => {
    expect(computeSourcesByMode("video", "talking_head")).toEqual({
      talking_head: ["image", "audio"],
    });
  });

  it("maps audio a2m/separate → audio, tts voice_clone → audio, 3d i23d → image", () => {
    expect(computeSourcesByMode("audio", "a2m")).toEqual({ a2m: ["audio"] });
    expect(computeSourcesByMode("tts", "voice_clone")).toEqual({ voice_clone: ["audio"] });
    expect(computeSourcesByMode("three_d", "i23d")).toEqual({ i23d: ["image"] });
  });

  it("maps a text-to-X / unknown mode → []", () => {
    expect(computeSourcesByMode("video", "t2v")).toEqual({ t2v: [] });
    expect(computeSourcesByMode("image", "no-such-mode")).toEqual({ "no-such-mode": [] });
  });
});

describe("violatesSourceRequirement (#1675 server gate)", () => {
  it("passes an unknown model (empty sourcesByMode)", () => {
    expect(violatesSourceRequirement({}, {})).toBe(false);
  });

  it("passes a hybrid (t2i+i2i) with no source — image-less is a valid t2i run", () => {
    const sbm = computeSourcesByMode("image", ["t2i", "i2i"]);
    expect(violatesSourceRequirement(sbm, {})).toBe(false);
    expect(violatesSourceRequirement(sbm, { images: [] })).toBe(false);
  });

  it("gates a pure i2v (no source-less mode) when no image is present", () => {
    const sbm = computeSourcesByMode("video", "i2v");
    expect(violatesSourceRequirement(sbm, {})).toBe(true);
    expect(violatesSourceRequirement(sbm, { images: [] })).toBe(true);
    expect(violatesSourceRequirement(sbm, { images: ["u"] })).toBe(false);
    // image source may arrive via the `image` field too
    expect(violatesSourceRequirement(sbm, { image: "u" })).toBe(false);
  });

  it("gates a video-edit when no video is present (image does NOT satisfy)", () => {
    const sbm = computeSourcesByMode("video", "edit");
    expect(violatesSourceRequirement(sbm, { images: ["u"] })).toBe(true);
    expect(violatesSourceRequirement(sbm, { video_url: "u" })).toBe(false);
    expect(violatesSourceRequirement(sbm, { video: "u" })).toBe(false);
  });

  it("gates talking_head until BOTH image AND audio are present", () => {
    const sbm = computeSourcesByMode("video", "talking_head");
    expect(violatesSourceRequirement(sbm, { images: ["u"] })).toBe(true); // audio missing
    expect(violatesSourceRequirement(sbm, { audio: "u" })).toBe(true); // image missing
    expect(violatesSourceRequirement(sbm, { images: ["u"], audio: "u" })).toBe(false);
  });

  it("accepts audio source via any carrier field (audio / audio_url / ref_audio_url)", () => {
    const sbm = computeSourcesByMode("tts", "voice_clone");
    expect(violatesSourceRequirement(sbm, { ref_audio_url: "u" })).toBe(false);
    expect(violatesSourceRequirement(sbm, {})).toBe(true);
  });

  it("does NOT accept a malformed non-array `images` (a bare string) — the worker reads `images` as an array, so a string is not a usable source", () => {
    // `params` is `z.record(z.unknown())` on the wire — zod does not shape-check
    // it, so a crafted request can send `images: "garbage"`. The worker iterates
    // `images` as an array (google/byteplus transports), so a bare string is a
    // guaranteed-failure input, not a source. The gate must still reject it.
    const sbm = computeSourcesByMode("image", "i2i");
    expect(violatesSourceRequirement(sbm, { images: "https://cdn/x.png" })).toBe(true);
    // an array whose entries are not usable strings is likewise no source
    expect(violatesSourceRequirement(sbm, { images: [123] })).toBe(true);
    expect(violatesSourceRequirement(sbm, { images: [""] })).toBe(true);
    // the correct array shape still passes
    expect(violatesSourceRequirement(sbm, { images: ["https://cdn/x.png"] })).toBe(false);
  });

  it("still accepts a bare string in a STRING-convention field (image / video_url / audio)", () => {
    // The singular fields are string-convention (mini-tool + provider read them
    // as a single URL), so a bare string there IS a valid source.
    expect(violatesSourceRequirement(computeSourcesByMode("image", "i2i"), { image: "u" })).toBe(false);
    expect(violatesSourceRequirement(computeSourcesByMode("video", "edit"), { video_url: "u" })).toBe(false);
  });
});
