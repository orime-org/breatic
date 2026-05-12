/**
 * Topaz model family -- AI image upscaling.
 *
 * B5 trimmed sharpen / denoise / restore / adjust / upscale-creative —
 * per `design/project/02-mini-tool-system.md` §2.2 V1 only ships upscale.
 * The trimmed builders + model entries are gone; if a future PR re-enables
 * any of them, git history (B5 commit) has the full prior implementation.
 *
 * Converts minimal user-facing params to Topaz API format.
 * Provider-specific defaults (model, output_format, face_enhancement, etc.)
 * are filled here, keeping YAML params minimal.
 */

import type { ModelFamily } from "../../shared.js";

/** Set of model names belonging to this family. */
export const MODELS: ReadonlySet<string> = new Set([
  "topaz-upscale",
]);

/** output_resolution -> long-edge pixels. */
const RESOLUTION_MAP: Readonly<Record<string, number>> = {
  "2k": 2048,
  "4k": 4096,
  "8k": 8192,
};

/**
 * Compute output_width or output_height for Topaz API.
 *
 * When both source dimensions and target resolution are provided, aligns
 * the long edge to the target pixels and lets Topaz scale the short edge
 * proportionally. When source dimensions are missing, falls back to
 * setting output_width only.
 *
 * @param outputResolution - Target resolution key ("2k", "4k", "8k"), or undefined
 * @param sourceWidth - Original image width in pixels, or undefined
 * @param sourceHeight - Original image height in pixels, or undefined
 * @returns Dict with output_width and/or output_height, or empty
 */
function computeOutputDims(
  outputResolution: string | undefined,
  sourceWidth: number | undefined,
  sourceHeight: number | undefined,
): Record<string, number> {
  if (!outputResolution) return {};

  const targetPx = RESOLUTION_MAP[outputResolution];
  if (!targetPx) return {};

  if (sourceWidth && sourceHeight) {
    if (sourceHeight > sourceWidth) {
      // Portrait: long edge is height
      return { output_height: targetPx };
    }
    // Landscape or square: long edge is width
    return { output_width: targetPx };
  }

  // No source dims -- default to setting width
  return { output_width: targetPx };
}

/** Build API params for topaz-upscale (Standard V2). */
function buildUpscale(params: Record<string, unknown>): Record<string, unknown> {
  const outputResolution = params.output_resolution as string | undefined;
  const sourceWidth = params.source_width as number | undefined;
  const sourceHeight = params.source_height as number | undefined;
  delete params.output_resolution;
  delete params.source_width;
  delete params.source_height;

  const outputDims = computeOutputDims(outputResolution, sourceWidth, sourceHeight);

  return {
    model: "Standard V2",
    output_format: "png",
    face_enhancement: true,
    face_enhancement_strength: 0.8,
    face_enhancement_creativity: 0,
    sharpen: 0,
    denoise: 0,
    fix_compression: 0,
    ...outputDims,
  };
}

/** model_name -> builder function. */
const BUILDERS: Readonly<Record<string, (params: Record<string, unknown>) => Record<string, unknown>>> = {
  "topaz-upscale": buildUpscale,
};

/**
 * Build Topaz API request with provider-specific defaults.
 *
 * @param prompt - User's image description (used as guidance for creative model)
 * @param modelName - Resolved model name
 * @param params - Validated params from YAML
 * @returns Tuple of [prompt, apiParams]
 */
export async function buildRequest(
  _prompt: string,
  modelName: string,
  params: Record<string, unknown>,
): Promise<[string, Record<string, unknown>]> {
  const p = { ...params };

  const builder = BUILDERS[modelName];
  if (!builder) {
    throw new Error(`Unknown Topaz model: ${modelName}`);
  }

  const apiParams = builder(p);

  // Source image
  const image = p.image;
  delete p.image;
  if (image) {
    apiParams.source_url = image;
  }

  return ["", apiParams];
}

export default { MODELS, buildRequest } satisfies ModelFamily;
