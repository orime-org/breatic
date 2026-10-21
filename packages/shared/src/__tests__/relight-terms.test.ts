// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect } from "vitest";

import { LIGHT_ANGLE_GRID } from "@shared/camera-angle.js";
import {
  LIGHT_COLORS,
  lightColorOf,
  LIGHT_INTENSITIES,
  LIGHT_QUALITIES,
  lightDirectionPhrase,
} from "@shared/relight-terms.js";

describe("lightDirectionPhrase", () => {
  const below90 = LIGHT_ANGLE_GRID.elevation.filter((e) => e !== 90);

  it("gives every azimuth and height below overhead its own phrase", () => {
    const phrases = LIGHT_ANGLE_GRID.azimuth.flatMap((a) => below90.map((e) => lightDirectionPhrase(a, e)));
    expect(phrases).toHaveLength(32);
    expect(new Set(phrases).size).toBe(32);
  });

  it("says straight overhead the same way whatever the azimuth", () => {
    const overhead = new Set(LIGHT_ANGLE_GRID.azimuth.map((a) => lightDirectionPhrase(a, 90)));
    expect([...overhead]).toEqual(["from directly above"]);
  });

  // The sphere names sides as the subject's own, as the camera sphere does;
  // the model reads the picture, where the subject's right is the left.
  it("names the side as it falls in the picture", () => {
    expect(lightDirectionPhrase(90, 0)).toMatch(/left of the picture/);
    expect(lightDirectionPhrase(270, 0)).toMatch(/right of the picture/);
    expect(lightDirectionPhrase(315, 30)).toMatch(/front right of the picture/);
  });
});

describe("light terms", () => {
  it("gives every preset colour (all but Auto and Custom) a phrase and a swatch", () => {
    expect(Object.keys(LIGHT_COLORS)).toEqual(["white", "warm", "sunset", "cool", "red", "green", "purple"]);
    for (const [value, term] of Object.entries(LIGHT_COLORS)) {
      expect(term.phrase, value).not.toBe("");
      expect(term.swatch, value).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("gives every intensity and quality but Auto a phrase", () => {
    expect(Object.keys(LIGHT_INTENSITIES)).toEqual(["low", "medium", "high"]);
    expect(Object.keys(LIGHT_QUALITIES)).toEqual(["soft", "hard"]);
  });
});

describe("lightColorOf", () => {
  it("reads a preset by its name, and Auto as no colour", () => {
    expect(lightColorOf("cool", undefined)).toEqual(LIGHT_COLORS.cool);
    expect(lightColorOf("auto", "#123456")).toBeUndefined();
  });

  it("reads Custom as the colour picked, written as the reader sees it", () => {
    expect(lightColorOf("custom", "#8fc0ff")).toEqual({ phrase: "#8FC0FF", swatch: "#8fc0ff" });
  });

  it("reads Custom without a well-formed colour as no colour", () => {
    for (const hex of [undefined, "", "8fc0ff", "#8fc0f", "#8fc0ffff", "#zzzzzz", 0x8fc0ff, "red"]) {
      expect(lightColorOf("custom", hex), String(hex)).toBeUndefined();
    }
  });
});
