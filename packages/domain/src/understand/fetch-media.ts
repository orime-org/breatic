// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Turning an address into media a model can be asked about.
 *
 * Two questions, in this order: what is it, and is it small enough. Both are
 * answered as early as the far side allows — a server that states its type and
 * its length settles both before a byte is read, which is what lets an
 * oversized file be refused without a model call. A server that states neither
 * is caught on the way past.
 *
 * Only video and audio become bytes. An image stays an address because the
 * backend fetches images itself, measured working; the same measurement says a
 * video url comes back 400 and an audio url is read as base64 and fails to
 * decode.
 */

import { BodyTooLarge, EmptyBody, httpRequest, readBytesWithin, reasonOf } from "@breatic/shared";
import { reachable } from "@domain/understand/private-address.js";
import { audioFormatOf, MediaUnavailable } from "@domain/understand/types.js";
import type { AudioFormat, FetchMediaRequest, Media } from "@domain/understand/types.js";

/** The smallest read budget, for a file too small for the rate to matter. */
const DEFAULT_READ_FLOOR_MS = 5_000;

/** What each extension we recognise means, for when the server will not say. */
const TYPE_BY_EXTENSION: Readonly<Record<string, string>> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  flac: "audio/flac",
  ogg: "audio/ogg",
  m4a: "audio/mp4",
};

/** A type this module can go on with, and what going on with it needs. */
type Settled = { kind: "image" | "video" } | { kind: "audio"; format: AudioFormat };

/**
 * What a media type settles to, when it is one this module can carry.
 *
 * Audio settles to more than a kind: the name its format travels under is
 * decided here, where refusing is still free, rather than at the point the
 * bytes are packed — an address holding audio the endpoint will not take is
 * refused for what it is, before any of it crosses the wire.
 * @param mediaType - A type like `video/mp4`.
 * @returns What it settled to, or undefined when this module cannot carry it.
 */
function settle(mediaType: string): Settled | undefined {
  const top = mediaType.split("/")[0];
  if (top === "image" || top === "video") return { kind: top };
  if (top !== "audio") return undefined;
  const format = audioFormatOf(mediaType);
  return format === undefined ? undefined : { kind: "audio", format };
}

/**
 * The type the server declared, stripped of its parameters.
 *
 * `application/octet-stream` counts as no declaration at all: it is what an
 * object store answers for a key whose extension it never registered, so ours
 * says it for files that really are video. Treating it as a type would refuse
 * them; treating it as silence sends the question to the address.
 * @param headers - The headers as they arrived.
 * @returns The declared type, or undefined when nothing usable was declared.
 */
function declaredType(headers: Headers | undefined): string | undefined {
  const raw = headers?.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (!raw || raw === "application/octet-stream") return undefined;
  return raw;
}

/**
 * The type this address's own extension implies.
 * @param url - The address.
 * @returns The implied type, or undefined when the extension says nothing.
 */
function typeFromAddress(url: string): string | undefined {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return undefined;
  }
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  return TYPE_BY_EXTENSION[extension];
}

/**
 * How many hops one address may be redirected through.
 *
 * Measured against addresses a reader would actually paste: a tinyurl link to
 * a Wikimedia image takes four, and Wikipedia's own `Special:FilePath` takes
 * three before any shortener is involved. Ten leaves room above both and stays
 * well under the twenty that Node's `fetch` and every browser allow, so a host
 * still cannot keep this server walking.
 */
const MAX_HOPS = 10;

/**
 * Send one request, judging every address it is redirected to.
 *
 * The gate has to run per hop rather than once at the start, because a
 * redirect names a second address chosen by whoever controls the first host —
 * exactly the party whose address the caller was told not to trust. Following
 * is not optional: an ordinary image url answers 302 to a CDN, so refusing
 * every redirect would refuse most real addresses.
 * @param url - Where to start.
 * @param init - What kind of request to send.
 * @param request - The caller's limits and signal.
 * @returns The first answer that is not a redirect.
 * @throws {MediaUnavailable} when a hop points somewhere we will not go, or
 * the hops run out.
 */
async function fetchGuarded(
  url: string,
  init: RequestInit,
  request: FetchMediaRequest,
): Promise<Response> {
  let target = url;
  for (let hop = 0; hop <= MAX_HOPS; hop += 1) {
    // What is listening there stays unsaid — that is what this gate exists
    // for. That we declined to go is a different fact, and the reader typed
    // the address, so saying it names nothing they do not have.
    if (!(await reachable(target))) {
      throw new MediaUnavailable("unreachable", { detail: "it is not a public address" });
    }

    const res = await httpRequest(
      target,
      { ...init, redirect: "manual" },
      {
        replaySafe: true,
        timeoutMs: request.fetchTimeoutMs,
        ...(request.signal ? { signal: request.signal } : {}),
      },
    );

    const location =
      res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    // A redirect naming nowhere is an answer like any other: there is no
    // second address to judge, so the caller reads this status as it stands.
    if (location === null) return res;

    void res.body?.cancel();
    try {
      target = new URL(location, target).toString();
    } catch {
      throw new MediaUnavailable("unreachable", { status: res.status });
    }
  }
  throw new MediaUnavailable("unreachable", { detail: `more than ${MAX_HOPS} redirects` });
}

/**
 * Ask for the headers alone.
 *
 * Two outcomes have to stay apart. A live host declining this method (405 is
 * common) settles nothing but says the address is there — the type comes off
 * the address instead and the GET goes ahead. Nothing answering at all is the
 * one confirmed fact about the address, and it matters most on the image path,
 * which makes no second request and would otherwise hand the model a URL this
 * side already knows is dead.
 * @param url - The address.
 * @param request - The caller's limits and signal.
 * @returns The answer, or the reason there was none.
 */
async function peek(url: string, request: FetchMediaRequest): Promise<Response | Error> {
  try {
    const res = await fetchGuarded(url, { method: "HEAD" }, request);
    void res.body?.cancel();
    return res;
  } catch (err) {
    // The gate's refusal is not "nothing answered" — nothing was asked. Letting
    // it read as a failed peek would send the GET below to the address the gate
    // just refused.
    if (err instanceof MediaUnavailable) throw err;
    return err instanceof Error ? err : new Error(reasonOf(err));
  }
}

/**
 * What a peek that never came back stands for.
 * @param err - What the peek gave back instead of an answer.
 * @returns The failure to report.
 */
function nothingAnswered(err: Error): MediaUnavailable {
  return new MediaUnavailable("unreachable", { detail: reasonOf(err) });
}

/**
 * The length a set of headers states, when it states one.
 * @param headers - The headers to read, when there are any.
 * @returns The stated length, or undefined.
 */
function statedLength(headers: Headers | undefined): number | undefined {
  const raw = Number(headers?.get("content-length") ?? Number.NaN);
  return Number.isFinite(raw) ? raw : undefined;
}

/**
 * Settle what this address holds, and get it if it has to travel inline.
 * @param request - The address and the caller's limits.
 * @returns The media, ready to hand to a model.
 * @throws {MediaUnavailable} when the address yields no usable media.
 */
export async function fetchMedia(request: FetchMediaRequest): Promise<Media> {
  const peeked = await peek(request.url, request);
  const answered = peeked instanceof Response;

  // Gone is gone, and a GET would not find it either — so this is settled
  // before the type, whatever the address is named. Every other refusal is
  // about the method rather than the address: a presigned url is signed per
  // method, and a host answering 405 to a HEAD still serves the GET.
  if (answered && (peeked.status === 404 || peeked.status === 410)) {
    throw new MediaUnavailable("unreachable", { status: peeked.status });
  }

  // Only an answer that came back whole describes what is there: a refusal
  // carries headers about the refusal.
  const headers = answered && peeked.ok ? peeked.headers : undefined;
  const declared = declaredType(headers) ?? typeFromAddress(request.url);
  const settled = declared ? settle(declared) : undefined;

  // An image is the one kind that never travels through here, so it is the one
  // kind that can be settled without a second request.
  if (settled?.kind === "image") {
    // The one kind that sends no second request, so the peek is the only
    // chance to learn the address is there at all.
    if (!answered) throw nothingAnswered(peeked);
    return { kind: "image", url: request.url, mediaType: declared as string };
  }

  // Everything else needs the bytes anyway, and the GET brings the type along
  // with them — which is the only way to learn it from a host that declined
  // the HEAD and an address whose name carries no extension.
  const headLength = statedLength(headers);
  if (headLength !== undefined && headLength > request.maxBytes) {
    throw new MediaUnavailable("too-large", { bytes: headLength, limit: request.maxBytes });
  }
  if (declared && !settled) {
    throw new MediaUnavailable("unsupported-type", { declaredType: declared });
  }

  let res: Response;
  try {
    res = await fetchGuarded(request.url, {}, request);
  } catch (err) {
    if (err instanceof MediaUnavailable) throw err;
    throw new MediaUnavailable("unreachable", { detail: reasonOf(err) });
  }

  if (!res.ok) {
    // Cancelled synchronously, before any await: the transport measured
    // connection reuse collapsing when refusals are discarded unread past
    // undici's buffering threshold, and a cancel after an await can reject.
    void res.body?.cancel();
    throw new MediaUnavailable("unreachable", { status: res.status });
  }

  const mediaType = declared ?? declaredType(res.headers);
  const kind = mediaType ? (settled ?? settle(mediaType)) : undefined;
  if (!mediaType || !kind) {
    void res.body?.cancel();
    throw new MediaUnavailable("unsupported-type", {
      ...(mediaType ? { declaredType: mediaType } : {}),
    });
  }
  if (kind.kind === "image") {
    // Settled by the GET rather than the peek, and an image still travels as
    // its address — so the bytes on their way here are not wanted.
    void res.body?.cancel();
    return { kind: "image", url: request.url, mediaType };
  }

  // The GET's own statement first: the bytes about to be read are its, so its
  // header is the one describing them. A zero from the HEAD is not a statement
  // about a body it never described, and taken as one it puts the read on the
  // floor budget and calls an ordinary clip slow.
  const stated = statedLength(res.headers) ?? (headLength === 0 ? undefined : headLength);
  if (stated !== undefined && stated > request.maxBytes) {
    void res.body?.cancel();
    throw new MediaUnavailable("too-large", { bytes: stated, limit: request.maxBytes });
  }

  // How long the body may take, from how large it is. With no statement at all
  // the size is unknown and its upper bound is the limit itself, so the budget
  // is the one that limit implies — the same ceiling the read enforces anyway.
  const expected = stated ?? request.maxBytes;
  const floor = request.readFloorMs ?? DEFAULT_READ_FLOOR_MS;
  const budgetMs = Math.max(floor, (expected / request.minBytesPerSec) * 1000);

  let bytes: Uint8Array;
  try {
    bytes = await readBytesWithin(res, budgetMs, request.maxBytes, request.signal);
  } catch (err) {
    // No `bytes` on the size failure: what this path knows is "more than the
    // limit arrived", and the cut-off point is not the file's size.
    if (err instanceof BodyTooLarge) {
      throw new MediaUnavailable("too-large", { limit: request.maxBytes });
    }
    // A body that was never there is not a body that stopped part way. The
    // first is the address yielding nothing and says so; the second is a
    // download that did not finish, which is what "slow" reports and what a
    // retry can fix.
    if (err instanceof EmptyBody) {
      throw new MediaUnavailable("unreachable", { detail: reasonOf(err) });
    }
    throw new MediaUnavailable("slow", { detail: reasonOf(err) });
  }
  return kind.kind === "audio"
    ? { kind: "audio", bytes, mediaType, format: kind.format }
    : { kind: kind.kind, bytes, mediaType };
}
