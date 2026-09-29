// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Which sources a run still needs, read off the model's own declarations: a
 * slot or pool it does not mark optional, and "one of these" groups it
 * declares per mode. The panel, the server and the agent all ask this.
 */
import { describe, expect, it } from "vitest";
import { fitsSomeMode, holds, missingSources, type SourcedModel } from "@shared/missing-sources";

const I2V_AND_FIRST_LAST: SourcedModel = {
  params: {
    image: { fill: "canvas" },
    end_image: { fill: "canvas", modes: ["first_last"] },
    duration: { fill: "panel" },
  },
};

const REF: SourcedModel = {
  params: {
    images: { fill: "pool", type: "list", optional: true },
    videos: { fill: "pool", type: "list", optional: true },
  },
  source_groups: [{ mode: "ref", any_of: ["images", "videos"] }],
};

const SONG: SourcedModel = {
  params: {
    song: { fill: "canvas", optional: true, modes: ["a2m"] },
    melody: { fill: "canvas", optional: true, modes: ["a2m"] },
  },
  source_groups: [{ mode: "a2m", any_of: ["song", "melody"] }],
};

const ELEMENTS: SourcedModel = {
  params: { elements: { fill: "pool", type: "items" } },
};

describe("missingSources", () => {
  it("names each required slot the run leaves empty", () => {
    expect(missingSources(I2V_AND_FIRST_LAST, "first_last", {})).toEqual([["image"], ["end_image"]]);
  });

  it("asks nothing of a slot that belongs to another mode", () => {
    expect(missingSources(I2V_AND_FIRST_LAST, "i2v", { image: "https://a/i.png" })).toEqual([]);
  });

  it("counts a list only when it holds a usable address", () => {
    expect(missingSources(REF, "ref", { images: [""] })).toEqual([["images", "videos"]]);
    expect(missingSources(REF, "ref", { images: "https://a/i.png" })).toEqual([["images", "videos"]]);
    expect(missingSources(REF, "ref", { videos: ["https://a/v.mp4"] })).toEqual([]);
  });

  it("is satisfied by any one member of a group", () => {
    expect(missingSources(SONG, "a2m", { melody: "https://a/m.mp3" })).toEqual([]);
  });

  it("asks nothing of a group declared for another mode", () => {
    expect(missingSources(SONG, "t2m", {})).toEqual([]);
  });

  it("counts a list editor by its entries", () => {
    expect(missingSources(ELEMENTS, "i2v", { elements: [] })).toEqual([["elements"]]);
    expect(missingSources(ELEMENTS, "i2v", { elements: [{ name: "a" }] })).toEqual([]);
  });

  it("does not take a bare string in a single slot's place when it is empty", () => {
    expect(missingSources(I2V_AND_FIRST_LAST, "i2v", { image: "" })).toEqual([["image"]]);
  });
});

describe("fitsSomeMode", () => {
  it("accepts a submission that makes a valid run of one of the model's modes", () => {
    expect(fitsSomeMode(I2V_AND_FIRST_LAST, ["i2v", "first_last"], { image: "https://a/i.png" })).toBe(
      true,
    );
  });

  it("refuses a submission no mode can run", () => {
    expect(fitsSomeMode(I2V_AND_FIRST_LAST, ["i2v", "first_last"], {})).toBe(false);
  });

  it("accepts anything for a model with a mode that needs no source", () => {
    expect(fitsSomeMode(SONG, ["t2m", "a2m"], {})).toBe(true);
  });
});

// One answer to "is there anything here to send", read by the estimate, the
// worker's request body and this check alike.
describe("holds", () => {
  it("is false for nothing, an empty string and an empty list", () => {
    expect([undefined, null, "", []].map(holds)).toEqual([false, false, false, false]);
  });

  it("is true for any other value, falsy ones included", () => {
    expect([0, false, "a", ["a"], {}].map(holds)).toEqual([true, true, true, true, true]);
  });
});
