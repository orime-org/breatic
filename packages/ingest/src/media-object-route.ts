// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Serving one stored object to the media container (#209 + #210, design §3.3).
 *
 * The container holds no credentials and has no route to the internet: every
 * request it makes is intercepted by the Worker and answered from here, off
 * the R2 binding. `ffmpeg` inside it reads `http://r2.local/<key>` the way it
 * reads any URL, so its own ranged reads survive — the measured 32.8% of a
 * video for one cover frame is what actually crosses.
 *
 * One key per run. What runs in that container is ffmpeg parsing bytes a user
 * uploaded, and a crafted file talking ffmpeg into fetching a different object
 * is the shape #215 records. The key is handed in when the run starts, and a
 * request for anything else is refused here rather than reaching R2.
 */

/** The hostname the container reads its object from. */
export const MEDIA_OBJECT_HOST = "r2.local";

/**
 * Where a `bytes=` header says to start reading.
 *
 * Only the start is read here. R2 resolves the rest — the closed, open-ended
 * and suffix shapes ffmpeg sends — and this one number is what tells an
 * unsatisfiable range from a satisfiable one, which R2 does not.
 * @param header - The Range header.
 * @returns The first byte asked for, or null when the header names no start.
 */
function startOf(header: string): number | null {
  const match = /^bytes=(\d+)-/.exec(header.trim());
  if (match === null) return null;
  return Number(match[1]);
}

/**
 * Answer one of the container's reads, for the one key it was started for.
 * @param request - What the container asked for.
 * @param bucket - The R2 binding, which is the only way in here to reach an
 *   object.
 * @param allowedKey - The key this run is about. Anything else is refused.
 * @returns The object, the requested range of it, or a refusal.
 */
export async function serveOneObject(
  request: Request,
  bucket: R2Bucket,
  allowedKey: string,
): Promise<Response> {
  // Where the path ends up, which is what the runtime hands over: it resolves
  // `..` before this is reached, so a request that traverses out of this key
  // arrives spelled as whatever it landed on and is refused on that name.
  const asked = decodeURIComponent(new URL(request.url).pathname).slice(1);
  if (asked !== allowedKey) {
    return new Response("Not this object", { status: 403 });
  }

  // The header goes to R2 whole, which reads the three shapes ffmpeg sends and
  // reports what it served — so the arithmetic has one implementation.
  const header = request.headers.get("range");
  const object = await bucket.get(allowedKey, {
    ...(header !== null && { range: request.headers }),
  });
  if (object === null || !("body" in object)) {
    return new Response("No such object", { status: 404 });
  }

  const served = object.range;
  const start = header === null ? null : startOf(header);
  // A start past the end is the one case R2 answers by serving everything
  // (measured). Saying so is what keeps a crafted index from turning one
  // frame's read into the whole file.
  if (start !== null && start >= object.size) {
    return new Response(null, {
      status: 416,
      headers: { "content-range": `bytes */${object.size}` },
    });
  }
  if (
    header === null ||
    served === undefined ||
    !("offset" in served) ||
    served.offset === undefined ||
    served.length === undefined
  ) {
    return new Response(object.body, {
      status: 200,
      headers: {
        "content-length": String(object.size),
        "accept-ranges": "bytes",
      },
    });
  }

  const last = served.offset + served.length - 1;
  return new Response(object.body, {
    status: 206,
    headers: {
      "content-length": String(served.length),
      "content-range": `bytes ${served.offset}-${last}/${object.size}`,
      "accept-ranges": "bytes",
    },
  });
}
