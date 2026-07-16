// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Seedream model family -- ByteDance image generation.
 *
 * Converts aspect_ratio + resolution to pixel-format size param.
 * Uses plain text prompts.
 *
 * Parameter mapping (YAML user-facing vs API):
 * - aspect_ratio + resolution -> size (e.g. "2048*2048")
 * - images (i2i sources) + style_images -> image (the official ModelArk field;
 *   verified 2026-07-16 against docs.byteplus.com/en/docs/ModelArk/1541523 --
 *   the API has no `image_urls` field). Content images come FIRST, style
 *   images LAST, and a style scaffold is appended to the prompt following the
 *   officially documented cross-image pattern ("Apply the style of Image 2 to
 *   Image 1", ModelArk/1829186) so the model treats them as aesthetic
 *   guidance rather than content to copy.
 */

import type { ModelFamily } from "@worker/providers/shared.js";

const RESOLUTION_PX: Readonly<Record<string, number>> = {
  "0.5k": 512,
  "1k": 1024,
  "2k": 2048,
  "4k": 4096,
};

const ALIGN = 64;

/**
 * Convert aspect_ratio + resolution to pixel-format size string.
 * @param aspectRatio - Ratio string like "16:9"
 * @param resolution - Resolution key like "2k"
 * @returns Size string like "2048*1152"
 */
function toSize(aspectRatio: string, resolution: string): string {
  const [wR = 1, hR = 1] = aspectRatio.split(":").map(Number);
  const long = RESOLUTION_PX[resolution] ?? 1024;
  let w: number;
  let h: number;
  if (wR >= hR) {
    w = long;
    h = Math.round((long * hR) / wR);
  } else {
    h = long;
    w = Math.round((long * wR) / hR);
  }
  return `${Math.max(Math.floor(w / ALIGN) * ALIGN, ALIGN)}*${Math.max(Math.floor(h / ALIGN) * ALIGN, ALIGN)}`;
}

/**
 * Style-reference instruction appended to the prompt when style images ride
 * the request. Seedream has no typed "style" slot -- content and style images
 * share the single `image` array, and the officially documented way to assign
 * roles is index-referencing prose in the prompt (ModelArk/1829186).
 * @param contentCount - Number of content (i2i source) images BEFORE the style images
 * @param styleCount - Number of style images appended AFTER the content images
 * @returns The scaffold sentence to append to the prompt
 */
function styleScaffold(contentCount: number, styleCount: number): string {
  if (contentCount === 0) {
    return styleCount === 1
      ? "Use the input image only as a style reference: apply its artistic style (color palette, texture, rendering) to the generated image; do not copy its subjects or composition."
      : "Use the input images only as style references: apply their artistic style (color palette, texture, rendering) to the generated image; do not copy their subjects or composition.";
  }
  const firstStyle = contentCount + 1;
  const styleRef =
    styleCount === 1
      ? `image ${firstStyle}`
      : `images ${firstStyle}-${contentCount + styleCount}`;
  const contentRef = contentCount === 1 ? "image 1" : `images 1-${contentCount}`;
  return `Apply the style of ${styleRef} to the result; ${contentRef} ${contentCount === 1 ? "is" : "are"} the content input${contentCount === 1 ? "" : "s"}.`;
}

/** Set of model names belonging to this family. */
export const MODELS: ReadonlySet<string> = new Set([
  "seedream-5.0-lite",
]);

/**
 * Convert aspect_ratio + resolution to size, merge content + style images into
 * the official `image` field, and append the style scaffold to the prompt.
 * @param prompt - User's image description
 * @param _modelName - Resolved model name (unused; request shaping is the same across Seedream models)
 * @param params - Validated params with aspect_ratio, resolution, and optional images / style_images
 * @returns Tuple of [textPrompt, apiParamsWithSize]
 */
export async function buildRequest(
  prompt: string,
  _modelName: string,
  params: Record<string, unknown>,
): Promise<[string, Record<string, unknown>]> {
  const p = { ...params };
  const ratio = (p.aspect_ratio as string) ?? "1:1";
  const resolution = (p.resolution as string) ?? "2k";
  delete p.aspect_ratio;
  delete p.resolution;
  p.size = toSize(ratio, resolution);

  // Merge i2i sources + style references into the official `image` array
  // (content first, style last) and scaffold the prompt so the style images
  // are treated as aesthetic guidance, not content.
  const contentImages = Array.isArray(p.images) ? (p.images as string[]) : [];
  const styleImages = Array.isArray(p.style_images)
    ? (p.style_images as string[])
    : [];
  delete p.images;
  delete p.style_images;
  let outPrompt = prompt;
  if (contentImages.length + styleImages.length > 0) {
    p.image = [...contentImages, ...styleImages];
    if (styleImages.length > 0) {
      outPrompt = `${prompt}\n${styleScaffold(contentImages.length, styleImages.length)}`;
    }
  }

  return [outPrompt, p];
}

export default { MODELS, buildRequest } satisfies ModelFamily;
