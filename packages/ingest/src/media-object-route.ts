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

/** What a Range header asked for, resolved against a known object size. */
interface ResolvedRange {
  offset: number;
  length: number;
}

/**
 * Read one `bytes=` range against an object of known size.
 *
 * The three shapes ffmpeg sends: a closed range, an open-ended one, and a
 * suffix. Anything else reads as no range at all, which serves the whole
 * object — the same answer a caller that sent no header gets.
 * @param header - The Range header, when one was sent.
 * @param size - The stored object's size.
 * @returns The resolved range, or null to serve the whole object.
 */
function resolveRange(
  header: string | null,
  size: number,
): ResolvedRange | null {
  if (header === null) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (match === null) return null;
  const [, rawStart = "", rawEnd = ""] = match;
  if (rawStart === "" && rawEnd === "") return null;
  if (rawStart === "") {
    // A suffix range: the last N bytes, which is how ffmpeg finds an index
    // stored at the end of a container format.
    const wanted = Number(rawEnd);
    if (wanted <= 0) return null;
    const offset = Math.max(0, size - wanted);
    return { offset, length: size - offset };
  }
  const offset = Number(rawStart);
  if (offset >= size) return null;
  const end = rawEnd === "" ? size - 1 : Math.min(Number(rawEnd), size - 1);
  return { offset, length: end - offset + 1 };
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

  const head = await bucket.head(allowedKey);
  if (head === null) return new Response("No such object", { status: 404 });

  const range = resolveRange(request.headers.get("range"), head.size);
  const object = await bucket.get(
    allowedKey,
    range === null ? undefined : { range },
  );
  if (object === null) return new Response("No such object", { status: 404 });

  if (range === null) {
    return new Response(object.body, {
      status: 200,
      headers: {
        "content-length": String(head.size),
        "accept-ranges": "bytes",
      },
    });
  }
  const last = range.offset + range.length - 1;
  return new Response(object.body, {
    status: 206,
    headers: {
      "content-length": String(range.length),
      "content-range": `bytes ${range.offset}-${last}/${head.size}`,
      "accept-ranges": "bytes",
    },
  });
}
