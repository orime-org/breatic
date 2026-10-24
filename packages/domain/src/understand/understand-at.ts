// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The whole of one media understanding call: get the media, then ask about it.
 *
 * The two steps have an order and a set of limits between them, and that
 * belongs here rather than in each caller. A second caller assembling it again
 * would decide for itself which failures mean what, and the two would answer
 * differently for the same address.
 */

import { fetchMedia } from "@domain/understand/fetch-media.js";
import { understandMedia } from "@domain/understand/understand.js";
import { MediaUnavailable } from "@domain/understand/types.js";
import type { Media, MediaKind, UnderstandAnswer, UnderstandAt } from "@domain/understand/types.js";

/** What one ordered batch call answered with, and its settled media kinds. */
export interface UnderstandAtAnswer extends UnderstandAnswer {
  /** The first input's settled kind, retained for single-item callers. */
  kind: MediaKind;
  /** Each input's settled kind in the original order. */
  kinds: MediaKind[];
}

/**
 * Get an ordered media batch and ask a model about it in one call.
 * @param request - Ordered items, the question, shared limits, and who to ask.
 * @returns What the model wrote, the first kind and all kinds in input order.
 * @throws {MediaUnavailable} when an item yields no usable media.
 * @throws {UnderstandRefused} when the service would not answer.
 * @throws {RangeError} when no media items were supplied.
 * @throws {DOMException} when the caller stops the request.
 */
export async function understandMediaAt(request: UnderstandAt): Promise<UnderstandAtAnswer> {
  const media: Media[] = [];
  let remainingDownloadBytes = request.maxBytes;
  for (const [index, item] of request.items.entries()) {
    request.signal?.throwIfAborted();
    let fetched: Media;
    try {
      fetched = await fetchMedia({ ...request, ...item, remainingDownloadBytes });
    } catch (err) {
      request.signal?.throwIfAborted();
      if (!(err instanceof MediaUnavailable)) throw err;
      throw new MediaUnavailable(err.kind, {
        itemIndex: index + 1,
        url: item.url,
        status: err.status,
        detail: err.detail,
        declaredType: err.declaredType,
        bytes: err.bytes,
        limit: err.limit,
      });
    }
    request.signal?.throwIfAborted();
    media.push(fetched);
    if (fetched.kind !== "image") remainingDownloadBytes -= fetched.bytes.byteLength;
  }
  const first = media[0];
  if (first === undefined) throw new RangeError("Media understanding requires at least one item.");
  request.signal?.throwIfAborted();
  const answer = await understandMedia({ ...request, media });
  return { ...answer, kind: first.kind, kinds: media.map((item) => item.kind) };
}
