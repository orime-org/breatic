// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Cross-modality execute-gate rule (#1675). Pins the (modality, mode) → source
 * type mapping, the wire `sourcesByMode` computation, and the server gate
 * `violatesSourceRequirement` — including the multi-source `talking_head`
 * (image + audio) and the hybrid (t2i+i2i) source-less escape hatch. This is an
 * AIGC-execute input guard (AI-tool-call path) — a wrong verdict either enqueues
 * a doomed task or blocks a valid run — so every branch is pinned.
 */

import { describe, it, expect } from "vitest";
import {
  computeSourcesByMode,
  violatesSourceRequirement,
} from "@domain/model-catalog/source-requirement.js";

/**
 * A stand-in model declaring a carrier for every kind, in both shapes.
 *
 * For the cases that are about the RULE rather than about one model: the gate
 * reads which of a model's params takes which kind, so a case exercising the
 * shape of a submitted value needs a model that takes all of them.
 */
const EVERY_CARRIER = {
  images: { accepts: "image", type: "list" },
  image: { accepts: "image" },
  end_image: { accepts: "image" },
  video: { accepts: "video" },
  video_url: { accepts: "video" },
  audio: { accepts: "audio" },
  audio_url: { accepts: "audio" },
  ref_audio_url: { accepts: "audio" },
} as const;

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

  it("maps animate → BOTH image + video", () => {
    expect(computeSourcesByMode("video", "animate")).toEqual({
      animate: ["image", "video"],
    });
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
    expect(violatesSourceRequirement({}, {}, EVERY_CARRIER)).toBe(false);
  });

  it("passes a hybrid (t2i+i2i) with no source — image-less is a valid t2i run", () => {
    const sbm = computeSourcesByMode("image", ["t2i", "i2i"]);
    expect(violatesSourceRequirement(sbm, {}, EVERY_CARRIER)).toBe(false);
    expect(violatesSourceRequirement(sbm, { images: [] }, EVERY_CARRIER)).toBe(false);
  });

  it("gates a pure i2v (no source-less mode) when no image is present", () => {
    const sbm = computeSourcesByMode("video", "i2v");
    expect(violatesSourceRequirement(sbm, {}, EVERY_CARRIER)).toBe(true);
    expect(violatesSourceRequirement(sbm, { images: [] }, EVERY_CARRIER)).toBe(true);
    expect(violatesSourceRequirement(sbm, { images: ["u"] }, EVERY_CARRIER)).toBe(false);
    // image source may arrive via the `image` field too
    expect(violatesSourceRequirement(sbm, { image: "u" }, EVERY_CARRIER)).toBe(false);
  });

  it("gates a video-edit when no video is present (image does NOT satisfy)", () => {
    const sbm = computeSourcesByMode("video", "edit");
    expect(violatesSourceRequirement(sbm, { images: ["u"] }, EVERY_CARRIER)).toBe(true);
    expect(violatesSourceRequirement(sbm, { video_url: "u" }, EVERY_CARRIER)).toBe(false);
    expect(violatesSourceRequirement(sbm, { video: "u" }, EVERY_CARRIER)).toBe(false);
  });

  it("gates animate until BOTH the character image AND the driving video are present", () => {
    // The upstream serving this mode (wavespeed's wan-2.2/animate) takes a
    // character image AND a driving video, both required — the motion comes
    // from the video, so an image on its own has nothing to animate to.
    const sbm = computeSourcesByMode("video", "animate");
    expect(violatesSourceRequirement(sbm, { image: "u" }, EVERY_CARRIER)).toBe(true); // video missing
    expect(violatesSourceRequirement(sbm, { video: "u" }, EVERY_CARRIER)).toBe(true); // image missing
    expect(violatesSourceRequirement(sbm, { image: "u", video: "u" }, EVERY_CARRIER)).toBe(false);
  });

  it("gates talking_head until BOTH image AND audio are present", () => {
    const sbm = computeSourcesByMode("video", "talking_head");
    expect(violatesSourceRequirement(sbm, { images: ["u"] }, EVERY_CARRIER)).toBe(true); // audio missing
    expect(violatesSourceRequirement(sbm, { audio: "u" }, EVERY_CARRIER)).toBe(true); // image missing
    expect(violatesSourceRequirement(sbm, { images: ["u"], audio: "u" }, EVERY_CARRIER)).toBe(false);
  });

  // Vendors spell the same reference differently, and each satisfies the audio
  // requirement for a model declaring that param as its audio carrier. A model
  // reading its reference as `audio` is not satisfied by a payload carrying
  // `ref_audio_url`, and the case below that one says so.
  it("takes any carrier field the model declares as its audio source", () => {
    const sbm = computeSourcesByMode("tts", "voice_clone");
    for (const field of ["audio", "audio_url", "ref_audio_url"]) {
      expect(
        violatesSourceRequirement(sbm, { [field]: "u" }, { [field]: { accepts: "audio" } }),
        field,
      ).toBe(false);
    }
    expect(violatesSourceRequirement(sbm, {}, EVERY_CARRIER)).toBe(true);
  });

  it("refuses a carrier field the model does not declare", () => {
    // The whole reason the third argument exists: the transport builds its
    // request from the params the model declares, so a field it never named
    // reaches the upstream as nothing.
    const sbm = computeSourcesByMode("tts", "voice_clone");
    expect(
      violatesSourceRequirement(sbm, { ref_audio_url: "u" }, { audio: { accepts: "audio" } }),
    ).toBe(true);
  });

  it("does NOT accept a malformed non-array `images` (a bare string) — the worker reads `images` as an array, so a string is not a usable source", () => {
    // `params` is `z.record(z.unknown())` on the wire — zod does not shape-check
    // it, so a crafted request can send `images: "garbage"`. The worker iterates
    // `images` as an array (google/byteplus transports), so a bare string is a
    // guaranteed-failure input, not a source. The gate must still reject it.
    const sbm = computeSourcesByMode("image", "i2i");
    expect(violatesSourceRequirement(sbm, { images: "https://cdn/x.png" }, EVERY_CARRIER)).toBe(true);
    // an array whose entries are not usable strings is likewise no source
    expect(violatesSourceRequirement(sbm, { images: [123] }, EVERY_CARRIER)).toBe(true);
    expect(violatesSourceRequirement(sbm, { images: [""] }, EVERY_CARRIER)).toBe(true);
    // the correct array shape still passes
    expect(violatesSourceRequirement(sbm, { images: ["https://cdn/x.png"] }, EVERY_CARRIER)).toBe(false);
  });

  it("still accepts a bare string in a STRING-convention field (image / video_url / audio)", () => {
    // The singular fields are string-convention (mini-tool + provider read them
    // as a single URL), so a bare string there IS a valid source.
    expect(violatesSourceRequirement(computeSourcesByMode("image", "i2i"), { image: "u" }, EVERY_CARRIER)).toBe(false);
    expect(violatesSourceRequirement(computeSourcesByMode("video", "edit"), { video_url: "u" }, EVERY_CARRIER)).toBe(false);
  });
});
