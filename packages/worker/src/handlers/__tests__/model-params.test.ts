// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * A model run's params checked against its catalog entry, leniently (#1672, #1928, inner#826): an undeclared key is
 * dropped, a value outside the declared ones falls back to the default, a list past its cap is cut to it, defaults
 * are filled, and a text param longer than its cap once cleaned is refused. The cap is read through the one function
 * the panel's picker gate and the server's pre-enqueue gate read, so a submission the server let through is never
 * quietly cut here.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { paramsToSend } from "@breatic/shared";

const h = vi.hoisted(() => ({ getFullModelConfig: vi.fn() }));

vi.mock("@breatic/core", () => ({ logger: { warn: vi.fn(), info: vi.fn() } }));
vi.mock("@breatic/domain", () => ({ getFullModelConfig: h.getFullModelConfig }));

import { validateModelParams } from "@worker/handlers/model-params.js";

const IMAGE = {
  name: "edit",
  params: {
    aspect_ratio: { default: "1:1", values: ["1:1", "16:9"], fill: "panel" },
    resolution: { default: "2k", values: ["1k", "2k"], fill: "panel" },
    caption: { default: null, type: "text", max_length: 5, fill: "panel" },
    voice_description: { default: null, type: "text", min_length: 3, fill: "panel" },
    images: { type: "list", max_items: 13, default: null, fill: "pool", mention: "image {n}" },
    style_images: { type: "list", max_items: 3, default: null, fill: "canvas", joins: "images", prompt_note: "Style references: {list}." },
  },
};

/** A storyboard model: each shot's prompt is text the user typed. */
const STORYBOARD = {
  name: "storyboard",
  params: { shots: { default: null, type: "items", fill: "panel", fields: { prompt: { type: "text" }, duration: { values: [2, 3] } } } },
};

/**
 * File names for a list param.
 * @param n - How many.
 * @param tag - Their prefix.
 * @returns The names.
 */
const files = (n: number, tag: string): string[] => Array.from({ length: n }, (_, i) => `${tag}${i}`);

beforeEach(() => {
  h.getFullModelConfig.mockReturnValue({ models: [IMAGE, STORYBOARD] });
});

describe("validateModelParams", () => {
  it("drops unknown params, keeps valid ones, and fills defaults", () => {
    const [name, cleaned] = validateModelParams("image", "edit", { aspect_ratio: "16:9", bogus_param: 1 });

    expect(name).toBe("edit");
    expect(cleaned).toMatchObject({ aspect_ratio: "16:9", resolution: "2k" });
    expect(cleaned).not.toHaveProperty("bogus_param");
  });

  it("replaces a value outside the declared ones with the default", () => {
    expect(validateModelParams("image", "edit", { aspect_ratio: "5:4" })[1].aspect_ratio).toBe("1:1");
  });

  it("cuts a list past its cap to the cap, and leaves one within it alone", () => {
    expect(validateModelParams("image", "edit", { images: files(15, "r") })[1].images).toEqual(files(13, "r"));
    expect(validateModelParams("image", "edit", { images: ["a", "b"] })[1].images).toEqual(["a", "b"]);
  });

  it("keeps a full pool and a full style slot, and laying the run out sends all sixteen", () => {
    const [, cleaned] = validateModelParams("image", "edit", { images: files(13, "r"), style_images: files(3, "s") });

    const sent = paramsToSend(IMAGE, cleaned, "redraw");
    expect(sent.params.images).toEqual([...files(13, "r"), ...files(3, "s")]);
    expect(sent.prompt).toBe("redraw Style references: {{ref:images:14}}, {{ref:images:15}} and {{ref:images:16}}.");
  });

  it("refuses a text param longer than its cap, naming it", () => {
    expect(() => validateModelParams("image", "edit", { caption: "too long" })).toThrow(/caption is 8 characters once cleaned; edit takes at most 5/);
  });

  it("sends each text setting cleaned, the way the prompt is", () => {
    expect(validateModelParams("image", "edit", { caption: " <b>hi</b>\u200b " })[1].caption).toBe("hi");
  });

  it("cleans each text field of a list's entries and keeps its other fields", () => {
    const [, cleaned] = validateModelParams("image", "storyboard", {
      shots: [{ prompt: "<b>a boat</b>", duration: 2 }, { prompt: "the pond\u200b <!-- x -->", duration: 3 }],
    });

    expect(cleaned.shots).toEqual([{ prompt: "a boat", duration: 2 }, { prompt: "the pond", duration: 3 }]);
  });

  it("refuses a text setting shorter than its least length once cleaned, naming it", () => {
    expect(() => validateModelParams("image", "edit", { voice_description: "<i>ab</i> " })).toThrow(
      /voice_description is 2 characters once cleaned; edit takes at least 3/,
    );
  });

  it("refuses a model the catalog does not have", () => {
    expect(() => validateModelParams("image", "nope", {})).toThrow(/Model 'nope' not found/);
  });
});
