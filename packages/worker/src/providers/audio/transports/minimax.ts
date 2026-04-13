/**
 * MiniMax Music official API transport -- synchronous generation.
 *
 * MiniMax Music API returns hex-encoded audio data directly in the response
 * (not a URL). This transport decodes the audio and returns raw bytes.
 *
 * API reference: https://platform.minimax.io/docs/api-reference/music-generation
 */

import type { ResolvedModel } from "../../shared.js";
import { bearerHeaders } from "../../http.js";
import { logger } from "@breatic/core";

/**
 * Generate music via MiniMax official API.
 *
 * The API is synchronous -- the response contains hex-encoded audio data.
 * We decode it and return raw bytes — storage is handled by the Worker.
 *
 * @param _prompt - Audio description prompt (embedded in params)
 * @param resolved - Resolved model with provider connection details
 * @param params - Request payload (prompt, lyrics, is_instrumental)
 * @returns Object with `buffer`, `contentType`, `model`, and `cost`
 * @throws Error if the API returns an error or no audio data
 */
export async function generate(
  _prompt: string,
  resolved: ResolvedModel,
  params: Record<string, unknown>,
): Promise<{ buffer: Buffer; contentType: string; model: string; cost: number }> {
  const headers = bearerHeaders(resolved.apiKey);

  // Build MiniMax request body
  const body: Record<string, unknown> = { model: resolved.modelId };
  if (params.prompt) {
    body.prompt = params.prompt;
  }
  if (params.lyrics) {
    body.lyrics = params.lyrics;
  }
  if (params.is_instrumental) {
    body.is_instrumental = params.is_instrumental;
  }
  body.audio_setting = { format: "mp3", sample_rate: 44100, bitrate: 128000 };

  const resp = await fetch(`${resolved.baseUrl}/v1/music_generation`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(resolved.timeout * 1000),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`MiniMax Music API HTTP ${resp.status}: ${text}`);
  }

  const data = (await resp.json()) as Record<string, unknown>;

  // Check for API errors
  const baseResp = (data.base_resp ?? {}) as Record<string, unknown>;
  const statusCode = (baseResp.status_code ?? 0) as number;
  if (statusCode !== 0) {
    const msg = (baseResp.status_msg ?? "unknown error") as string;
    throw new Error(`MiniMax API error (${statusCode}): ${msg}`);
  }

  // Extract hex-encoded audio
  const audioHex = ((data.data ?? {}) as Record<string, unknown>).audio as string | undefined;
  if (!audioHex) {
    throw new Error("MiniMax API returned no audio data");
  }

  // Decode hex to Uint8Array
  const audioBytes = new Uint8Array(
    audioHex.match(/.{1,2}/g)!.map((byte) => parseInt(byte, 16)),
  );

  const extraInfo = (data.extra_info ?? {}) as Record<string, unknown>;
  logger.info(
    { model: resolved.modelId, duration: extraInfo.music_duration, size: audioBytes.length },
    "minimax_music_generated",
  );

  return { buffer: Buffer.from(audioBytes), contentType: "audio/mpeg", model: resolved.modelName, cost: 0 };
}
