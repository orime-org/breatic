/**
 * ElevenLabs TTS official API transport -- synchronous generation.
 *
 * ElevenLabs TTS API returns binary audio directly in the response.
 * Returns raw bytes — storage is handled by the Worker.
 *
 * API reference: https://elevenlabs.io/docs/api-reference/text-to-speech/convert
 */

import type { ResolvedModel } from "../../shared.js";
import { logger } from "@breatic/core";

/**
 * Generate speech via ElevenLabs official TTS API.
 *
 * Endpoint: POST /text-to-speech/{voice_id}
 * The API is synchronous -- the response body is raw audio bytes.
 *
 * @param _prompt - Text prompt (embedded in params as `text`)
 * @param resolved - Resolved model with provider connection details
 * @param params - Request payload (text, voice_id, stability, similarity)
 * @returns Object with `buffer`, `contentType`, `model`, and `cost`
 * @throws Error if the API returns an error or no audio data
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

  const voiceId = (params.voice_id ?? "Alice") as string;

  const body: Record<string, unknown> = {
    text: (params.text ?? "") as string,
    model_id: resolved.modelId,
  };

  // Voice settings
  const voiceSettings: Record<string, unknown> = {};
  if (params.stability !== undefined) {
    voiceSettings.stability = params.stability;
  }
  if (params.similarity !== undefined) {
    voiceSettings.similarity_boost = params.similarity;
  }
  if (Object.keys(voiceSettings).length > 0) {
    body.voice_settings = voiceSettings;
  }

  const resp = await fetch(
    `${resolved.baseUrl}/text-to-speech/${voiceId}`,
    {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(resolved.timeout * 1000),
    },
  );

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`ElevenLabs TTS API HTTP ${resp.status}: ${text}`);
  }

  const audioBuffer = await resp.arrayBuffer();
  const audioBytes = new Uint8Array(audioBuffer);
  if (audioBytes.length === 0) {
    throw new Error("ElevenLabs TTS API returned no audio data");
  }

  logger.info(
    { model: resolved.modelId, voice: voiceId, size: audioBytes.length },
    "elevenlabs_tts_generated",
  );

  return { buffer: Buffer.from(audioBytes), contentType: "audio/mpeg", model: resolved.modelName, cost: 0 };
}
