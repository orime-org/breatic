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

import { EmptyBody, httpRequest, readWithin } from "@breatic/shared";
import { UnderstandRefused } from "@domain/understand/types.js";
import type {
  Media,
  RefusalKind,
  UnderstandAnswer,
  UnderstandRequest,
} from "@domain/understand/types.js";

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

  // Both formats travel with the media: which video and which audio can be
  // sent is settled where the address is settled, so nothing is left to decide
  // here. What a server calls a file and what this endpoint calls it are two
  // facts, and the second one arrived with the bytes.
  if (media.kind === "video") {
    return { type: "video_url", video_url: { url: `data:${media.format};base64,${base64}` } };
  }

  return { type: "input_audio", input_audio: { data: base64, format: media.format } };
}

/**
 * What a refusal carrying this code is about.
 *
 * Every code the service documents has a home, and so does every code it does
 * not: the fall-through is `deployment`, which says nothing about the file that
 * was sent. That direction is the point of the function. A default that names
 * the media turns each new code into a false statement about someone's file,
 * and this endpoint sits behind an edge network that raises codes of its own —
 * measured, `server: cloudflare`, whose 520 through 530 are nowhere in the
 * service's table and whose origin ceiling is shorter than the call budget
 * here, so 524 is what a large upload and a slow answer arrive at.
 * @param code - The status this refusal carries.
 * @returns Which of the four it is about.
 */
function refusalKind(code: number): RefusalKind {
  // A moment, not a fact: the service's own 408 and 429, every 5xx it names,
  // and every 5xx it does not.
  if (code === 408 || code === 429 || code >= 500) return "transient";
  // Its own words for 403: "insufficient permissions, guardrail block, or
  // moderation flag". The two that reach a call carrying media and a question
  // are the content ones, and their next move is the content filter's — ask
  // differently about the same file.
  if (code === 403) return "content-filter";
  // 413 is the provider's body ceiling and 400 is the endpoint refusing what it
  // was handed — measured, a video sent as a url comes back 400 `Cannot fetch
  // content`. Both are about what travelled.
  if (code === 400 || code === 413) return "media";
  return "deployment";
}

/**
 * What the endpoint answers with, as far as anything here reads it.
 *
 * `error.code` is read because the transport status cannot always speak: an
 * error raised once the model is already producing output arrives on a 200 with
 * the real code inside the envelope.
 */
interface Completion {
  choices?: Array<{ message?: { content?: unknown }; finish_reason?: unknown }>;
  usage?: { total_tokens?: unknown };
  error?: { message?: unknown; code?: unknown };
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
 * @param signal - The caller's signal, so the read ends when they do.
 * @returns What the model wrote and why it stopped.
 * @throws {UnderstandRefused} when the body carries no answer.
 */
async function readAnswer(
  res: Response,
  budgetMs: number,
  signal: AbortSignal | undefined,
): Promise<UnderstandAnswer> {
  /**
   * A refusal judged by the status, unless the body carries a code of its own.
   *
   * Every throw below goes through here, so one code reaches one kind and
   * changing what a code means is one edit.
   * @param detail - The service's own words.
   * @param code - The code to judge by, when it is not the transport's.
   * @returns The refusal to throw.
   */
  const refusal = (detail: string, code = res.status): UnderstandRefused =>
    new UnderstandRefused(code, detail, refusalKind(code));

  let text: string;
  try {
    text = await readWithin(res, budgetMs, signal);
  } catch (err) {
    // The transport's deadline was spent when it handed this response back, so
    // an upstream that dribbles bytes would otherwise hold the call open with
    // nothing to show for it.
    //
    // A body that stopped part way is the one failure the status cannot speak
    // for: the headers arrived, so the status is whatever the answer would have
    // been, and a second attempt gets the rest. A body that was never there is
    // not that — the status is the whole of what came, and calling it a
    // stopped read puts a permanent failure on the retry side, where the retry
    // re-uploads the entire clip.
    if (err instanceof EmptyBody) throw refusal("the answer carried nothing");
    throw new UnderstandRefused(
      res.status,
      `the answer never finished arriving: ${String(err)}`,
      "transient",
    );
  }

  let body: Completion;
  try {
    body = JSON.parse(text) as Completion;
  } catch {
    throw refusal(text.slice(0, 300));
  }

  if (body.error) {
    // Every failure arrives in this envelope — a spent credit, a rate limit, a
    // body the provider would not take — so the envelope says nothing on its
    // own and the code decides. The code is the envelope's own when it carries
    // one: an error raised while the model is already producing output arrives
    // on a 200, which by construction says nothing about what went wrong.
    const detail = String(body.error.message ?? text.slice(0, 300));
    if (typeof body.error.code === "number") throw refusal(detail, body.error.code);
    // A 200 with no code of its own. Measured, that is this model's guardrail
    // declining the question, and a differently worded one about the same file
    // is answered.
    if (res.ok) throw new UnderstandRefused(res.status, detail, "content-filter");
    throw refusal(detail);
  }

  const choice = body.choices?.[0];
  if (!res.ok || !choice) {
    throw refusal(text.slice(0, 300));
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

  return readAnswer(res, request.timeoutMs, request.signal);
}
