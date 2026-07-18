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
 * - style_images   -> MERGED into images (content/edit sources FIRST, style
 *   LAST — never a rename-overwrite, which would clobber i2i sources when
 *   both ride one request), with a `style_reference` note injected into the
 *   JSON prompt so Gemini treats the trailing image as aesthetic guidance
 *   (Gemini has no typed style slot in the request — the role is conveyed by
 *   the prompt; style-capable per config: Pro only, Flash has no style class)
 * - camera/lens/focal_length/aperture -> fed into JSON prompt
 * - enable_web_search -> pass-through
 */

import { stepCountIs } from "ai";
import { generateTextRetry } from "@breatic/domain";
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
  contentImageCount: number;
  styleImageCount: number;
} {
  const cleaned = { ...params };

  if (STRIP_RESOLUTION.has(modelName)) {
    delete cleaned.resolution;
  }

  // Merge style_images INTO images (content sources first, style last). The
  // old rename-overwrite (`images = style_images`) silently clobbered i2i
  // sources when both rode one request (#1664 style-in-edit). The counts feed
  // the prompt's style_reference note (index-referenced role assignment).
  const contentImages = Array.isArray(cleaned.images)
    ? (cleaned.images as string[])
    : [];
  const styleImages = Array.isArray(cleaned.style_images)
    ? (cleaned.style_images as string[])
    : [];
  delete cleaned.style_images;
  if (contentImages.length + styleImages.length > 0) {
    cleaned.images = [...contentImages, ...styleImages];
  } else {
    delete cleaned.images;
  }

  // Pop camera control params. The whole cluster is opt-in behind
  // `enable_camera` (default false): when off, the controls resolve to
  // undefined so the `technical` block is omitted from the prompt — even
  // though validateParams still fills the four descriptors' non-null defaults.
  // `enable_camera` is a breatic-internal gate, never forwarded to the provider.
  const enableCamera = cleaned.enable_camera === true;
  delete cleaned.enable_camera;
  const camera = enableCamera ? (cleaned.camera as string | undefined) : undefined;
  const lens = enableCamera ? (cleaned.lens as string | undefined) : undefined;
  const focalLength = enableCamera
    ? (cleaned.focal_length as number | undefined)
    : undefined;
  const aperture = enableCamera
    ? (cleaned.aperture as string | undefined)
    : undefined;
  delete cleaned.camera;
  delete cleaned.lens;
  delete cleaned.focal_length;
  delete cleaned.aperture;

  return {
    cleaned,
    camera,
    lens,
    focalLength,
    aperture,
    contentImageCount: contentImages.length,
    styleImageCount: styleImages.length,
  };
}

/**
 * Inject a `style_reference` note into a JSON-structured prompt so Gemini
 * treats the TRAILING input image(s) as aesthetic guidance rather than
 * content to copy (Gemini's request has no typed style slot — the role is
 * conveyed through the prompt). No-op when no style image rides the request
 * or the prompt string is not parseable JSON (defensive — both builders
 * produce valid JSON).
 * @param jsonPrompt - The JSON-structured prompt string.
 * @param contentImageCount - Number of content images BEFORE the style images.
 * @param styleImageCount - Number of style images appended AFTER the content images.
 * @returns The prompt with the style note, or the original on no style / parse failure.
 */
function injectStyleReference(
  jsonPrompt: string,
  contentImageCount: number,
  styleImageCount: number,
): string {
  if (styleImageCount === 0) return jsonPrompt;
  try {
    const obj = JSON.parse(jsonPrompt) as Record<string, unknown>;
    obj.style_reference =
      contentImageCount === 0
        ? "The input image is a style reference: apply its artistic style (color palette, texture, rendering) to the generated image; do not copy its subjects or composition."
        : `The last input image (image ${contentImageCount + styleImageCount}) is a style reference: apply its artistic style to the result; the preceding image${contentImageCount === 1 ? "" : "s"} ${contentImageCount === 1 ? "is" : "are"} the content to edit.`;
    return JSON.stringify(obj);
  } catch {
    return jsonPrompt;
  }
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
  const {
    cleaned,
    camera,
    lens,
    focalLength,
    aperture,
    contentImageCount,
    styleImageCount,
  } = prepareParams(modelName, params);

  /**
   * Applies the style-reference note to a finished JSON prompt (curried over
   * this request's image counts).
   * @param jsonPrompt - The JSON-structured prompt string.
   * @returns The prompt with the style note when a style image rides along.
   */
  const withStyle = (jsonPrompt: string): string =>
    injectStyleReference(jsonPrompt, contentImageCount, styleImageCount);

  // Edit models have no camera params and don't benefit from LLM enhancement
  if (EDIT_MODELS.has(modelName)) {
    return [withStyle(buildJsonPrompt(prompt, camera, lens, focalLength, aperture)), cleaned];
  }

  // LLM prompt enhancement: convert user description into structured JSON prompt
  const fallback = withStyle(buildJsonPrompt(prompt, camera, lens, focalLength, aperture));
  try {
    const cameraContext = [camera, lens, focalLength ? `${focalLength}mm` : undefined, aperture]
      .filter(Boolean)
      .join(", ");
    const userContent = cameraContext
      ? `Convert this image description into a structured prompt JSON with fields: subject, style, technical, lighting, composition. Camera info: ${cameraContext}. Description: "${prompt}"`
      : `Convert this image description into a structured prompt JSON with fields: subject, style, technical, lighting, composition. Description: "${prompt}"`;

    const result = await generateTextRetry({
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
      return [withStyle(jsonMatch[0]), cleaned];
    }
    return [fallback, cleaned];
  } catch {
    return [fallback, cleaned];
  }
}

export default { MODELS, buildRequest } satisfies ModelFamily;
