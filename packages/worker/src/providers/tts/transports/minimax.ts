// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * MiniMax Speech official API transport -- synchronous generation.
 *
 * MiniMax TTS API returns hex-encoded audio data directly in the response
 * (same as their Music API). Returns raw bytes — storage is handled by the Worker.
 *
 * API reference: https://platform.minimax.io/docs/api-reference/speech-t2a-http
 */

import type { ResolvedModel } from "@worker/providers/shared.js";
import { bearerHeaders } from "@worker/providers/http.js";
import { logger } from "@breatic/core";

/**
 * Generate speech via MiniMax official TTS API.
 *
 * Endpoint: POST /v1/t2a_v2
 * The API is synchronous -- returns hex-encoded audio in the response.
 * Decodes and returns raw bytes — storage is handled by the Worker.
 * @param _prompt - Text prompt (embedded in params as `text`)
 * @param resolved - Resolved model with provider connection details
 * @param params - Request payload (text, voice_id, speed, emotion)
 * @returns Object with `buffer`, `contentType`, `model`, and `cost`
 * @throws {Error} if the API returns an error or no audio data
 */
export async function generate(
  _prompt: string,
  resolved: ResolvedModel,
  params: Record<string, unknown>,
): Promise<{ buffer: Buffer; contentType: string; model: string; cost: number }> {
  const headers = bearerHeaders(resolved.apiKey);

  const voiceSetting: Record<string, unknown> = {
    voice_id: (params.voice_id ?? "Friendly_Person") as string,
  };

  // Optional voice settings
  if (params.speed !== undefined) {
    voiceSetting.speed = params.speed;
  }
  if (params.emotion !== undefined) {
    voiceSetting.emotion = params.emotion;
  }

  const body: Record<string, unknown> = {
    model: resolved.modelId,
    text: (params.text ?? "") as string,
    voice_setting: voiceSetting,
    audio_setting: {
      format: "mp3",
      sample_rate: 32000,
      bitrate: 128000,
    },
  };

  const resp = await fetch(`${resolved.baseUrl}/v1/t2a_v2`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(resolved.timeout * 1000),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`MiniMax TTS API HTTP ${resp.status}: ${text}`);
  }

  const data = (await resp.json()) as Record<string, unknown>;

  // Check for API errors
  const baseResp = (data.base_resp ?? {}) as Record<string, unknown>;
  const statusCode = (baseResp.status_code ?? 0) as number;
  if (statusCode !== 0) {
    const msg = (baseResp.status_msg ?? "unknown error") as string;
    throw new Error(`MiniMax TTS API error (${statusCode}): ${msg}`);
  }

  // Extract and decode hex-encoded audio
  const audioHex = ((data.data ?? {}) as Record<string, unknown>).audio as string | undefined;
  if (!audioHex) {
    throw new Error("MiniMax TTS API returned no audio data");
  }

  const audioBytes = new Uint8Array(
    audioHex.match(/.{1,2}/g)!.map((byte) => parseInt(byte, 16)),
  );

  const extraInfo = (data.extra_info ?? {}) as Record<string, unknown>;
  logger.info(
    {
      model: resolved.modelId,
      voice: params.voice_id,
      duration: extraInfo.audio_duration,
      size: audioBytes.length,
    },
    "minimax_tts_generated",
  );

  return { buffer: Buffer.from(audioBytes), contentType: "audio/mpeg", model: resolved.modelName, cost: 0 };
}
