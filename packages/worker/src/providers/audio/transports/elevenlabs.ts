// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * ElevenLabs Sound Effects official API transport -- synchronous generation.
 *
 * ElevenLabs SFX API returns binary audio directly in the response.
 * Returns raw bytes — storage is handled by the Worker.
 *
 * API reference: https://elevenlabs.io/docs/api-reference/text-to-sound-effects/convert
 */

import type { ResolvedModel } from "@worker/providers/shared.js";
import { logger } from "@breatic/core";

/**
 * Generate sound effects via ElevenLabs official API.
 *
 * The API is synchronous -- the response body is raw audio bytes.
 * @param _prompt - Audio description prompt (embedded in params as `text`)
 * @param resolved - Resolved model with provider connection details
 * @param params - Request payload (text, duration_seconds, prompt_influence, loop)
 * @returns Object with `buffer`, `contentType`, `model`, and `cost`
 * @throws {Error} if the API returns an error or no audio data
 */
export async function generate(
  _prompt: string,
  resolved: ResolvedModel,
  params: Record<string, unknown>,
): Promise<{ buffer: Buffer; contentType: string; model: string; cost: number }> {
  const headers: Record<string, string> = {
    "xi-api-key": resolved.apiKey,
    "Content-Type": "application/json",
  };

  // Build ElevenLabs request body
  const body: Record<string, unknown> = {
    text: (params.prompt ?? params.text ?? "") as string,
    model_id: resolved.modelId,
  };
  if (params.duration_seconds !== undefined) {
    body.duration_seconds = params.duration_seconds;
  }
  if (params.prompt_influence !== undefined) {
    body.prompt_influence = params.prompt_influence;
  }
  if (params.loop !== undefined) {
    body.loop = params.loop;
  }

  const resp = await fetch(`${resolved.baseUrl}/sound-generation`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(resolved.timeout * 1000),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`ElevenLabs SFX API HTTP ${resp.status}: ${text}`);
  }

  const audioBuffer = await resp.arrayBuffer();
  const audioBytes = new Uint8Array(audioBuffer);
  if (audioBytes.length === 0) {
    throw new Error("ElevenLabs API returned no audio data");
  }

  logger.info(
    { model: resolved.modelId, size: audioBytes.length },
    "elevenlabs_sfx_generated",
  );

  return { buffer: Buffer.from(audioBytes), contentType: "audio/mpeg", model: resolved.modelName, cost: 0 };
}
