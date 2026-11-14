// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Asking a model one question about an ordered collection of media, through provider.
 *
 * Who answers, and how each upstream is sent the media, is provider's. What is
 * kept here is what the callers read: each billed answer reported once, and a
 * refusal judged into what it is about.
 */

import {
  costsOf,
  NoUpstreamAvailable,
  UnderstandInterrupted,
  UpstreamRequestRejected,
  type UnderstandMedia,
} from "@breatic/provider";
import { provider } from "@domain/provider/instance.js";
import { MediaUnavailable, UnderstandRefused } from "@domain/understand/types.js";
import type {
  Media,
  MediaTransport,
  RefusalFacts,
  RefusalKind,
  UnderstandAnswer,
  UnderstandRequest,
} from "@domain/understand/types.js";

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
 * @param facts - The code and how the media went.
 * @returns Which of the five it is about.
 */
function refusalKind(facts: RefusalFacts): RefusalKind {
  // A moment, not a fact: the service's own 408 and 429, every 5xx it names,
  // and every 5xx it does not.
  const { code } = facts;
  if (code === 408 || code === 429 || code >= 500) return "transient";
  // The provider's body ceiling, reached by what we put in it.
  if (code === 413) return "media";
  // Measured, a video sent as a url comes back 400 `Cannot fetch content`.
  // Only an address-only batch supports the unreachable-address
  // classification. In a mixed batch, the same status may be an inline
  // decoding or request failure; it cannot establish that a URL was unreachable.
  if (code === 400) return facts.transport === "address" ? "unfetchable" : "media";
  // The one shape where the status has nothing to say: it is 200 by
  // construction. Measured, that is this model's guardrail declining the
  // question, and a differently worded one about the same file is answered.
  if (code === 200) return "content-filter";
  return "deployment";
}

/**
 * One item as provider takes it.
 * @param media - The item.
 * @returns The item.
 */
function itemOf(media: Media): UnderstandMedia {
  return media.kind === "image"
    ? { url: media.url, contentType: media.contentType, read: media.read }
    : { bytes: media.bytes, contentType: media.contentType };
}

/**
 * Ask the model about this media and hand back what it wrote.
 *
 * Reports rather than interprets: an answer that came back is returned with
 * whatever `finishReason` it carried, empty text and all. Deciding what an
 * empty answer or a truncated one should say to anyone is the caller's, one
 * layer up, where the user is known.
 * @param request - The media, the question, and the model.
 * @returns What the model wrote and why it stopped.
 * @throws {UnderstandRefused} when the service would not answer.
 * @throws {MediaUnavailable} when an image's bytes could not be read for an upstream that needs them.
 * @throws {UnderstandInterrupted} when the call ended without an answer for another reason.
 */
export async function understandMedia(request: UnderstandRequest): Promise<UnderstandAnswer> {
  request.signal?.throwIfAborted();
  await request.onRequestSending?.();
  const hasAddresses = request.media.some((media) => media.kind === "image");
  const hasInline = request.media.some((media) => media.kind !== "image");
  const transport: MediaTransport = hasAddresses ? (hasInline ? "mixed" : "address") : "inline";
  try {
    const answer = await provider().llm.understand({
      model: request.model,
      question: request.question,
      media: request.media.map(itemOf),
      maxOutputTokens: request.maxOutputTokens,
      deadlineAt: Date.now() + request.timeoutMs,
      ...(request.signal ? { signal: request.signal } : {}),
    });
    for (const cost of answer.costs) request.onBilled(cost, answer.upstream);
    return { text: answer.text, finishReason: answer.finishReason };
  } catch (err) {
    const upstream = err instanceof UpstreamRequestRejected ? err.upstream : "";
    for (const cost of costsOf(err)) request.onBilled(cost, upstream);
    request.signal?.throwIfAborted();
    if (err instanceof UpstreamRequestRejected && err.status !== undefined) {
      throw new UnderstandRefused(err.status, err.message, refusalKind({ code: err.status, transport }), err.reason === "content_blocked");
    }
    if (err instanceof UpstreamRequestRejected || err instanceof NoUpstreamAvailable) {
      throw new UnderstandRefused(0, err.message, "deployment");
    }
    // An image an upstream needed the bytes of, and could not have.
    if (err instanceof UnderstandInterrupted && err.cause instanceof MediaUnavailable) throw err.cause;
    throw err;
  }
}
