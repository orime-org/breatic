// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Local filesystem storage adapter.
 *
 * Stores files in uploads/ at the monorepo root.
 * Files are served via the /uploads/* static route in app.ts.
 */

import {
  mkdirSync,
  writeFileSync,
  statSync,
  openSync,
  readSync,
  closeSync,
  createWriteStream,
  renameSync,
  rmSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { finished } from "node:stream/promises";
import { resolve, dirname } from "node:path";
import { env, MONOREPO_ROOT } from "@core/config/env.js";
import type {
  StorageAdapter,
  ObjectHead,
  PersistedObject,
} from "@core/infra/storage/index.js";
import { downloadValidated, sha256Hex } from "@core/infra/storage/index.js";
import { sniffMimeType } from "@core/infra/storage/sniff-mime.js";

/**
 * Leading bytes read to sniff a stored file's content type. 4100 is
 * `file-type`'s recommended minimum window for magic-byte detection; the
 * content-aware fallback (SVG / text) needs far fewer.
 */
const SNIFF_BYTES = 4100;

/**
 * Abandons a partial upload, leaving nothing on disk.
 *
 * Destroying a write stream is asynchronous, and a file that has not finished
 * opening finishes opening afterwards — recreating whatever was removed in
 * between. Measured: aborting forty uploads without waiting left forty `.part`
 * files behind, every one of them appearing after the call had returned;
 * waiting for the close leaves none. The over-limit path reaches this soonest,
 * since the size check runs before the first write, so a single `await` is all
 * that separates opening the file from abandoning it — which a fast disk wins
 * and a slow one does not.
 * @param stream The write stream to abandon.
 * @param tempPath The partial file it was writing.
 */
async function discardPartial(
  stream: ReturnType<typeof createWriteStream>,
  tempPath: string,
): Promise<void> {
  stream.destroy();
  if (!stream.closed) await once(stream, "close");
  rmSync(tempPath, { force: true });
}

/** Storage adapter that persists files to the local filesystem. */
export class LocalStorageAdapter implements StorageAdapter {
  private readonly uploadDir: string;
  private readonly baseUrl: string;

  /**
   * Resolve the upload directory and public base URL, creating the
   * directory if it does not yet exist.
   */
  constructor() {
    // LOCAL_UPLOAD_DIR overrides; default = monorepo root /uploads
    const dir = env.LOCAL_UPLOAD_DIR || resolve(MONOREPO_ROOT, "uploads");
    this.uploadDir = resolve(dir);
    // UPLOAD_BASE_URL for CDN; fallback to local server
    this.baseUrl = env.UPLOAD_BASE_URL || `http://localhost:${env.PORT}/uploads`;

    mkdirSync(this.uploadDir, { recursive: true });
  }

  /**
   * Write binary data to disk under `key` and return its public URL.
   * @param key - the storage key (relative path under the upload dir)
   * @param data - the file bytes to write
   * @param _contentType - MIME type (unused by local storage; served via static route)
   * @returns the public URL serving the written file
   */
  async upload(key: string, data: Buffer, _contentType: string): Promise<string> {
    const filePath = resolve(this.uploadDir, key);
    mkdirSync(dirname(filePath), { recursive: true });
    // No retry (#1625 Slice 3): a local FS write failure (disk full, permission,
    // read-only mount) is not transient, so retrying would not help — fail fast.
    writeFileSync(filePath, data);

    const url = `${this.baseUrl}/${key}`;
    return url;
  }

  /**
   * Stream-write a request body to disk under `key`, aborting past `maxBytes`
   * WITHOUT buffering the whole body in memory (#1826, design §4.2 — the old
   * /local-upload `arrayBuffer()` OOM'd on a big file). On overflow the partial
   * file is removed and `{ ok: false, overLimit: true }` returned (the caller
   * maps it to 413); a clean write returns `{ ok: true, size }`.
   * @param key - the storage key (relative path under the upload dir)
   * @param body - the request body as a web ReadableStream
   * @param maxBytes - the hard byte cap (from storage config)
   * @returns the written byte size, or an over-limit sentinel
   * @throws {Error} on a filesystem write fault (overflow is a sentinel, not a throw)
   */
  async uploadStream(
    key: string,
    body: ReadableStream<Uint8Array>,
    maxBytes: number,
  ): Promise<{ ok: true; size: number } | { ok: false; overLimit: true }> {
    const filePath = resolve(this.uploadDir, key);
    mkdirSync(dirname(filePath), { recursive: true });
    // ATOMIC PUBLISH (Gate-2 R5 H9): stream into a sibling temp file and rename
    // on completion. The local protocol is two-hop (PUT then /uploaded) with no
    // "write finished" signal — /uploaded only checks head().exists — so an
    // object visible at its FINAL key from byte 0 can be registered while still
    // half-written, and the abort paths below then delete it, leaving a live
    // ledger row plus a node pinned to a 404. Renaming within the same
    // directory is atomic on POSIX and on Windows (same volume), so the key
    // appears only once the bytes are all there.
    const tempPath = `${filePath}.${randomUUID()}.part`;
    const ws = createWriteStream(tempPath);
    // createWriteStream emits 'error' ASYNCHRONOUSLY (ENOSPC / EACCES / a disk
    // fault). Without a PERSISTENT listener, an error fired while we are awaiting
    // `reader.read()` (not `ws`) is an unhandled 'error' event → the process
    // crashes. Capture it here; the loop + the post-write check re-raise it as a
    // thrown error the caller's catch cleans up.
    let streamError: Error | undefined;
    ws.on("error", (err: Error) => {
      streamError = err;
    });
    const reader = body.getReader();
    let size = 0;
    try {
      for (;;) {
        if (streamError) throw streamError;
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) {
          await discardPartial(ws, tempPath);
          return { ok: false, overLimit: true };
        }
        // Skip the drain await if the stream already errored (it would never
        // emit 'drain' — the next loop check re-raises streamError).
        if (!ws.write(value) && !streamError) await once(ws, "drain");
      }
      ws.end();
      await finished(ws);
      if (streamError) throw streamError;
      // Publish: the key becomes visible to head() exactly here, whole.
      renameSync(tempPath, filePath);
      return { ok: true, size };
    } catch (err) {
      await discardPartial(ws, tempPath);
      throw err;
    }
  }

  /**
   * Download a remote file and persist it to disk under `key`.
   * @param sourceUrl - the remote URL to download (120s timeout)
   * @param key - the storage key to write the downloaded file under
   * @returns the public URL serving the persisted file
   * @throws {Error} when the download fails, is truncated, or is empty
   */
  async persistFromUrl(sourceUrl: string, key: string): Promise<PersistedObject> {
    const { buffer, contentType } = await downloadValidated(sourceUrl);
    const url = await this.upload(key, buffer, contentType);
    return { url, sha256: sha256Hex(buffer), sizeBytes: buffer.length, contentType };
  }

  /**
   * Inspect a stored object's size, existence, and BACKEND-AUTHORITATIVE
   * content type by key. Unlike the old hardcoded `application/octet-stream`
   * (the #1825 root cause — every local upload's kind became 'file'), the type
   * is sniffed from the file's leading bytes (design §4.2), so a local image
   * gets kind='image', an SVG image gets 'image', a CSV gets 'document', etc.
   * @param key - the storage key to inspect
   * @returns the object metadata, with `exists: false` when the file is absent
   */
  async head(key: string): Promise<ObjectHead> {
    const filePath = resolve(this.uploadDir, key);
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(filePath);
    } catch {
      // Absent (or unreadable stat) — the storage sentinel for "not found".
      return { size: 0, contentType: "", exists: false };
    }
    return {
      size: stat.size,
      contentType: await this.sniffContentType(filePath, stat.size),
      exists: true,
    };
  }

  /**
   * Sniff the authoritative content type of an existing file from its leading
   * bytes. Degrades to `application/octet-stream` when the file is empty or a
   * read fault occurs — a sentinel, never a throw (head stays total).
   * @param filePath - absolute path to the stored file (already stat-confirmed)
   * @param size - the file's byte size (from stat)
   * @returns the sniffed MIME type, or `application/octet-stream` on empty/error
   */
  private async sniffContentType(filePath: string, size: number): Promise<string> {
    if (size === 0) return "application/octet-stream";
    let fd: number | undefined;
    try {
      fd = openSync(filePath, "r");
      const n = Math.min(SNIFF_BYTES, size);
      const buf = Buffer.alloc(n);
      readSync(fd, buf, 0, n, 0);
      return await sniffMimeType(buf);
    } catch {
      // A read fault (permissions / race) — degrade to the neutral type rather
      // than failing head(); the object still exists per the prior stat.
      return "application/octet-stream";
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  /**
   * Build the public URL for a storage key without touching the disk.
   * @param key - the storage key to build a URL for
   * @returns the public URL serving the key
   */
  publicUrl(key: string): string {
    return `${this.baseUrl}/${key}`;
  }

  /**
   * Whether `url` is one we served (starts with our public base).
   * @param url - the URL to test
   * @returns true when the URL points at an object in our storage
   */
  isOwnUrl(url: string): boolean {
    return url.startsWith(`${this.baseUrl}/`);
  }

  /**
   * Absolute filesystem path for a key (local-only helper).
   * @param key - the storage key to resolve to an absolute path
   * @returns the absolute filesystem path under the upload dir
   */
  getFilePath(key: string): string {
    return resolve(this.uploadDir, key);
  }
}
