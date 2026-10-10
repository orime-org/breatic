// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The media container's write-back of an upright picture (inner#1367 design
 * §4.3).
 *
 * The container PUTs the upright bytes to a host only this handler answers.
 * The handler stages them as a multipart upload carrying the original object's
 * HTTP metadata and the received hash, and hands the completion to the key's
 * arbiter, which completes or aborts it by the key's state. The handler never
 * completes an upload itself.
 */

import type { OutboundHandlerContext } from "@cloudflare/containers";
import { RECEIVED_SHA256 } from "@ingest/upright-arbiter.js";
import { writeStreamAsParts, type RecordedPart } from "@ingest/stored-object.js";

/** What one instance's write-back handler is set for. */
export interface UprightWrite {
  /** The only key it writes. */
  key: string;
  /** Carried on the written object. */
  receivedSha256: string;
  /** The original object's HTTP metadata, written back unchanged. */
  httpMetadata: R2HTTPMetadata;
}

/** The arbiter's one method the handler calls. */
export interface UprightCommitter {
  commitUpright(commit: { storageKey: string; uploadId: string; parts: RecordedPart[] }): Promise<boolean>;
}

/** The name the instance refers to the handler by. */
export const WRITE_UPRIGHT = "writeUpright";

/** Parts of an upright picture: R2's minimum part size is 5 MiB. */
const PART_SIZE = 8 * 1024 * 1024;

/** At most this many parts; 256 MiB, what the container lets out. */
const MAX_PARTS = 32;

/**
 * The write-back handler, reaching the arbiter through `arbiterOf`.
 * @param arbiterOf - The arbiter for the instance that is writing.
 * @returns The outbound handler.
 */
export function writeUprightVia(
  arbiterOf: (env: { BUCKET: R2Bucket }, ctx: OutboundHandlerContext<UprightWrite>) => UprightCommitter,
): (request: Request, env: { BUCKET: R2Bucket }, ctx: OutboundHandlerContext<UprightWrite>) => Promise<Response> {
  return async (request, env, ctx) => {
    if (request.method !== "PUT" || request.body === null) return new Response("Not allowed", { status: 405 });
    const key = decodeURIComponent(new URL(request.url).pathname).slice(1);
    if (key !== ctx.params.key) return new Response("Not this object", { status: 403 });

    const created = await env.BUCKET.createMultipartUpload(key, {
      httpMetadata: ctx.params.httpMetadata,
      customMetadata: { [RECEIVED_SHA256]: ctx.params.receivedSha256 },
    });
    const parts = await writeStreamAsParts(env.BUCKET, key, created.uploadId, request.body, PART_SIZE, MAX_PARTS);
    if (parts === "over_cap") {
      await created.abort();
      return new Response("Too large", { status: 413 });
    }
    const committed = await arbiterOf(env, ctx).commitUpright({ storageKey: key, uploadId: created.uploadId, parts });
    return new Response(null, { status: committed ? 200 : 409 });
  };
}
