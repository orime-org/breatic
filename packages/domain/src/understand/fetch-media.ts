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

import { httpRequest } from "@breatic/shared";
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
function declaredType(headers: Headers): string | undefined {
  const raw = headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
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
 * Ask for the headers alone.
 *
 * A HEAD that fails is not a failure of this call. Plenty of servers answer
 * 405 to it, and both things it would have settled — the type and the size —
 * have somewhere else to come from.
 * @param url - The address.
 * @param request - The caller's limits and signal.
 * @returns The headers, or undefined when the request did not answer.
 */
async function peek(
  url: string,
  request: FetchMediaRequest,
): Promise<Headers | undefined> {
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
    return res.ok ? res.headers : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Read a whole body, counting as it arrives and stopping when it is too much.
 *
 * The counting is here rather than after the read because the point of a limit
 * is not to describe a file already in memory. A body with no stated length is
 * a body of unknown size, and reading it to the end to find out is the thing
 * the limit exists to prevent.
 *
 * The budget follows the same shape the search tool's does, and for the same
 * reason: the transport's deadline is spent once it hands the response back,
 * and the platform's own body timeout measures inactivity, so a sender that
 * keeps writing slowly never trips it.
 * @param res - The response whose body is being read.
 * @param maxBytes - The most that may arrive.
 * @param budgetMs - How long the whole body may take.
 * @returns The bytes.
 * @throws {MediaUnavailable} when it is too large, or took too long.
 */
async function readBodyWithin(
  res: Response,
  maxBytes: number,
  budgetMs: number,
): Promise<Uint8Array> {
  const body = res.body;
  if (body === null) throw new MediaUnavailable("unreachable", { status: res.status });

  const chunks: Uint8Array[] = [];
  let total = 0;
  let tooLarge = false;

  try {
    await body.pipeTo(
      new WritableStream<Uint8Array>({
        write(chunk, controller) {
          total += chunk.byteLength;
          if (total > maxBytes) {
            // Recorded before the error, so the catch below can tell "over the
            // limit" from "ran out of time": both arrive here as a rejection
            // and the stream does not carry which.
            tooLarge = true;
            controller.error(new Error("over the limit"));
            return;
          }
          chunks.push(chunk);
        },
      }),
      { signal: AbortSignal.timeout(Math.trunc(budgetMs)) },
    );
  } catch (err) {
    if (tooLarge) throw new MediaUnavailable("too-large", { bytes: total, limit: maxBytes });
    throw new MediaUnavailable("slow", { bytes: total, detail: String(err) });
  }

  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
}

/**
 * Settle what this address holds, and get it if it has to travel inline.
 * @param request - The address and the caller's limits.
 * @returns The media, ready to hand to a model.
 * @throws {MediaUnavailable} when the address yields no usable media.
 */
export async function fetchMedia(request: FetchMediaRequest): Promise<Media> {
  const headers = await peek(request.url, request);

  const mediaType = (headers && declaredType(headers)) ?? typeFromAddress(request.url);
  const kind = mediaType ? kindOf(mediaType) : undefined;
  if (!mediaType || !kind) {
    throw new MediaUnavailable("unsupported-type", {
      ...(mediaType ? { declaredType: mediaType } : {}),
    });
  }

  // The stated length, where there is one. This is the only check that can
  // happen before anything is transferred, which is what "do not call the
  // model at all" asks for.
  const stated = Number(headers?.get("content-length") ?? Number.NaN);
  if (Number.isFinite(stated) && stated > request.maxBytes) {
    throw new MediaUnavailable("too-large", { bytes: stated, limit: request.maxBytes });
  }

  if (kind === "image") {
    return { kind, url: request.url, mediaType };
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
    throw new MediaUnavailable("unreachable", { status: res.status });
  }

  // How long the body may take, from how long it should take. A file whose
  // size is unknown gets the floor, which is the same answer as for a file too
  // small for the rate to matter.
  const expected = Number.isFinite(stated) ? stated : 0;
  const floor = request.readFloorMs ?? DEFAULT_READ_FLOOR_MS;
  const budgetMs = Math.max(floor, (expected / request.minBytesPerSec) * 1000);

  const bytes = await readBodyWithin(res, request.maxBytes, budgetMs);
  return { kind, bytes, mediaType };
}
