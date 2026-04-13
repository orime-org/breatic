/**
 * Topaz model family -- AI image upscaling, sharpening, denoising,
 * restoration, and adjustment.
 *
 * Converts minimal user-facing params to Topaz API format.
 * Provider-specific defaults (model, output_format, face_enhancement, etc.)
 * are filled here, keeping YAML params minimal.
 *
 * Parameter mapping -- see Python source docstring for full table per model.
 * Key conversions:
 * - image -> source_url
 * - output_resolution + source_width/height -> output_width or output_height
 * - Various model-specific params -> Topaz API format with hardcoded defaults
 */

import type { ModelFamily } from "../../shared.js";

/** Set of model names belonging to this family. */
export const MODELS: ReadonlySet<string> = new Set([
  "topaz-upscale",
  "topaz-upscale-creative",
  "topaz-sharpen",
  "topaz-denoise",
  "topaz-restore",
  "topaz-adjust",
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

/** Build API params for topaz-upscale-creative (Redefine). */
function buildUpscaleCreative(params: Record<string, unknown>): Record<string, unknown> {
  const outputResolution = params.output_resolution as string | undefined;
  const sourceWidth = params.source_width as number | undefined;
  const sourceHeight = params.source_height as number | undefined;
  delete params.output_resolution;
  delete params.source_width;
  delete params.source_height;

  const outputDims = computeOutputDims(outputResolution, sourceWidth, sourceHeight);

  const creativity = params.creativity ?? 3;
  delete params.creativity;
  const userPrompt = params.prompt as string | undefined;
  delete params.prompt;

  const apiParams: Record<string, unknown> = {
    model: "Redefine",
    output_format: "png",
    face_enhancement: true,
    face_enhancement_strength: 0.8,
    face_enhancement_creativity: 0,
    creativity,
    ...outputDims,
  };

  if (userPrompt) {
    apiParams.prompt = userPrompt;
  }

  return apiParams;
}

/** Build API params for topaz-sharpen. */
function buildSharpen(params: Record<string, unknown>): Record<string, unknown> {
  const model = (params.sharpen_model as string) ?? "Standard";
  const sharpenStrength = params.sharpen_strength ?? 0;
  const denoiseStrength = params.denoise_strength ?? 0;
  delete params.sharpen_model;
  delete params.sharpen_strength;
  delete params.denoise_strength;

  return {
    model,
    output_format: "png",
    sharpen_strength: sharpenStrength,
    denoise_strength: denoiseStrength,
  };
}

/** Build API params for topaz-denoise. */
function buildDenoise(params: Record<string, unknown>): Record<string, unknown> {
  const model = (params.denoise_model as string) ?? "Normal";
  const denoise = params.denoise ?? 0;
  const detail = params.detail ?? 0;
  const faceEnhancement = params.face_enhancement ?? true;
  delete params.denoise_model;
  delete params.denoise;
  delete params.detail;
  delete params.face_enhancement;

  return {
    model,
    output_format: "png",
    denoise,
    detail,
    face_enhancement: faceEnhancement,
    face_enhancement_strength: 0.8,
    face_enhancement_creativity: 0,
  };
}

/** Build API params for topaz-restore. */
function buildRestore(params: Record<string, unknown>): Record<string, unknown> {
  const model = (params.restore_model as string) ?? "Dust-Scratch";
  delete params.restore_model;

  return {
    model,
    output_format: "png",
  };
}

/** Build API params for topaz-adjust (lighting endpoint). */
function buildAdjust(params: Record<string, unknown>): Record<string, unknown> {
  const adjustMode = (params.adjust_mode as string) ?? "Adjust";
  delete params.adjust_mode;

  const apiParams: Record<string, unknown> = {
    model: adjustMode,
    output_format: "png",
  };

  // saturation only applies to Colorize mode
  if (adjustMode === "Colorize") {
    apiParams.saturation = params.saturation ?? 0.2;
  }
  delete params.saturation;

  return apiParams;
}

/** model_name -> builder function. */
const BUILDERS: Readonly<Record<string, (params: Record<string, unknown>) => Record<string, unknown>>> = {
  "topaz-upscale": buildUpscale,
  "topaz-upscale-creative": buildUpscaleCreative,
  "topaz-sharpen": buildSharpen,
  "topaz-denoise": buildDenoise,
  "topaz-restore": buildRestore,
  "topaz-adjust": buildAdjust,
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
