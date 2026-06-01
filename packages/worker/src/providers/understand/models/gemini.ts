/**
 * Gemini vision model family -- full multimodal understanding.
 *
 * Builds LLM messages with image_url/video/audio content parts for Gemini
 * models. Supports all three modes: vi (image), vv (video), va (audio).
 *
 * Message format follows OpenAI multimodal spec -- LiteLLM converts to
 * Gemini's native format automatically.
 */

import type { UnderstandModelFamily } from "@worker/providers/understand/models/types.js";

/** Set of model names belonging to this family. */
export const MODELS: ReadonlySet<string> = new Set([
  "gemini-flash-vi",
  "gemini-flash-vv",
  "gemini-flash-va",
  "gemini-pro-vi",
  "gemini-pro-vv",
  "gemini-pro-va",
]);

/** Content part in an LLM message. */
interface ContentPart {
  type: string;
  image_url?: { url: string };
  input_audio?: { data: string; format: string };
  text?: string;
}

/**
 * Build LLM messages with multimodal content for Gemini.
 * @param prompt - Analysis instruction text
 * @param _modelName - Resolved model name (unused)
 * @param params - Validated params (images, video_url, audio_url, max_tokens)
 * @returns Tuple of [messages, maxTokens]
 */
export async function buildMessages(
  prompt: string,
  _modelName: string,
  params: Record<string, unknown>,
): Promise<[Array<{ role: string; content: ContentPart[] }>, number]> {
  const maxTokens = (params.max_tokens as number | undefined) ?? 2048;
  delete params.max_tokens;

  const contentParts: ContentPart[] = [];

  // Image mode: multiple image URLs
  const images = params.images as string[] | undefined;
  if (images) {
    for (const url of images) {
      if (url) {
        contentParts.push({
          type: "image_url",
          image_url: { url },
        });
      }
    }
  }

  // Video mode: single video URL
  const videoUrl = params.video_url as string | undefined;
  if (videoUrl) {
    contentParts.push({
      type: "image_url",
      image_url: { url: videoUrl },
    });
  }

  // Audio mode: single audio URL
  const audioUrl = params.audio_url as string | undefined;
  if (audioUrl) {
    contentParts.push({
      type: "input_audio",
      input_audio: { data: audioUrl, format: "mp3" },
    });
  }

  // Add text prompt
  contentParts.push({ type: "text", text: prompt });

  const messages = [{ role: "user", content: contentParts }];
  return [messages, maxTokens];
}

export default { MODELS, buildMessages } satisfies UnderstandModelFamily;
