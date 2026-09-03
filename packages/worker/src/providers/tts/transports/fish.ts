// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Fish Speech official API transport -- synchronous generation.
 *
 * Fish Audio TTS API accepts JSON requests and returns binary audio.
 * Returns raw bytes — storage is handled by the Worker.
 *
 * API reference: https://docs.fish.audio/developer-guide/core-features/text-to-speech
 */

import type { ResolvedModel } from "@worker/providers/shared.js";
import { logger } from "@breatic/core";
import { httpRequest } from "@breatic/shared";

/**
 * Generate speech via Fish Audio official TTS API.
 *
 * Endpoint: POST /v1/tts
 * The API is synchronous -- returns binary audio in the response.
 * Returns raw bytes — storage is handled by the Worker.
 * @param _prompt - Text prompt (embedded in params as `text`)
 * @param resolved - Resolved model with provider connection details
 * @param params - Request payload (text, reference_id, speed, volume)
 * @returns Object with `buffer`, `contentType`, `model`, and `cost`
 * @throws {Error} if the API returns an error or no audio data
 */
export async function generate(
  _prompt: string,
  resolved: ResolvedModel,
  params: Record<string, unknown>,
): Promise<{ buffer: Buffer; contentType: string; model: string; cost: number }> {
  const body: Record<string, unknown> = {
    text: (params.text ?? ""),
    format: "mp3",
  };
  if (params.reference_id) {
    body.reference_id = params.reference_id;
  }
  // Speaking controls belong to a nested `prosody` object; sent at the top
  // level the vendor ignores them, so a user's speed setting silently did
  // nothing.
  const prosody: Record<string, unknown> = {};
  if (params.speed !== undefined) {
    prosody.speed = params.speed;
  }
  if (params.volume !== undefined) {
    prosody.volume = params.volume;
  }
  if (Object.keys(prosody).length > 0) {
    body.prosody = prosody;
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${resolved.apiKey}`,
    "Content-Type": "application/json",
    // The model is a header, not a body field. Its accepted values are
    // s1 / s2-pro / s2.1-pro / s2.1-pro-free; sent in the body it was ignored
    // and every request fell back to the vendor's own default model.
    model: resolved.modelId,
  };

  const resp = await httpRequest(
    `${resolved.baseUrl}/v1/tts`,
    {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    },
    { replaySafe: false, timeoutMs: resolved.timeout * 1000 },
  );

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Fish Audio TTS API HTTP ${resp.status}: ${text}`);
  }

  const audioBuffer = await resp.arrayBuffer();
  const audioBytes = new Uint8Array(audioBuffer);
  if (audioBytes.length === 0) {
    throw new Error("Fish Audio TTS API returned no audio data");
  }

  logger.info(
    { model: resolved.modelId, size: audioBytes.length },
    "fish_tts_generated",
  );

  return { buffer: Buffer.from(audioBytes), contentType: "audio/mpeg", model: resolved.modelName, cost: 0 };
}
