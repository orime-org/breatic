// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Understanding through OpenRouter's chat completions (design 6.5), the request written as
 * domain's understand wrote it: the question, then each item labelled and inline, images as
 * `image_url`, video as `video_url` (data URIs) and audio as `input_audio` with OpenRouter's
 * name for its format.
 */

import type { FinishReason, ProviderMetadata } from "ai";
import { base64Of, count, exchange, usageOf, type UnderstandAdapter, type UnderstandCall } from "@provider/llm/understand/adapter.js";

/** OpenRouter's name for each audio type it takes; the values of shared's AUDIO_FORMATS. */
const AUDIO_FORMATS: Readonly<Record<string, string>> = {
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/vnd.wave": "wav",
  "audio/mp4": "m4a",
  "audio/webm": "webm",
};

/** OpenRouter's finish reasons in the AI SDK's words. */
const FINISH: Readonly<Record<string, FinishReason>> = {
  stop: "stop",
  length: "length",
  content_filter: "content-filter",
  tool_calls: "tool-calls",
  error: "error",
};

/**
 * One item as a content part.
 * @param media - The item.
 * @returns The part.
 * @throws {Error} For an audio type OpenRouter has no format name for.
 */
function partOf(media: UnderstandCall["media"][number]): Record<string, unknown> {
  const data = base64Of(media.bytes);
  if (media.contentType.startsWith("video/")) return { type: "video_url", video_url: { url: `data:${media.contentType};base64,${data}` } };
  if (media.contentType.startsWith("audio/")) {
    const format = AUDIO_FORMATS[media.contentType];
    if (format === undefined) throw new Error(`OpenRouter takes no audio of type ${media.contentType}`);
    return { type: "input_audio", input_audio: { data, format } };
  }
  return { type: "image_url", image_url: { url: `data:${media.contentType};base64,${data}` } };
}

/** The answer's body, as far as it is read. */
interface Completion {
  id?: unknown;
  error?: unknown;
  usage?: {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    cost?: unknown;
    prompt_tokens_details?: { cached_tokens?: unknown };
    completion_tokens_details?: { reasoning_tokens?: unknown };
  };
  choices?: { message?: { content?: unknown }; finish_reason?: unknown; error?: unknown }[];
}

export const openRouterUnderstand: UnderstandAdapter = {
  async ask(call) {
    const content = [
      { type: "text", text: call.question },
      ...call.media.flatMap((media, index) => [{ type: "text", text: `Item ${index + 1}` }, partOf(media)]),
    ];
    const body = {
      model: call.modelId,
      max_tokens: call.maxOutputTokens,
      messages: [{ role: "user", content }],
      ...(call.backend === undefined ? {} : { provider: call.backend }),
    };
    return exchange(
      {
        url: `${call.decl.base_url}/chat/completions`,
        method: "POST",
        headers: { authorization: `Bearer ${call.key}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      call,
    );
  },

  read(body) {
    const completion = (body ?? {}) as Completion;
    // An error may sit at the top of the body or on the choice; words written before it are a stop.
    if (completion.error !== undefined && completion.error !== null) return { error: completion.error };
    const choice = completion.choices?.[0];
    const text = typeof choice?.message?.content === "string" ? choice.message.content : "";
    if (text === "" && choice?.error !== undefined && choice.error !== null) return { error: choice.error };
    const reason = typeof choice?.finish_reason === "string" ? choice.finish_reason : "";
    return { text, finishReason: FINISH[reason] ?? "other" };
  },

  billing(body) {
    const completion = (body ?? {}) as Completion;
    const usage = completion.usage;
    const providerMetadata: ProviderMetadata = typeof usage?.cost === "number" ? { openrouter: { usage: { cost: usage.cost } } } : {};
    return {
      usage: usageOf(
        count(usage?.prompt_tokens),
        count(usage?.prompt_tokens_details?.cached_tokens),
        count(usage?.completion_tokens),
        count(usage?.completion_tokens_details?.reasoning_tokens),
      ),
      providerMetadata,
      generationId: completion.id,
    };
  },
};
