// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The relight tool's settings have no upstream field: the family writes them
 * into a JSON prompt, and a light reference travels as the second image.
 */

import { describe, it, expect } from "vitest";
import { LIGHT_COLORS, LIGHT_QUALITIES, lightDirectionPhrase } from "@breatic/shared";

import relight from "@worker/providers/families/nano-banana-relight.js";

const SOURCE = "https://assets.example.com/i/a.png";
const REFERENCE = "https://assets.example.com/i/ref.png";
const RUN = new AbortController().signal;

const MANUAL = {
  images: [SOURCE],
  light_azimuth: 315,
  light_elevation: 30,
  light_color: "warm",
  light_intensity: "auto",
  light_quality: "soft",
  resolution: "2k",
  aspect_ratio: "2:3",
};

describe("nano-banana-relight family", () => {
  it("covers the relight catalog entry with no paid call of its own", () => {
    expect([...relight.MODELS]).toEqual(["nano-banana-2-relight"]);
    expect(relight.PREPARE_IS_PAID).toBe(false);
  });

  it("keeps the light settings, the reference and the ratio out of the upstream body", () => {
    expect([...relight.CONSUMES].sort()).toEqual([
      "aspect_ratio",
      "light_azimuth",
      "light_color",
      "light_elevation",
      "light_intensity",
      "light_quality",
      "light_reference",
    ]);
  });

  it("writes the manual light into the prompt and leaves Auto fields out", async () => {
    const { prompt, fields } = await relight.prepare("", MANUAL, RUN);
    const json = JSON.parse(prompt) as Record<string, unknown>;
    expect(json.task).toBe("relight");
    expect(json.lighting).toEqual({
      direction: lightDirectionPhrase(315, 30),
      color: LIGHT_COLORS.warm!.phrase,
      quality: LIGHT_QUALITIES.soft!,
    });
    expect(json).not.toHaveProperty("reference");
    expect(json).not.toHaveProperty("note");
    expect(json.preserve).toEqual(expect.arrayContaining(["subject", "background", "composition"]));
    // One image keeps the source's ratio by itself.
    expect(fields).toEqual({});
  });

  it("takes the direction from a reference, sent second, at the source's ratio", async () => {
    const { prompt, fields } = await relight.prepare("", { ...MANUAL, light_reference: REFERENCE }, RUN);
    const json = JSON.parse(prompt) as { lighting: Record<string, string>; reference?: string };
    expect(json.lighting).not.toHaveProperty("direction");
    expect(json.lighting.color).toBe(LIGHT_COLORS.warm!.phrase);
    expect(json.reference).toMatch(/second image/);
    expect(fields).toEqual({ images: [SOURCE, REFERENCE], aspect_ratio: "2:3" });
  });

  it("sends no ratio with a reference when the source's size was not known", async () => {
    const { fields } = await relight.prepare("", { ...MANUAL, light_reference: REFERENCE, aspect_ratio: "auto" }, RUN);
    expect(fields).toEqual({ images: [SOURCE, REFERENCE] });
  });

  it("leaves the lighting block out when a reference decides everything", async () => {
    const auto = { ...MANUAL, light_color: "auto", light_quality: "auto", light_reference: REFERENCE };
    const json = JSON.parse((await relight.prepare("", auto, RUN)).prompt) as Record<string, unknown>;
    expect(json).not.toHaveProperty("lighting");
  });

  it("adds what the reader wrote as a note", async () => {
    const json = JSON.parse((await relight.prepare("  rim light on the hair ", MANUAL, RUN)).prompt) as { note?: string };
    expect(json.note).toBe("rim light on the hair");
  });

  it("says straight overhead once, whatever the azimuth", async () => {
    const json = JSON.parse((await relight.prepare("", { ...MANUAL, light_elevation: 90 }, RUN)).prompt) as {
      lighting: { direction: string };
    };
    expect(json.lighting.direction).toBe("from directly above");
  });
});
