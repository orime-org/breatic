// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Nano Banana 2's camera controls. The endpoint has no camera fields, so the
 * camera, lens, focal length and aperture travel in the prompt: the prompt
 * becomes a structured JSON description whose `technical` block carries them.
 * The whole cluster is opt-in behind `enable_camera` — off, the four
 * descriptors are left out even though validation fills their defaults.
 *
 * An LLM first rewrites the description into that JSON shape; when it fails
 * or answers something that is not JSON, the plain shape is sent.
 */

import { stepCountIs } from "ai";
import { logger } from "@breatic/core";
import { generateTextRetry, getModel } from "@breatic/domain";

import type { ModelFamily } from "@worker/providers/shared.js";

/** The camera controls a run carries, when the camera is on. */
interface Camera {
  camera?: string;
  lens?: string;
  focalLength?: number;
  aperture?: string;
}

/**
 * Read the camera controls, or nothing when the camera is off.
 * @param params - The validated run params.
 * @returns The controls to describe.
 */
function cameraOf(params: Readonly<Record<string, unknown>>): Camera {
  if (params.enable_camera !== true) return {};
  return {
    camera: typeof params.camera === "string" ? params.camera : undefined,
    lens: typeof params.lens === "string" ? params.lens : undefined,
    focalLength: typeof params.focal_length === "number" ? params.focal_length : undefined,
    aperture: typeof params.aperture === "string" ? params.aperture : undefined,
  };
}

/**
 * The plain structured prompt: the subject, plus a `technical` block when
 * any camera control is set.
 * @param prompt - The reader's description.
 * @param camera - The camera controls.
 * @returns The JSON prompt.
 */
function plainPrompt(prompt: string, camera: Camera): string {
  const technical: Record<string, string> = {};
  if (camera.camera) technical.camera = camera.camera;
  if (camera.lens) technical.lens = camera.lens;
  if (camera.focalLength) technical.focal_length = `${camera.focalLength}mm`;
  if (camera.aperture) technical.aperture = camera.aperture;
  return JSON.stringify(Object.keys(technical).length > 0 ? { subject: prompt, technical } : { subject: prompt });
}

/**
 * Ask the LLM to rewrite the description into the structured shape.
 * @param prompt - The reader's description.
 * @param camera - The camera controls.
 * @returns The JSON prompt the LLM answered, or undefined when it answered none.
 * @throws {Error} when the LLM call fails.
 */
async function rewrittenPrompt(prompt: string, camera: Camera): Promise<string | undefined> {
  const cameraContext = [camera.camera, camera.lens, camera.focalLength ? `${camera.focalLength}mm` : undefined, camera.aperture]
    .filter(Boolean)
    .join(", ");
  const ask = "Convert this image description into a structured prompt JSON with fields: subject, style, technical, lighting, composition.";
  const result = await generateTextRetry({
    model: getModel("deepseek/deepseek-chat"),
    messages: [
      {
        role: "user",
        content: cameraContext
          ? `${ask} Camera info: ${cameraContext}. Description: "${prompt}"`
          : `${ask} Description: "${prompt}"`,
      },
    ],
    stopWhen: stepCountIs(1),
    temperature: 0.3,
  });
  const json = result.text.trim().match(/\{[\s\S]*\}/)?.[0];
  if (json === undefined) return undefined;
  JSON.parse(json);
  return json;
}

const nanoBanana: ModelFamily = {
  MODELS: new Set(["nano-banana-2"]),
  CONSUMES: new Set(["enable_camera", "camera", "lens", "focal_length", "aperture"]),
  /**
   * Write the camera into the prompt.
   * @param prompt - The reader's description.
   * @param params - The validated run params.
   * @returns The structured prompt; no extra upstream fields.
   */
  prepare: async (
    prompt: string,
    params: Readonly<Record<string, unknown>>,
  ): Promise<{ prompt: string; fields: Record<string, unknown> }> => {
    const camera = cameraOf(params);
    try {
      return { prompt: (await rewrittenPrompt(prompt, camera)) ?? plainPrompt(prompt, camera), fields: {} };
    } catch (err) {
      // The rewrite is an enhancement: without it the plain shape still
      // carries the description and the camera.
      logger.warn({ err }, "nano_banana_prompt_rewrite_failed");
      return { prompt: plainPrompt(prompt, camera), fields: {} };
    }
  },
};

export default nanoBanana;
