/**
 * IC-Light V2 model family -- AI image relighting.
 *
 * Uses IC-Light V2 (Flux-based) via WaveSpeed API for single-image
 * relighting. Converts user-facing params (brightness, color temperature,
 * light direction, rim light) into natural language prompts that
 * IC-Light V2 understands.
 *
 * Two paths for prompt construction:
 * - Structured params -> code assembles prompt from brightness/temperature/rim_light
 * - Free-text prompt  -> LLM (DeepSeek via OpenRouter) converts to optimal prompt;
 *   falls back to structured param assembly on LLM failure.
 *
 * Parameter mapping (YAML user-facing vs API):
 * - image            -> image (pass-through)
 * - light_source     -> lighting_direction (mapped via DIRECTION_MAP)
 * - brightness       -> assembled into prompt text
 * - light_temperature -> assembled into prompt text
 * - rim_light        -> assembled into prompt text
 * - prompt           -> LLM-enhanced (DeepSeek via OpenRouter, param fallback on failure)
 */

import { generateText, stepCountIs } from "ai";
import { getModel } from "@breatic/core";
import type { ModelFamily } from "../../shared.js";

/** Set of model names belonging to this family. */
export const MODELS: ReadonlySet<string> = new Set([
  "ic-light-v2",
]);

/** Map user-facing light_source to WaveSpeed API lighting_direction. */
const DIRECTION_MAP: Readonly<Record<string, string>> = {
  none: "None",
  left: "Left",
  right: "Right",
  top: "Top",
  bottom: "Bottom",
  front: "None", // IC-Light has no "front", map to None
};

/**
 * Convert color temperature in Kelvin to prompt keywords.
 *
 * @param tempK - Color temperature in Kelvin (2000-10000)
 * @returns Natural language description of the color temperature
 */
function temperatureToKeywords(tempK: number): string {
  if (tempK <= 2500) return "very warm candlelight amber";
  if (tempK <= 3200) return "warm tungsten golden";
  if (tempK <= 4000) return "warm halogen";
  if (tempK <= 5000) return "neutral warm natural";
  if (tempK <= 6000) return "neutral daylight";
  if (tempK <= 7500) return "cool overcast";
  return "cold blue ambient";
}

/**
 * Convert brightness percentage to prompt keywords.
 *
 * @param brightness - Brightness percentage (0-100)
 * @returns Natural language description of the brightness level
 */
function brightnessToKeywords(brightness: number): string {
  if (brightness <= 15) return "very dim dark";
  if (brightness <= 30) return "dim moody low-key";
  if (brightness <= 45) return "soft subtle";
  if (brightness <= 60) return "medium";
  if (brightness <= 80) return "bright well-lit";
  return "very bright high-key strong";
}

/**
 * Build IC-Light prompt from structured parameters.
 *
 * @param params - Validated params containing brightness, light_temperature, rim_light
 * @returns Assembled prompt string for IC-Light V2
 */
function buildFromParams(params: Record<string, unknown>): string {
  const parts: string[] = [];

  // Color temperature
  const tempK = (params.light_temperature as number) ?? 5600;
  if (typeof tempK === "number") {
    parts.push(temperatureToKeywords(tempK));
  }

  // Brightness
  const brightness = (params.brightness as number) ?? 50;
  if (typeof brightness === "number") {
    const kw = brightnessToKeywords(brightness);
    if (kw !== "medium") {
      parts.push(kw);
    }
  }

  parts.push("lighting");

  // Rim light
  if (params.rim_light) {
    parts.push("with rim lighting from behind");
  }

  return parts.join(", ");
}

/**
 * Build IC-Light V2 API request.
 *
 * Two paths:
 * - If user provides prompt param: calls LLM (DeepSeek) to build an
 *   optimal lighting prompt; falls back to structured param assembly.
 * - Otherwise: assembles prompt from structured params (brightness,
 *   light_temperature, rim_light).
 *
 * @param prompt - User's image description (from task prompt field)
 * @param modelName - Resolved model name
 * @param params - Validated params (image, light_source, brightness, light_temperature, rim_light, prompt)
 * @returns Tuple of [lightingPrompt, apiParams]
 */
export async function buildRequest(
  _prompt: string,
  _modelName: string,
  params: Record<string, unknown>,
): Promise<[string, Record<string, unknown>]> {
  const p = { ...params };
  const apiParams: Record<string, unknown> = {};

  // Source image
  const image = p.image;
  delete p.image;
  if (image) {
    apiParams.image = image;
  }

  // Light direction -> API param
  const lightSource = String(p.light_source ?? "none").toLowerCase();
  delete p.light_source;
  apiParams.lighting_direction = DIRECTION_MAP[lightSource] ?? "None";

  // Check for user free-text prompt
  const userPrompt = p.prompt;
  delete p.prompt;

  let lightingPrompt: string;
  if (userPrompt) {
    // LLM enhancement: convert free-text lighting description into optimal IC-Light prompt
    const paramFallback = buildFromParams(p);
    try {
      const result = await generateText({
        model: getModel("deepseek/deepseek-chat"),
        messages: [{
          role: "user",
          content:
            `Convert this lighting description into a concise, natural-language prompt ` +
            `optimized for IC-Light V2 image relighting. Focus on light quality, direction, ` +
            `color temperature, and mood. Return ONLY the prompt text, no JSON or explanation. ` +
            `Description: "${String(userPrompt)}"`,
        }],
        stopWhen: stepCountIs(1),
        temperature: 0.3,
      });

      const text = result.text.trim();
      lightingPrompt = text.length > 0 ? text : paramFallback;
    } catch {
      lightingPrompt = paramFallback;
    }
  } else {
    lightingPrompt = buildFromParams(p);
  }

  return [lightingPrompt, apiParams];
}

export default { MODELS, buildRequest } satisfies ModelFamily;
