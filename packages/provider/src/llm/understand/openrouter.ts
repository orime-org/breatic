// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Understanding through OpenRouter's chat completions (design 6.5): the question, then each
 * item labelled and sent inline, images included: images as `image_url` and video as
 * `video_url` (data URIs), audio as `input_audio` with OpenRouter's name for its format.
 */

import type { FinishReason, ProviderMetadata } from "ai";
import { z } from "zod";
import { base64Of, exchange, usageOf, wireTypeOf, type UnderstandAdapter, type UnderstandCall } from "@provider/llm/understand/adapter.js";

/** OpenRouter's name for each audio type it takes: shared's AUDIO_FORMATS, with every alias of shared's CANONICAL. */
const AUDIO_FORMATS: Readonly<Record<string, string>> = {
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/x-mpeg": "mp3",
  "audio/x-m4a": "m4a",
  "audio/m4a": "m4a",
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
  if (media.contentType.startsWith("video/")) return { type: "video_url", video_url: { url: `data:${wireTypeOf(media.contentType)};base64,${data}` } };
  if (media.contentType.startsWith("audio/")) {
    const format = Object.hasOwn(AUDIO_FORMATS, media.contentType) ? AUDIO_FORMATS[media.contentType] : undefined;
    if (format === undefined) throw new Error(`OpenRouter takes no audio of type ${media.contentType}`);
    return { type: "input_audio", input_audio: { data, format } };
  }
  return { type: "image_url", image_url: { url: `data:${media.contentType};base64,${data}` } };
}

/** A number leaf of a cost: a value that is not a finite number reads as absent. */
const numberLeaf = z.number().optional().catch(undefined);

/**
 * OpenRouter's chat completion answer, as far as it is read, its leaves typed; other fields
 * are let through. The choices must be readable to answer; the id and usage, which only cost
 * an answer, read a leaf of the wrong type as absent.
 */
const completionSchema = z.looseObject({
  id: z.string().optional().catch(undefined),
  error: z.unknown().optional(),
  choices: z.array(z.looseObject({
    message: z.looseObject({ content: z.string().nullish() }).nullish(),
    finish_reason: z.string().nullish(),
    error: z.unknown().optional(),
  })).optional(),
  usage: z.looseObject({
    prompt_tokens: numberLeaf,
    completion_tokens: numberLeaf,
    cost: numberLeaf,
    prompt_tokens_details: z.looseObject({ cached_tokens: numberLeaf }).optional().catch(undefined),
    completion_tokens_details: z.looseObject({ reasoning_tokens: numberLeaf }).optional().catch(undefined),
  }).optional().catch(undefined),
});

/** The part of the answer a cost reads, whatever its choices hold. */
const costedSchema = completionSchema.pick({ id: true, usage: true });

/** What an OpenRouter answer says about its cost. */
export type CostedAnswer = z.infer<typeof costedSchema>;

/**
 * The id and usage of an OpenRouter answer (a chat completion, or the decisions endpoint's
 * answer, which reports its cost the same way).
 * @param body - The parsed body.
 * @returns Its id and usage, each absent when it cannot be read.
 */
export function costedOf(body: unknown): CostedAnswer {
  const parsed = costedSchema.safeParse(body);
  return parsed.success ? parsed.data : {};
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
    const parsed = completionSchema.safeParse(body);
    if (!parsed.success) return { unreadable: `OpenRouter's answer has an unexpected shape: ${parsed.error.issues[0]?.message ?? "unknown"}` };
    const completion = parsed.data;
    // An error may sit at the top of the body or on the choice; words written before it are a stop.
    if (completion.error !== undefined && completion.error !== null) return { error: completion.error };
    const choice = completion.choices?.[0];
    if (choice === undefined) return { unreadable: "OpenRouter's answer has no choice" };
    const text = choice.message?.content ?? "";
    if (text === "" && choice.error !== undefined && choice.error !== null) return { error: choice.error };
    const reason = choice.finish_reason ?? "";
    return { text, finishReason: Object.hasOwn(FINISH, reason) ? FINISH[reason]! : "other" };
  },

  billing(body) {
    const completion = costedOf(body);
    const usage = completion.usage;
    const providerMetadata: ProviderMetadata = usage?.cost === undefined ? {} : { openrouter: { usage: { cost: usage.cost } } };
    return {
      usage: usageOf(
        usage?.prompt_tokens ?? 0,
        usage?.prompt_tokens_details?.cached_tokens ?? 0,
        usage?.completion_tokens ?? 0,
        usage?.completion_tokens_details?.reasoning_tokens ?? 0,
      ),
      providerMetadata,
      generationId: completion.id,
    };
  },
};
