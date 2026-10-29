// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { BodyTooLarge } from "@provider/http/errors.js";
import { reachable } from "@provider/http/private-address.js";
import { isSuccess, readBody, send } from "@provider/http/request.js";

/** The media type each address extension implies (domain's understand/fetch-media.ts TYPE_BY_EXTENSION, images). */
const TYPE_BY_EXTENSION: Readonly<Record<string, string>> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
};

/** How many redirects one address may go through. */
const MAX_HOPS = 10;

/** Why a media address was not read. */
export type MediaRefusal = "unreachable" | "too_large" | "unavailable" | "unsupported_type" | "empty";

/** A media address that was refused or could not be read. */
export class MediaRefused extends Error {
  readonly kind: MediaRefusal;
  readonly status: number | undefined;

  /**
   * Record what the error carries.
   * @param kind - Why.
   * @param status - The status code, for an address that answered with one we do not read.
   */
  constructor(kind: MediaRefusal, status?: number) {
    super(`Media refused: ${kind}`);
    this.name = "MediaRefused";
    this.kind = kind;
    this.status = status;
  }
}

/** One media read. */
export interface FetchMediaRequest {
  url: string;
  /** The largest body read, in bytes. */
  maxBytes: number;
  /** Fetching and reading end here, in epoch milliseconds. */
  deadlineAt: number;
  signal?: AbortSignal;
}

/** The bytes at an address. */
export interface FetchedMedia {
  bytes: Uint8Array;
  /** The type settled from the declaration, else the address's extension. */
  contentType: string;
}

/**
 * The type a fetched media settles to, as domain's understand settles it: the declared
 * Content-Type without parameters, trimmed and lower-cased; `application/octet-stream` or
 * none counts as no declaration (an object store answers it for keys it never registered),
 * and the address's extension decides instead.
 * @param headers - The answer's headers.
 * @param url - The address asked for.
 * @returns The type, or `application/octet-stream` when neither says one.
 */
function settledType(headers: Headers, url: string): string {
  const declared = headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (declared !== undefined && declared !== "" && declared !== "application/octet-stream") return declared;
  const extension = new URL(url).pathname.split(".").pop()?.toLowerCase() ?? "";
  return Object.hasOwn(TYPE_BY_EXTENSION, extension) ? TYPE_BY_EXTENSION[extension]! : "application/octet-stream";
}

/**
 * Read the bytes at a public address, judging every redirect hop before following it.
 * @param request - What to read and its limits.
 * @returns The bytes and the type they settle to.
 * @throws {MediaRefused} When an address is not public, the body is empty or over the limit, or the address answers non-2xx.
 * @throws {Aborted} When the deadline or the signal ends the read.
 * @throws {NotSent} When the address could not be reached.
 * @throws {NoAnswer} When the address stopped answering.
 */
export async function fetchMedia(request: FetchMediaRequest): Promise<FetchedMedia> {
  const bounds = { replaySafe: true, deadlineAt: request.deadlineAt, ...(request.signal ? { signal: request.signal } : {}) };
  let target = request.url;
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    if (!(await reachable(target))) throw new MediaRefused("unreachable");
    const response = await send({ url: target, method: "GET" }, bounds);
    const location = response.status >= 300 && response.status < 400 ? response.headers.get("location") : null;
    if (location === null) {
      if (!isSuccess(response.status)) {
        await response.body?.cancel();
        throw new MediaRefused("unavailable", response.status);
      }
      try {
        const bytes = await readBody(target, response, request.maxBytes, Math.max(0, request.deadlineAt - Date.now()), bounds);
        if (bytes.byteLength === 0) throw new MediaRefused("empty");
        return { bytes, contentType: settledType(response.headers, request.url) };
      } catch (error) {
        if (error instanceof BodyTooLarge) throw new MediaRefused("too_large");
        throw error;
      }
    }
    await response.body?.cancel();
    try {
      target = new URL(location, target).toString();
    } catch {
      throw new MediaRefused("unreachable", response.status);
    }
  }
  throw new MediaRefused("unreachable");
}
