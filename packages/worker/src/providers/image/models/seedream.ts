/**
 * Seedream model family -- ByteDance image generation.
 *
 * Converts aspect_ratio + resolution to pixel-format size param.
 * Uses plain text prompts.
 *
 * Parameter mapping (YAML user-facing vs API):
 * - aspect_ratio + resolution -> size (e.g. "2048*2048")
 * - style_images -> image_urls (rename)
 * - images (edit variants) -> pass-through
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

/** Set of model names belonging to this family. */
export const MODELS: ReadonlySet<string> = new Set([
  "seedream-5.0-lite",
]);

/**
 * Convert aspect_ratio + resolution to size, keep text prompt.
 * @param prompt - User's image description
 * @param _modelName - Resolved model name (unused; request shaping is the same across Seedream models)
 * @param params - Validated params with aspect_ratio and resolution
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

  // Rename style_images -> image_urls (Seedream API param name)
  const styleImages = p.style_images;
  delete p.style_images;
  if (styleImages) {
    p.image_urls = styleImages;
  }

  return [prompt, p];
}

export default { MODELS, buildRequest } satisfies ModelFamily;
