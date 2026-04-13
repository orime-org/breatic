/**
 * Fish Speech official API transport -- synchronous generation.
 *
 * Fish Audio TTS API accepts JSON requests and returns binary audio.
 * Returns raw bytes — storage is handled by the Worker.
 *
 * API reference: https://docs.fish.audio/developer-guide/core-features/text-to-speech
 */

import type { ResolvedModel } from "../../shared.js";
import { logger } from "@breatic/core";

/**
 * Generate speech via Fish Audio official TTS API.
 *
 * Endpoint: POST /v1/tts
 * The API is synchronous -- returns binary audio in the response.
 * Returns raw bytes — storage is handled by the Worker.
 *
 * @param _prompt - Text prompt (embedded in params as `text`)
 * @param resolved - Resolved model with provider connection details
 * @param params - Request payload (text, reference_id, speed)
 * @returns Object with `buffer`, `contentType`, `model`, and `cost`
 * @throws Error if the API returns an error or no audio data
 */
export async function generate(
  _prompt: string,
  resolved: ResolvedModel,
  params: Record<string, unknown>,
): Promise<{ buffer: Buffer; contentType: string; model: string; cost: number }> {
  const body: Record<string, unknown> = {
    text: (params.text ?? "") as string,
    model: resolved.modelId,
    format: "mp3",
  };
  if (params.reference_id) {
    body.reference_id = params.reference_id;
  }
  if (params.speed !== undefined) {
    body.speed = params.speed;
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${resolved.apiKey}`,
    "Content-Type": "application/json",
  };

  const resp = await fetch(`${resolved.baseUrl}/v1/tts`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(resolved.timeout * 1000),
  });

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
