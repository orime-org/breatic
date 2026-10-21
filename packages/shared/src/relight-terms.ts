// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The words the relight tool's settings are sent to the model in, and the
 * colour each light colour is drawn as on its swatch (inner#1304). Keyed by
 * the catalog values of `nano-banana-2-relight`. `auto` and `custom` have no
 * entry: an Auto setting is left out of the prompt, and Custom is the colour
 * picked by hand (see `lightColorOf`).
 *
 * The light sphere names sides as the camera sphere does, from the subject's
 * own side (90 is the subject's right). The model reads a picture, in which a
 * subject facing out has its right on the left, so a direction is written in
 * the picture's terms.
 */

/** A light colour: what the model is told and what the swatch shows. */
export interface LightColorTerm {
  readonly phrase: string;
  /** `#rrggbb`. */
  readonly swatch: string;
}

export const LIGHT_COLORS: Readonly<Record<string, LightColorTerm>> = {
  white: { phrase: "neutral white", swatch: "#f5f5f2" },
  warm: { phrase: "warm", swatch: "#ffcf96" },
  sunset: { phrase: "orange sunset", swatch: "#f07a3a" },
  cool: { phrase: "cool blue", swatch: "#8fc0ff" },
  red: { phrase: "red", swatch: "#e5484d" },
  green: { phrase: "green", swatch: "#46a758" },
  purple: { phrase: "purple", swatch: "#8e4ec6" },
};

/** The colour the light sphere draws an Auto light in: Auto leaves the colour to the model. */
export const AUTO_LIGHT_SWATCH = "#ffd27a";

/** A colour picked by hand: `#` and six hex digits. */
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/**
 * The light colour a relight run asks for: a preset by its catalog value, or
 * for `custom` the colour picked by hand, told to the model as its hex code.
 * @param color - The `light_color` value.
 * @param hex - The `light_color_hex` value.
 * @returns The colour, or undefined for Auto and for Custom without a well-formed colour.
 */
export function lightColorOf(color: unknown, hex: unknown): LightColorTerm | undefined {
  if (color === "custom") {
    return typeof hex === "string" && HEX_COLOR.test(hex) ? { phrase: hex.toUpperCase(), swatch: hex } : undefined;
  }
  return LIGHT_COLORS[String(color)];
}

export const LIGHT_INTENSITIES: Readonly<Record<string, string>> = {
  low: "dim",
  medium: "moderate",
  high: "strong",
};

export const LIGHT_QUALITIES: Readonly<Record<string, string>> = {
  soft: "soft and diffused, with gentle shadows",
  hard: "hard, with crisp, defined shadows",
};

/** Each azimuth on the sphere, as the side of the picture the light comes from. */
const SIDES: Readonly<Record<number, string>> = {
  0: "from the front, beside the camera",
  45: "from the front left of the picture",
  90: "from the left of the picture",
  135: "from behind the subject, on the left of the picture",
  180: "from behind the subject",
  225: "from behind the subject, on the right of the picture",
  270: "from the right of the picture",
  315: "from the front right of the picture",
};

/** Each height below straight overhead. */
const HEIGHTS: Readonly<Record<number, string>> = {
  [-30]: "low, from below",
  0: "at the subject's height",
  30: "slightly above",
  60: "high above",
};

/**
 * Where the light comes from, in words the model reads against the picture.
 * @param azimuth - One of the light grid's azimuths.
 * @param elevation - One of its heights; 90 is straight overhead, whatever the azimuth.
 * @returns The phrase.
 */
export function lightDirectionPhrase(azimuth: number, elevation: number): string {
  if (elevation >= 90) return "from directly above";
  return `${SIDES[azimuth] ?? SIDES[0]}, ${HEIGHTS[elevation] ?? HEIGHTS[0]}`;
}
