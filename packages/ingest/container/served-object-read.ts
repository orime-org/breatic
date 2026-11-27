// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * Reading a served object through a program that opens URLs itself (FFprobe, FFmpeg).
 *
 * FFmpeg's HTTP read exits 0 with the part it read when the connection drops: a moov-at-end MP4 probes without its
 * audio stream, a segment encodes short. Handing it the bytes on a pipe instead takes away its seeks, and that changes
 * its answers (an MP3's LAME end padding is no longer trimmed). So the program reads a loopback server of this process,
 * which serves exactly the one object with its length and byte ranges, fetches each asked range from the Worker,
 * resumes a dropped upstream answer with a Range request (the object is immutable), and counts each answer to its end: an
 * answer it cannot complete is cut off and fails the whole read, whatever the program's exit says.
 */

import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { PROBE_MAX_BYTES, probeArgs } from "@ingest/probe-command.js";
import { runTool } from "@ingest/container/run-tool.js";

/**
 * Run one read of a served object through a loopback server that keeps the reader's seeks and fails the read when any
 * of its answers cannot be completed.
 * @param url - Where the Worker serves the object.
 * @param signal - The read's lifetime; aborting it ends every upstream read.
 * @param read - The read, given the loopback URL to open with the `http,tcp` protocols.
 * @returns What the read returned.
 * @throws {Error} `The stream read failed: ...` when an answer could not be completed (an upstream answer that is not
 * the object or the asked range, or bytes that stop short and cannot resume), whatever the read returned.
 * @throws {unknown} What the read throws, otherwise.
 */
export async function readServedObject<T>(url: string, signal: AbortSignal, read: (localUrl: string) => Promise<T>): Promise<T> {
  let size = -1;
  let resumable = false;
  let failure: Error | null = null;
  const ended = new AbortController();
  const lifetime = AbortSignal.any([signal, ended.signal]);
  // The object keeps its path, whose extension (the upload's filename) FFmpeg's format probe weighs.
  const path = new URL(url).pathname;

  /**
   * Open the upstream object at one byte: the whole object first, which tells its length and whether it offers byte
   * ranges, then a Range request that must answer exactly the rest of the object.
   * @param at - The first byte wanted.
   * @param gone - Fires when the answer it feeds is closed by the reader.
   * @returns The upstream answer, its body starting at `at`.
   * @throws {Error} When the answer is not the whole object or the asked range, or the object offers no ranges past 0.
   */
  const open = async (at: number, gone: AbortSignal): Promise<Response> => {
    const ranged = size >= 0 && resumable;
    if (!ranged && at !== 0) throw new Error(`The stream read failed: the source cannot be read from byte ${at}`);
    const answered = await fetch(url, { signal: AbortSignal.any([lifetime, gone]), headers: ranged ? { range: `bytes=${at}-` } : {} });
    const length = answered.headers.get("content-length") ?? "";
    const whole = !ranged && answered.status === 200 && /^\d+$/u.test(length) && Number.isSafeInteger(Number(length)) && (size < 0 || Number(length) === size);
    const rest = ranged && answered.status === 206 && answered.headers.get("content-range") === `bytes ${at}-${size - 1}/${size}`;
    if (!whole && !rest) {
      await answered.body?.cancel();
      throw new Error(`The stream read failed: the source at byte ${at} was answered ${answered.status}`);
    }
    if (size < 0) {
      size = Number(length);
      resumable = answered.headers.get("accept-ranges") === "bytes";
    }
    return answered;
  };

  /**
   * Answer one request of the reader: the whole object, or the asked range when the object offers ranges, fed from
   * upstream answers until its last byte; a reader that closes early ends it without failing the read.
   * @param request - The reader's request.
   * @param response - Its answer.
   * @returns Nothing once the answer ends.
   */
  const serve = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const gone = new AbortController();
    response.on("close", () => gone.abort());
    let upstream: Response | null = null;
    try {
      if (size < 0) upstream = await open(0, gone.signal);
      const asked = resumable ? /^bytes=(\d+)-(\d*)$/u.exec(request.headers.range ?? "") : null;
      const start = asked === null ? 0 : Number(asked[1]);
      const stop = asked === null || asked[2] === "" ? size : Math.min(Number(asked[2]) + 1, size);
      if (asked !== null && (start >= size || stop <= start)) {
        await upstream?.body?.cancel();
        response.writeHead(416, { "content-range": `bytes */${size}` }).end();
        return;
      }
      if (upstream !== null && start !== 0) {
        await upstream.body?.cancel();
        upstream = null;
      }
      response.writeHead(asked === null ? 200 : 206, {
        "content-type": "application/octet-stream",
        "content-length": String(stop - start),
        ...(resumable && { "accept-ranges": "bytes" }),
        ...(asked !== null && { "content-range": `bytes ${start}-${stop - 1}/${size}` }),
      });
      if (request.method === "HEAD") {
        await upstream?.body?.cancel();
        response.end();
        return;
      }
      let at = start;
      while (at < stop) {
        const before = at;
        upstream ??= await open(at, gone.signal);
        try {
          if (upstream.body !== null) {
            for await (const chunk of upstream.body) {
              const part = chunk.byteLength > stop - at ? chunk.subarray(0, stop - at) : chunk;
              at += part.byteLength;
              if (!response.write(part)) await once(response, "drain", { signal: gone.signal });
              if (at === stop) break;
            }
          }
        } catch (error) {
          // A dropped upstream connection ends the body early; the count below decides whether it resumes or fails.
          if (gone.signal.aborted || lifetime.aborted) throw error;
        }
        upstream = null;
        // Each resumed answer has to bring bytes, so an upstream that keeps dropping at once ends the read.
        if (at < stop && (at === before || !resumable)) throw new Error(`The stream read failed: the source stopped at ${at} of ${size} bytes`);
      }
      response.end();
    } catch (error) {
      // The reader closing its own answer (a seek, or its exit) or the read's end is not a failed answer.
      if (!gone.signal.aborted && !lifetime.aborted) failure ??= error instanceof Error ? error : new Error(String(error));
      await upstream?.body?.cancel().catch(() => undefined);
      response.destroy();
    }
  };

  const server = createServer((request, response) => {
    if (request.url !== path || (request.method !== "GET" && request.method !== "HEAD")) {
      response.writeHead(404).end();
      return;
    }
    void serve(request, response);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  let value: T;
  try {
    value = await read(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`);
  } catch (error) {
    throw failure ?? error;
  } finally {
    ended.abort();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  if (failure !== null) throw failure;
  return value;
}

/**
 * Run the one probe of a served object (`probeArgs`), which the media read and the long-media probe both run first,
 * through the loopback reader: FFprobe's own read answers the part before a dropped connection (a JPEG 0 by 0 with no
 * frame, a moov-at-end MP4 without its audio stream) and exits 0.
 * @param objectUrl - Where the Worker serves the object.
 * @param signal - The probe's lifetime.
 * @returns FFprobe's JSON, or null when it failed or its read did not complete.
 */
export async function probeServedObject(objectUrl: string, signal: AbortSignal): Promise<Buffer | null> {
  try {
    return await readServedObject(objectUrl, signal, (local) => runTool("ffprobe", probeArgs(local), { maxBytes: PROBE_MAX_BYTES, signal }));
  } catch (err) {
    console.error("media_source_read_failed", { err: err instanceof Error ? err.message : String(err) });
    return null;
  }
}
