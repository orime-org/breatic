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
  RefusalFacts,
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
 * @param facts - The code, where the words came from, and how the media went.
 * @returns Which of the five it is about.
 */
function refusalKind(facts: RefusalFacts): RefusalKind {
  // A moment, not a fact: the service's own 408 and 429, every 5xx it names,
  // and every 5xx it does not — this endpoint answers from behind an edge
  // network (measured, `server: cloudflare`) whose 520 through 530 are nowhere
  // in the service's own table.
  const { code } = facts;
  if (code === 408 || code === 429 || code >= 500) return "transient";

  // The three kinds below all say something about what the caller sent, so
  // each of them needs the service's own words to say it with. Anything else
  // falls through to the kind that speaks about us, which is where a code
  // nobody has thought about belongs: named for the media, every new code
  // becomes a false accusation about somebody's file.
  if (facts.source === "envelope") {
    // The provider's body ceiling, reached by what we put in it.
    if (code === 413) return "media";
    // Measured, a video sent as a url comes back 400 `Cannot fetch content`.
    // An image is the one kind that travels as its address, so a 400 there is
    // about reaching the address and the move it leaves is to host the file
    // somewhere else; on the inline path the body is ours and so is the fault.
    if (code === 400) return facts.sentAsAddress ? "unfetchable" : "media";
    // The one shape where the status has nothing to say: it is 200 by
    // construction. Measured, that is this model's guardrail declining the
    // question, and a differently worded one about the same file is answered.
    if (code === 200) return "content-filter";
  }
  return "deployment";
}

/**
 * What the endpoint answers with, as far as anything here reads it.
 *
 * `error.code` is read because the transport status cannot always speak: an
 * error raised once the model is already producing output arrives on a 200 with
 * the real code inside the envelope.
 */
interface ServiceError {
  message?: unknown;
  code?: unknown;
}

interface Completion {
  choices?: Array<{
    message?: { content?: unknown };
    finish_reason?: unknown;
    error?: ServiceError;
  }>;
  error?: ServiceError;
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
 * @param sentAsAddress - Whether the media went as an address to be fetched.
 * @param signal - The caller's signal, so the read ends when they do.
 * @returns What the model wrote and why it stopped.
 * @throws {UnderstandRefused} when the body carries no answer.
 */
async function readAnswer(
  res: Response,
  budgetMs: number,
  sentAsAddress: boolean,
  signal: AbortSignal | undefined,
): Promise<UnderstandAnswer> {
  /**
   * A refusal, judged from everything known about it.
   *
   * Every throw that has facts to judge goes through here, so the rules live
   * in one function and each throw states only what it holds. The one throw
   * that does not is the body that stopped part way, which is a fact no code
   * carries: the status is whatever the answer would have been.
   * @param detail - The words, whoever wrote them.
   * @param about - What is known beyond the words themselves.
   * @param about.source - Where they came from.
   * @param about.code - The code to judge by, when it is not the transport's.
   * @returns The refusal to throw.
   */
  const refusal = (
    detail: string,
    about: { source: RefusalFacts["source"]; code?: number },
  ): UnderstandRefused => {
    const code = about.code ?? res.status;
    return new UnderstandRefused(code, detail, refusalKind({ ...about, code, sentAsAddress }));
  };

  /**
   * The refusal an `error` object stands for, wherever it was found.
   *
   * The code is the envelope's own when it carries one: an error raised once
   * the model is already producing output arrives on a 200, which by
   * construction says nothing about what went wrong.
   * @param error - The object the service put in the body.
   * @param fallback - The body as it arrived, for an envelope with no message.
   * @returns The refusal to throw.
   */
  const fromEnvelope = (error: ServiceError, fallback: string): UnderstandRefused =>
    refusal(String(error.message ?? fallback), {
      source: "envelope",
      ...(typeof error.code === "number" ? { code: error.code } : {}),
    });

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
    if (err instanceof EmptyBody) throw refusal("the answer carried nothing", { source: "ours" });
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
    throw refusal(text.slice(0, 300), { source: "body" });
  }

  if (body.error) throw fromEnvelope(body.error, text.slice(0, 300));

  const choice = body.choices?.[0];
  if (!res.ok || !choice) {
    throw refusal(text.slice(0, 300), { source: "body" });
  }

  const written = typeof choice.message?.content === "string" ? choice.message.content : "";
  // The service's second place for an error: a non-streaming call that fails
  // once the model is producing output puts it inside the choice, beside a
  // `finish_reason` of "error". With words already written it is a stop rather
  // than a refusal, and the reason it stopped travels on in `finishReason`.
  if (choice.error && written === "") throw fromEnvelope(choice.error, text.slice(0, 300));

  return {
    text: written,
    finishReason: typeof choice.finish_reason === "string" ? choice.finish_reason : "unknown",
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

  return readAnswer(res, request.timeoutMs, request.media.kind === "image", request.signal);
}
