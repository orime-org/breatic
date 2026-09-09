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

import { BodyTooLarge, httpRequest, readBytesWithin } from "@breatic/shared";
import { reachable } from "@domain/understand/private-address.js";
import { MediaUnavailable } from "@domain/understand/types.js";
import type { FetchMediaRequest, Media, MediaKind } from "@domain/understand/types.js";

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

/**
 * Which of the three kinds a media type names, if any.
 * @param mediaType - A type like `video/mp4`.
 * @returns The kind, or undefined when it is none of the three.
 */
function kindOf(mediaType: string): MediaKind | undefined {
  const top = mediaType.split("/")[0];
  return top === "image" || top === "video" || top === "audio" ? top : undefined;
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

/** What asking for the headers alone turned up. */
interface Peeked {
  /** Whether anything answered at all. */
  answered: boolean;
  /** The headers, when the answer was one that carries them. */
  headers?: Headers;
  /** What the layer underneath said, when nothing answered. */
  detail?: string;
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
 * @returns What was learned, including whether anything answered.
 */
async function peek(url: string, request: FetchMediaRequest): Promise<Peeked> {
  try {
    const res = await httpRequest(
      url,
      { method: "HEAD" },
      {
        replaySafe: true,
        timeoutMs: request.fetchTimeoutMs,
        ...(request.signal ? { signal: request.signal } : {}),
      },
    );
    void res.body?.cancel();
    return res.ok ? { answered: true, headers: res.headers } : { answered: true };
  } catch (err) {
    return { answered: false, detail: String(err) };
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
  // Before anything is sent. The refusal carries no status and no detail: what
  // is listening on an address is exactly what this gate exists to not answer.
  if (!(await reachable(request.url))) {
    throw new MediaUnavailable("unreachable");
  }

  const peeked = await peek(request.url, request);

  const mediaType = declaredType(peeked.headers) ?? typeFromAddress(request.url);
  const kind = mediaType ? kindOf(mediaType) : undefined;
  if (!mediaType || !kind) {
    throw new MediaUnavailable("unsupported-type", {
      ...(mediaType ? { declaredType: mediaType } : {}),
    });
  }

  if (kind === "image") {
    // Nothing this side carries, so the size limit — which describes our own
    // request body — has nothing to say about it. What does matter is that the
    // address answered at all: this path makes no second request, so a dead
    // address handed over here reaches the model as a url it cannot fetch.
    if (!peeked.answered) {
      throw new MediaUnavailable("unreachable", { ...(peeked.detail ? { detail: peeked.detail } : {}) });
    }
    return { kind, url: request.url, mediaType };
  }

  const headLength = statedLength(peeked.headers);
  if (headLength !== undefined && headLength > request.maxBytes) {
    throw new MediaUnavailable("too-large", { bytes: headLength, limit: request.maxBytes });
  }

  let res: Response;
  try {
    res = await httpRequest(
      request.url,
      {},
      {
        replaySafe: true,
        timeoutMs: request.fetchTimeoutMs,
        ...(request.signal ? { signal: request.signal } : {}),
      },
    );
  } catch (err) {
    throw new MediaUnavailable("unreachable", { detail: String(err) });
  }

  if (!res.ok) {
    // Cancelled synchronously, before any await: the transport measured
    // connection reuse collapsing when refusals are discarded unread past
    // undici's buffering threshold, and a cancel after an await can reject.
    void res.body?.cancel();
    throw new MediaUnavailable("unreachable", { status: res.status });
  }

  // The GET states its own length, and on a server that declines HEAD it is
  // the only statement there is. Checking it here is still free of transferred
  // bytes, and it is what the read budget below is worked out from.
  const stated = headLength ?? statedLength(res.headers);
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
    bytes = await readBytesWithin(res, budgetMs, request.maxBytes);
  } catch (err) {
    // No `bytes` on the size failure: what this path knows is "more than the
    // limit arrived", and the cut-off point is not the file's size.
    if (err instanceof BodyTooLarge) {
      throw new MediaUnavailable("too-large", { limit: request.maxBytes });
    }
    throw new MediaUnavailable("slow", { detail: String(err) });
  }
  return { kind, bytes, mediaType };
}
