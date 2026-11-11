// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Preparing one run for an estimate: the product's own meaning of a run (a required source not picked stands in as
 * one placeholder, a style slot's files travel inside their pool, which lengths are known) laid out in our param
 * names for provider, which prices it per upstream; and its USD in credits, rounded up as the charge will be.
 */
import { describe, expect, it } from "vitest";
import { creditEstimateOf, prepareRunParams, type PreparableModel } from "@shared/pricing";

const PANEL: PreparableModel = {
  takes_prompt: true,
  params: {
    resolution: { default: "720p", fill: "panel" },
    duration: { default: 5, fill: "panel" },
    hd: { default: true, fill: "none" },
  },
};

const EDIT_WITH_STYLE: PreparableModel = {
  takes_prompt: true,
  params: {
    images: { fill: "pool", type: "list", default: null, mention: "image {n}" },
    style_images: {
      fill: "canvas",
      type: "list",
      optional: true,
      default: null,
      joins: "images",
      prompt_note: "Style references: {list}.",
    },
  },
};

const CLIPS: PreparableModel = {
  takes_prompt: false,
  params: {
    video: { fill: "canvas", default: null },
    refs: { fill: "pool", type: "list", default: null, optional: true },
    tool_slot: { fill: "tool", default: null },
  },
};

describe("prepareRunParams", () => {
  it("fills what the user left unset from the declared defaults, a pinned one the panel never shows included", () => {
    expect(prepareRunParams(PANEL, { params: { resolution: "1080p" } }).params).toEqual({ resolution: "1080p", duration: 5, hd: true });
  });

  it("counts a joining style slot's files inside the pool they join, and leaves the slot out", () => {
    const prepared = prepareRunParams(EDIT_WITH_STYLE, { params: { images: ["a"], style_images: ["s1", "s2"] } });
    expect(prepared.params).toEqual({ images: ["a", "s1", "s2"] });
    expect(prepared.placeholders).toEqual([]);
  });

  it("sends the prompt as it will be sent, the style note included", () => {
    expect(prepareRunParams(EDIT_WITH_STYLE, { params: { images: ["a"], style_images: ["s"] }, prompt: "Hi." }).prompt).toBe("Hi. Style references: image 2.");
  });

  it("keeps a prompt not written yet empty", () => {
    expect(prepareRunParams(EDIT_WITH_STYLE, { params: { images: ["a"], style_images: ["s"] } }).prompt).toBe("");
  });

  it("stands a required source not picked in as one placeholder, even when only style files fill its pool", () => {
    const prepared = prepareRunParams(EDIT_WITH_STYLE, { params: { style_images: ["s1", "s2", "s3"] } });
    expect(prepared.placeholders).toEqual(["images"]);
    expect(prepared.params.images).toHaveLength(4);
  });

  it("leaves an optional source empty, and a single source stands in as one value", () => {
    const prepared = prepareRunParams(CLIPS, { params: {} });
    expect(prepared.placeholders).toEqual(["video"]);
    expect(prepared.params).toEqual({ video: "unpicked", refs: [], tool_slot: null });
  });

  it("counts a param the caller fills from media it holds as a source", () => {
    expect(prepareRunParams(CLIPS, { params: { video: "v" }, sources: ["tool_slot"] }).placeholders).toEqual(["tool_slot"]);
  });

  it("carries the lengths of a source whose every clip is known, and names one whose lengths are not", () => {
    const prepared = prepareRunParams(CLIPS, { params: { video: "v", refs: ["a", "b"] }, durations: { video: [10], refs: [3] } });
    expect(prepared.durations).toEqual({ video: [10] });
    expect(prepared.durationsMissing).toEqual(["refs"]);
  });
});

describe("creditEstimateOf", () => {
  it("is the USD in credits, times the multiplier, with the bound it came with", () => {
    expect(creditEstimateOf({ usd: 0.15, bound: "exact" }, 2)).toEqual({ credits: 30, bound: "exact" });
    expect(creditEstimateOf({ usd: 0.15, bound: "at_least" }, 1)).toEqual({ credits: 15, bound: "at_least" });
  });

  it("rounds a part-cent estimate up to two decimals, as the charge will (inner#1666)", () => {
    expect(creditEstimateOf({ usd: 0.15, bound: "exact" }, 1.001)).toEqual({ credits: 15.02, bound: "exact" });
  });

  it("does not round floating-point residue up a cent (inner#1637)", () => {
    expect(creditEstimateOf({ usd: 0.15, bound: "exact" }, 1.08)).toEqual({ credits: 16.2, bound: "exact" });
  });

  it("is no estimate when no upstream can serve the run", () => {
    expect(creditEstimateOf(null, 1)).toBeUndefined();
  });
});
