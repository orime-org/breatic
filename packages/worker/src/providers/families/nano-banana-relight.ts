// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The relight tool's model (inner#1304). Nano Banana 2's edit endpoint has no
 * lighting fields, so the settings travel as a JSON prompt; a light reference
 * goes as the second image. With two images the endpoint takes the second
 * one's shape unless told a ratio, so the source's ratio, which the server
 * wrote, goes with the reference; one image keeps the source's shape by itself.
 */

import { LIGHT_COLORS, LIGHT_INTENSITIES, LIGHT_QUALITIES, lightDirectionPhrase } from "@breatic/shared";

import type { ModelFamily } from "@worker/providers/shared.js";

/** Said of the reference, named by its place in the images, as Google's examples do. */
const REFERENCE =
  "Take the lighting of the second image: its direction, contrast, colour and shadow quality. Take nothing else from it.";

/** What the result keeps of the source. */
const PRESERVE = ["subject", "face", "pose", "clothing", "background", "composition"];

/**
 * The lighting block: each setting not left on Auto, the direction only when
 * no reference decides it.
 * @param params - The validated run params.
 * @param referenced - Whether a light reference is sent.
 * @returns The block, empty when every setting is decided elsewhere.
 */
function lightingOf(params: Readonly<Record<string, unknown>>, referenced: boolean): Record<string, string> {
  const lighting: Record<string, string> = {};
  if (!referenced) {
    lighting.direction = lightDirectionPhrase(Number(params.light_azimuth), Number(params.light_elevation));
  }
  const color = LIGHT_COLORS[String(params.light_color)];
  if (color !== undefined) lighting.color = color.phrase;
  const intensity = LIGHT_INTENSITIES[String(params.light_intensity)];
  if (intensity !== undefined) lighting.intensity = intensity;
  const quality = LIGHT_QUALITIES[String(params.light_quality)];
  if (quality !== undefined) lighting.quality = quality;
  return lighting;
}

const nanoBananaRelight: ModelFamily = {
  MODELS: new Set(["nano-banana-2-relight"]),
  CONSUMES: new Set([
    "light_azimuth",
    "light_elevation",
    "light_color",
    "light_intensity",
    "light_quality",
    "light_reference",
    "aspect_ratio",
  ]),
  PREPARE_IS_PAID: false,
  /**
   * Write the light settings into the prompt, and send a reference second.
   * @param prompt - What the reader added, possibly empty.
   * @param params - The validated run params.
   * @returns The JSON prompt, and the images and ratio when a reference goes.
   */
  prepare: async (
    prompt: string,
    params: Readonly<Record<string, unknown>>,
  ): Promise<{ prompt: string; fields: Record<string, unknown> }> => {
    const reference = typeof params.light_reference === "string" ? params.light_reference : undefined;
    const lighting = lightingOf(params, reference !== undefined);
    const note = prompt.trim();
    const json = {
      task: "relight",
      ...(Object.keys(lighting).length > 0 && { lighting }),
      ...(reference !== undefined && { reference: REFERENCE }),
      ...(note !== "" && { note }),
      preserve: PRESERVE,
    };
    const fields: Record<string, unknown> = {};
    if (reference !== undefined) {
      const source = Array.isArray(params.images) ? params.images : [];
      fields.images = [...source, reference];
      const ratio = params.aspect_ratio;
      if (typeof ratio === "string" && ratio !== "auto") fields.aspect_ratio = ratio;
    }
    return { prompt: JSON.stringify(json), fields };
  },
};

export default nanoBananaRelight;
