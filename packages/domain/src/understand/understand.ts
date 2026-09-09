// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Asking a model about one piece of media.
 *
 * Straight at the service's HTTP API. The three media shapes below are the
 * ones it takes, measured one by one against the live endpoint, and none of
 * them survives a trip through a general-purpose SDK: an SDK that normalises
 * parts rejects two of the three outright and rewrites the third's declared
 * type from the bytes' own signature.
 *
 * Who to ask is entirely the caller's: the model, the backend, the credential
 * and the address all arrive as inputs. So this module reads no catalog and no
 * configuration, and every caller — the agent's tool today, a worker task
 * later — decides those where it already knows them.
 */

import { httpRequest } from "@breatic/shared";
import { UnderstandRefused } from "@domain/understand/types.js";
import type { Media, UnderstandAnswer, UnderstandRequest } from "@domain/understand/types.js";

/**
 * The `format` this endpoint wants beside a piece of audio.
 *
 * It is the subtype, with the one rename the registry forces: audio/mpeg is
 * what an MP3 is served as, and `mpeg` is not a format any of these services
 * answers to.
 * @param mediaType - The type the audio was settled as.
 * @returns The format name to send.
 */
function audioFormat(mediaType: string): string {
  const subtype = mediaType.split("/")[1] ?? "";
  return subtype === "mpeg" ? "mp3" : subtype;
}

/**
 * Build the one content part that carries the media.
 *
 * Three shapes, one per kind, each measured against the live endpoint:
 * an image travels as an address the backend fetches, a video as a data uri,
 * and audio as bare base64 with its format named separately. Handing a video a
 * plain url comes back 400 `Cannot fetch content`; handing audio one has the
 * url read as base64 and fail to decode.
 * @param media - The media to send.
 * @returns The content part.
 * @throws {Error} when the media carries neither an address nor bytes.
 */
function mediaPart(media: Media): Record<string, unknown> {
  if (media.kind === "image") {
    if (!media.url) throw new Error("an image part needs a url");
    return { type: "image_url", image_url: { url: media.url } };
  }

  if (!media.bytes) throw new Error(`a ${media.kind} part needs bytes`);
  const base64 = Buffer.from(media.bytes).toString("base64");

  if (media.kind === "video") {
    return { type: "video_url", video_url: { url: `data:${media.mediaType};base64,${base64}` } };
  }
  return {
    type: "input_audio",
    input_audio: { data: base64, format: audioFormat(media.mediaType) },
  };
}

/** What the endpoint answers with, as far as anything here reads it. */
interface Completion {
  choices?: Array<{ message?: { content?: unknown }; finish_reason?: unknown }>;
  usage?: { total_tokens?: unknown };
  error?: { message?: unknown };
}

/**
 * Read the answer, or say why there is none.
 *
 * A 200 carrying an `error` object is a refusal wearing a success code, and
 * this endpoint really does answer that way: measured, the same audio asked to
 * be transcribed word for word comes back 200 with
 * `Gemini blocked the request: SAFETY` in the body. So the status is not what
 * decides — the body is.
 * @param res - The response as it arrived.
 * @returns What the model wrote and why it stopped.
 * @throws {UnderstandRefused} when the body carries no answer.
 */
async function readAnswer(res: Response): Promise<UnderstandAnswer> {
  const text = await res.text();

  let body: Completion;
  try {
    body = JSON.parse(text) as Completion;
  } catch {
    throw new UnderstandRefused(res.status, text.slice(0, 300));
  }

  if (body.error) {
    throw new UnderstandRefused(res.status, String(body.error.message ?? text.slice(0, 300)));
  }
  if (!res.ok) {
    throw new UnderstandRefused(res.status, text.slice(0, 300));
  }

  const choice = body.choices?.[0];
  if (!choice) {
    throw new UnderstandRefused(res.status, text.slice(0, 300));
  }

  return {
    text: typeof choice.message?.content === "string" ? choice.message.content : "",
    finishReason: typeof choice.finish_reason === "string" ? choice.finish_reason : "unknown",
    usage: {
      totalTokens: typeof body.usage?.total_tokens === "number" ? body.usage.total_tokens : 0,
    },
  };
}

/**
 * Ask the model about this media and hand back what it wrote.
 *
 * Reports rather than interprets: an answer that came back is returned with
 * whatever `finishReason` it carried, empty text and all. Deciding what an
 * empty answer or a truncated one should say to anyone is the caller's, one
 * layer up, where the reader is known.
 * @param request - The media, the question, and who to ask.
 * @returns What the model wrote and why it stopped.
 * @throws {UnderstandRefused} when the service would not answer.
 */
export async function understandMedia(request: UnderstandRequest): Promise<UnderstandAnswer> {
  const body: Record<string, unknown> = {
    model: request.model,
    max_tokens: request.maxOutputTokens,
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: request.question }, mediaPart(request.media)],
      },
    ],
  };
  // Stated only when a backend was asked for. Left out, the service routes the
  // call itself, and the two backends behind one model do not behave alike:
  // measured, a 26 MiB body one takes the other refuses with 413.
  if (request.backend) {
    body.provider = { only: [request.backend], allow_fallbacks: false };
  }

  const res = await httpRequest(
    `${request.baseUrl}/chat/completions`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${request.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
    {
      // A replay re-uploads the whole clip. The transport's own retries are
      // for deliveries that produced no effect, and an upload that reached the
      // far side and then lost its answer has produced one worth minutes.
      replaySafe: false,
      timeoutMs: request.timeoutMs,
      ...(request.signal ? { signal: request.signal } : {}),
    },
  );

  return readAnswer(res);
}
