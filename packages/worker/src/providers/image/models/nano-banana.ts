// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Nano Banana model family -- LLM-enhanced JSON structured prompts.
 *
 * Handles all Google Gemini image models (Nano Banana Pro/original and
 * their Edit variants). In the Python source, an LLM (DeepSeek V3 via
 * OpenRouter) converts user input into JSON-structured prompts. In this
 * TypeScript port calls DeepSeek via OpenRouter using Vercel AI SDK
 * `generateText()`, with the original JSON construction as fallback.
 *
 * Parameter mapping (YAML user-facing vs API):
 * - aspect_ratio   -> aspect_ratio (pass-through)
 * - resolution     -> resolution (pass-through, stripped for original models)
 * - style_images   -> images (rename)
 * - camera/lens/focal_length/aperture -> fed into JSON prompt
 * - enable_web_search -> pass-through
 */

import { generateText, stepCountIs } from "ai";
import { getModel } from "@breatic/domain";
import type { ModelFamily } from "@worker/providers/shared.js";

/** Set of model names belonging to this family. */
export const MODELS: ReadonlySet<string> = new Set([
  "nano-banana-pro",
  "nano-banana-2",
  "nano-banana-pro-edit",
  "nano-banana-2-edit",
]);

/** Edit variants -- no camera params, skip LLM enhancement. */
const EDIT_MODELS: ReadonlySet<string> = new Set([
  "nano-banana-pro-edit",
  "nano-banana-2-edit",
]);

/** Models that do not support the resolution param in their API. */
const STRIP_RESOLUTION: ReadonlySet<string> = new Set([
  "nano-banana",
  "nano-banana-edit",
]);

/**
 * Pop non-API params and return cleaned params plus camera controls.
 * @param modelName - Resolved model name (decides whether to strip `resolution`)
 * @param params - Validated params that may carry camera/lens/style fields
 * @returns The cleaned API params alongside the extracted camera controls
 */
function prepareParams(
  modelName: string,
  params: Record<string, unknown>,
): {
  cleaned: Record<string, unknown>;
  camera: string | undefined;
  lens: string | undefined;
  focalLength: number | undefined;
  aperture: string | undefined;
} {
  const cleaned = { ...params };

  if (STRIP_RESOLUTION.has(modelName)) {
    delete cleaned.resolution;
  }

  // Rename style_images -> images
  const styleImages = cleaned.style_images;
  delete cleaned.style_images;
  if (styleImages) {
    cleaned.images = styleImages;
  }

  // Pop camera control params
  const camera = cleaned.camera as string | undefined;
  const lens = cleaned.lens as string | undefined;
  const focalLength = cleaned.focal_length as number | undefined;
  const aperture = cleaned.aperture as string | undefined;
  delete cleaned.camera;
  delete cleaned.lens;
  delete cleaned.focal_length;
  delete cleaned.aperture;

  return { cleaned, camera, lens, focalLength, aperture };
}

/**
 * Build a basic JSON-structured prompt without LLM (fallback path).
 * @param prompt - User's image description, used as the `subject`
 * @param camera - Optional camera body to include under `technical`
 * @param lens - Optional lens to include under `technical`
 * @param focalLength - Optional focal length in mm to include under `technical`
 * @param aperture - Optional aperture to include under `technical`
 * @returns The JSON-stringified structured prompt
 */
function buildJsonPrompt(
  prompt: string,
  camera: string | undefined,
  lens: string | undefined,
  focalLength: number | undefined,
  aperture: string | undefined,
): string {
  const jsonPrompt: Record<string, unknown> = { subject: prompt };

  const technical: Record<string, unknown> = {};
  if (camera) technical.camera = camera;
  if (lens) technical.lens = lens;
  if (focalLength) technical.focal_length = `${focalLength}mm`;
  if (aperture) technical.aperture = aperture;

  if (Object.keys(technical).length > 0) {
    jsonPrompt.technical = technical;
  }

  return JSON.stringify(jsonPrompt);
}

/**
 * Build a JSON-structured prompt with optional LLM enhancement.
 *
 * For t2i models, calls DeepSeek via OpenRouter to convert the user's
 * text prompt and camera params into a rich JSON structured prompt.
 * Falls back to basic JSON construction on LLM failure.
 * @param prompt - User's image description
 * @param modelName - Resolved model name
 * @param params - Validated params (may contain camera controls)
 * @returns Tuple of [jsonPromptString, remainingApiParams]
 */
export async function buildRequest(
  prompt: string,
  modelName: string,
  params: Record<string, unknown>,
): Promise<[string, Record<string, unknown>]> {
  const { cleaned, camera, lens, focalLength, aperture } = prepareParams(modelName, params);

  // Edit models have no camera params and don't benefit from LLM enhancement
  if (EDIT_MODELS.has(modelName)) {
    return [buildJsonPrompt(prompt, camera, lens, focalLength, aperture), cleaned];
  }

  // LLM prompt enhancement: convert user description into structured JSON prompt
  const fallback = buildJsonPrompt(prompt, camera, lens, focalLength, aperture);
  try {
    const cameraContext = [camera, lens, focalLength ? `${focalLength}mm` : undefined, aperture]
      .filter(Boolean)
      .join(", ");
    const userContent = cameraContext
      ? `Convert this image description into a structured prompt JSON with fields: subject, style, technical, lighting, composition. Camera info: ${cameraContext}. Description: "${prompt}"`
      : `Convert this image description into a structured prompt JSON with fields: subject, style, technical, lighting, composition. Description: "${prompt}"`;

    const result = await generateText({
      model: getModel("deepseek/deepseek-chat"),
      messages: [{ role: "user", content: userContent }],
      stopWhen: stepCountIs(1),
      temperature: 0.3,
    });

    // Attempt to parse the LLM response as JSON; fall back on failure
    const text = result.text.trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      JSON.parse(jsonMatch[0]); // validate it's valid JSON
      return [jsonMatch[0], cleaned];
    }
    return [fallback, cleaned];
  } catch {
    return [fallback, cleaned];
  }
}

export default { MODELS, buildRequest } satisfies ModelFamily;
