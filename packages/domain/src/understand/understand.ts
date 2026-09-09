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

import { httpRequest, readWithin } from "@breatic/shared";
import { UnderstandRefused } from "@domain/understand/types.js";
import type { Media, UnderstandAnswer, UnderstandRequest } from "@domain/understand/types.js";

/**
 * The formats this endpoint takes, and every type that means one of them.
 *
 * Stated as a table rather than cut off the media type, because the two are
 * not the same thing: a wav is served as `audio/wav`, `audio/x-wav`,
 * `audio/wave` or `audio/vnd.wave` depending on the server, and the format
 * beside the bytes has to be `wav` in all four cases. A subtype passed through
 * reaches the service as `x-wav`, and the whole clip is uploaded before it
 * says no.
 */
const AUDIO_FORMATS: Readonly<Record<string, string>> = {
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/vnd.wave": "wav",
};

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
 * @throws {UnderstandRefused} when the audio is a format this endpoint refuses.
 */
function mediaPart(media: Media): Record<string, unknown> {
  if (media.kind === "image") {
    return { type: "image_url", image_url: { url: media.url } };
  }

  // A zero-copy view: `media.bytes` is already the bytes, and `Buffer.from`
  // on a Uint8Array copies the lot a second time.
  const base64 = Buffer.from(
    media.bytes.buffer,
    media.bytes.byteOffset,
    media.bytes.byteLength,
  ).toString("base64");

  if (media.kind === "video") {
    return { type: "video_url", video_url: { url: `data:${media.mediaType};base64,${base64}` } };
  }

  const format = AUDIO_FORMATS[media.mediaType];
  if (!format) {
    throw new UnderstandRefused(
      0,
      `audio of type ${media.mediaType} cannot be sent to this model`,
    );
  }
  return { type: "input_audio", input_audio: { data: base64, format } };
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
 * @param budgetMs - How long the whole body may take to arrive.
 * @returns What the model wrote and why it stopped.
 * @throws {UnderstandRefused} when the body carries no answer.
 */
async function readAnswer(res: Response, budgetMs: number): Promise<UnderstandAnswer> {
  let text: string;
  try {
    text = await readWithin(res, budgetMs);
  } catch (err) {
    // The transport's deadline was spent when it handed this response back, so
    // an upstream that dribbles bytes would otherwise hold the call open with
    // nothing to show for it.
    throw new UnderstandRefused(res.status, `the answer never finished arriving: ${String(err)}`);
  }

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

  return readAnswer(res, request.timeoutMs);
}
