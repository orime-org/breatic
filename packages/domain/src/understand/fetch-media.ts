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
import {
  audioFormatOf,
  IMAGE_TYPES,
  MediaUnavailable,
  videoFormatOf,
} from "@domain/understand/types.js";
import type {
  AudioFormat,
  FetchMediaRequest,
  Media,
  VideoFormat,
} from "@domain/understand/types.js";

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
  mpg: "video/mpeg",
  mpeg: "video/mpeg",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  flac: "audio/flac",
  ogg: "audio/ogg",
  m4a: "audio/mp4",
};

/** A type this module can go on with, and what going on with it needs. */
type Settled =
  | { kind: "image" }
  | { kind: "video"; format: VideoFormat }
  | { kind: "audio"; format: AudioFormat };

/**
 * What a media type settles to, when it is one this module can carry.
 *
 * All three kinds are judged against what the endpoint takes, here, where
 * refusing is still free — an address holding a format it will not take is
 * refused for what it is, before any of it crosses the wire and before a model
 * call is spent being told the same thing. The two that travel as bytes settle
 * to more than a kind, because the name each one is sent under is decided at
 * the same moment; an image travels as its address, so there is nothing more
 * to decide about it.
 * @param mediaType - A type like `video/mp4`.
 * @returns What it settled to, or undefined when this module cannot carry it.
 */
function settle(mediaType: string): Settled | undefined {
  const top = mediaType.split("/")[0];
  if (top === "image") return IMAGE_TYPES.has(mediaType) ? { kind: "image" } : undefined;
  if (top === "video") {
    const format = videoFormatOf(mediaType);
    return format === undefined ? undefined : { kind: "video", format };
  }
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
    // for. That we declined to go is a different fact, and which address was
    // declined is a third: on a later hop the reader's own address was fine
    // and it is the place it points at that we will not follow, which is
    // something they can act on.
    if (!(await reachable(target))) {
      throw new MediaUnavailable("unreachable", {
        detail:
          hop === 0
            ? "it is not a public address"
            : "it redirects to an address that is not public",
      });
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
 * What this saves is a download: a server that states its type and its length
 * settles both questions before a byte is read, which is what lets an
 * oversized or unsupported file be refused without transferring it. Anything
 * short of that — a host declining the method, nothing answering at all —
 * settles nothing and leaves the address for the GET to speak for.
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
  // Only an answer that came back whole describes what is there: a refusal
  // carries headers about the refusal, and a peek that never arrived carries
  // nothing at all. Both leave the type to the address's own name and both
  // leave the address itself for the GET to speak for.
  const settledPeek = peeked instanceof Response && peeked.ok;
  const headers = settledPeek ? peeked.headers : undefined;
  const declared = declaredType(headers) ?? typeFromAddress(request.url);
  const settled = declared ? settle(declared) : undefined;

  // An image is the one kind that never travels through here, so it is the one
  // kind that can be settled without a second request — but only off a peek
  // that settled it. A refusal we already hold is a fact about the address,
  // and handing the url over regardless spends a model call to be told the
  // backend could not fetch it, in words that name the service rather than the
  // status.
  if (settledPeek && settled?.kind === "image") {
    return { kind: "image", url: request.url };
  }

  // Everything else needs the bytes anyway, and the GET brings the type along
  // with them — which is the only way to learn it from a host that declined
  // the HEAD and an address whose name carries no extension.
  //
  // The size is judged only once the kind is known, for the reason an image is
  // exempt at all: the limit measures the request body this side sends, and an
  // image never becomes one. An unsettled type may still turn out to be an
  // image, and a GET that settles one returns before the length matters.
  const headLength = statedLength(headers);
  if (settled && headLength !== undefined && headLength > request.maxBytes) {
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

  // The GET's own statement outranks the address's name, which is the order
  // the peek already settles by: a name is a guess and a server's statement is
  // not. A landing page served at a media name reaches the model as that media
  // otherwise — html read as an mp3, up to the whole limit of it, uploaded.
  const fromGet = declaredType(res.headers);
  const mediaType = fromGet ?? declared;
  const kind = fromGet ? settle(fromGet) : settled;
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
    return { kind: "image", url: request.url };
  }

  // The bytes about to be read are the GET's, so the header describing them is
  // the GET's and no other. The HEAD's figure had its use before the GET went
  // out, refusing an oversized file without transferring it; here it would
  // only describe a body it never saw, and a HEAD understating the length puts
  // the read on the floor budget and calls an ordinary clip slow.
  const stated = statedLength(res.headers);
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
    // A body that was never there is not a body that stopped part way, and it
    // is not an address that could not be reached either: this one answered
    // the peek, answered the GET, and stated a type. What it holds is nothing,
    // and that is the one thing worth telling anyone about it.
    if (err instanceof EmptyBody) {
      throw new MediaUnavailable("empty", {});
    }
    throw new MediaUnavailable("slow", { detail: reasonOf(err) });
  }
  return kind.kind === "audio"
    ? { kind: "audio", bytes, format: kind.format }
    : { kind: "video", bytes, format: kind.format };
}
