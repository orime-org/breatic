// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Serving a stored object into the browser's own download list.
 *
 * The list is reached one way only: an answer carrying
 * `Content-Disposition: attachment`. The `download` attribute on a link is
 * dropped whenever the href is cross-origin, and every stored object is — the
 * bucket answers on its own hostname. So the header has to come from whoever
 * serves the bytes, and that is here.
 *
 * The name rides in the last path segment rather than in a query string, so an
 * answer is addressed the same way an object is, and a client that strips the
 * header still saves the file under the name the URL ends with.
 */

/**
 * Characters RFC 5987 §3.2.1 leaves out of `attr-char` that
 * `encodeURIComponent` does not escape.
 */
const NOT_ATTR_CHAR = /['()*!]/g;

/**
 * `/download/{key}/{filename}`. The key itself holds slashes, so the greedy
 * first group takes everything up to the last one and the name is what
 * follows — which is also what a browser falls back to when no header names
 * the file.
 */
const DOWNLOAD_PATH = /^\/download\/(.+)\/([^/]+)$/;

/**
 * What a download URL names, or null when this is not one.
 *
 * Each path segment is decoded on its own. Decoding the key whole would turn
 * an escaped slash inside one segment into a separator, which names a
 * different object than the caller asked for.
 * @param pathname - The request's path.
 * @returns The key and the filename, or null.
 */
export function downloadTarget(
  pathname: string,
): { key: string; filename: string } | null {
  const matched = DOWNLOAD_PATH.exec(pathname);
  if (matched === null) return null;
  try {
    const key = (matched[1] ?? "").split("/").map(decodeURIComponent).join("/");
    // A name is one segment by construction, so anything that decodes into a
    // separator was written to look like one; it is a name here either way.
    const filename = decodeURIComponent(matched[2] ?? "").replace(/[/\\]/g, "_");
    return { key, filename };
  } catch {
    // A malformed percent sequence. Nothing in it names an object, and the
    // caller wrote the URL.
    return null;
  }
}

/**
 * A filename as `filename*` takes it.
 *
 * Percent-encoded whole, which is what makes a name in any language work and
 * what makes a header out of one impossible to break: a quote, a newline or a
 * semicolon in the name leaves here as `%22`, `%0A`, `%3B`.
 * @param name - The name the URL ended with, already decoded.
 * @returns The encoded name.
 */
function encodedFilename(name: string): string {
  return encodeURIComponent(name).replace(
    NOT_ATTR_CHAR,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * Where a ranged read starts and ends.
 *
 * R2 reports the range it served in three shapes, and `Content-Range` states
 * one: the first and last byte against the whole object's size. `size` is the
 * object's, not the range's, which is what the last field needs.
 * @param range - What R2 says it served.
 * @param size - The whole object's size.
 * @returns The first and last byte, both inclusive.
 */
function servedBytes(
  range: R2Range,
  size: number,
): { first: number; last: number } {
  // Read off the values, not the keys. R2 hands back an object carrying all
  // three names with the unused ones undefined, so `"suffix" in range` is true
  // of every range it ever answers.
  const { offset, length, suffix } = range as {
    offset?: number;
    length?: number;
    suffix?: number;
  };
  if (typeof suffix === "number") {
    return { first: Math.max(0, size - suffix), last: size - 1 };
  }
  const first = offset ?? 0;
  const span = length ?? size - first;
  return { first, last: Math.min(size - 1, first + span - 1) };
}

/**
 * The headers every download answer carries.
 *
 * `writeHttpMetadata` first, so the type the object was stored under is what
 * goes out; the disposition is set afterwards because an object carrying one
 * of its own would otherwise decide this.
 * @param object - What R2 answered with.
 * @param filename - The name to save it under.
 * @returns The headers.
 */
function downloadHeaders(object: R2Object, filename: string): Headers {
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  // Announced on every answer, not only ranged ones: a download that was
  // paused resumes by asking for the rest, and a client only asks when it was
  // told it may.
  headers.set("accept-ranges", "bytes");
  headers.set(
    "content-disposition",
    `attachment; filename*=UTF-8''${encodedFilename(filename)}`,
  );
  return headers;
}

/**
 * Answer one download.
 *
 * Reads are all this does: the object is whatever the key names, served as it
 * stands. Which keys exist and who may know one is settled where the key was
 * minted — the same bucket answers these objects on its public domain, so
 * nothing is reachable here that was not reachable there.
 * @param request - The browser's request.
 * @param bucket - The bucket binding.
 * @param key - The object's key.
 * @param filename - The name to save it under.
 * @returns The object, or why it could not be served.
 */
export async function serveDownload(
  request: Request,
  bucket: R2Bucket,
  key: string,
  filename: string,
): Promise<Response> {
  if (request.method === "HEAD") {
    const head = await bucket.head(key);
    if (head === null) return new Response("Not found", { status: 404 });
    return new Response(null, {
      status: 200,
      headers: downloadHeaders(head, filename),
    });
  }

  if (request.method !== "GET") {
    return new Response("Method not allowed", {
      status: 405,
      headers: { allow: "GET, HEAD" },
    });
  }

  // The request's own headers are handed to R2 whole: it reads `Range` and the
  // conditional headers off them itself, which is how a resumed download and a
  // revalidation are served without this file restating either format.
  const object = await bucket.get(key, {
    range: request.headers,
    onlyIf: request.headers,
  });
  if (object === null) return new Response("Not found", { status: 404 });

  const headers = downloadHeaders(object, filename);

  // No body means the conditions the request carried were not met — the copy
  // it already holds is current.
  if (!("body" in object)) {
    return new Response(null, { status: 304, headers });
  }

  // Whether this is a partial answer is decided by what was asked, not by what
  // R2 reports: it describes a range on every object it returns, the whole of
  // it when nobody asked for less, so reading the answer would make 206 the
  // status of every download.
  if (request.headers.get("range") !== null && object.range !== undefined) {
    const { first, last } = servedBytes(object.range, object.size);
    headers.set("content-range", `bytes ${first}-${last}/${object.size}`);
    return new Response(object.body, { status: 206, headers });
  }

  return new Response(object.body, { status: 200, headers });
}
