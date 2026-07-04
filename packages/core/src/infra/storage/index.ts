// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Storage adapter — unified interface for file persistence.
 *
 * Three providers:
 * - local: filesystem (default, downloads file to disk)
 * - s3: AWS S3 / MinIO / R2 (uploads buffer to S3)
 * - aliyun_oss: Alibaba Cloud OSS (uploads buffer to OSS)
 */

import { createHash } from "node:crypto";

import { newId } from "@breatic/shared";

import { env } from "@core/config/env.js";

/** Metadata returned by StorageAdapter.head() after a client upload. */
export interface ObjectHead {
  size: number;
  contentType: string;
  exists: boolean;
}

/** Result of persisting a remote URL: URL + content sha256 + byte size. */
export interface PersistedObject {
  url: string;
  sha256: string;
  sizeBytes: number;
  contentType: string;
}

/** Storage adapter interface. */
export interface StorageAdapter {
  /** Upload binary data and return a public URL. */
  upload(key: string, data: Buffer, contentType: string): Promise<string>;

  /**
   * Persist a file from a remote URL to our storage. Returns the
   * permanent URL plus the content's sha256 + byte size, computed on
   * the transfer stream (the bytes flow through here anyway, so hashing
   * costs no extra download). The asset layer uses the sha256 as its
   * dedup column (spec 2026-07-04-asset-layer-v1).
   *
   * - local: downloads to disk, serves via static route
   * - s3/oss: downloads then uploads to cloud storage
   */
  persistFromUrl(sourceUrl: string, key: string): Promise<PersistedObject>;

  /**
   * Generate a presigned PUT URL for client-side direct upload.
   *
   * Not supported by local storage — throws if called.
   * @param key - Storage key where the client will PUT the file
   * @param contentType - Expected MIME type
   * @param expiresSeconds - URL lifetime in seconds
   */
  getUploadUrl?(
    key: string,
    contentType: string,
    expiresSeconds: number,
  ): Promise<string>;

  /**
   * Inspect an object by key — used to verify an upload completed.
   * @returns `{ size, contentType, exists }`. If the object does not
   *          exist, `exists` is `false` and other fields are zero/empty.
   */
  head(key: string): Promise<ObjectHead>;

  /**
   * Build the public URL for a storage key without fetching.
   * Used after a client direct upload to construct the asset URL.
   */
  publicUrl(key: string): string;

  /**
   * Whether `url` points at an object THIS adapter owns (starts with our
   * storage's public base). Lets the worker's re-host step skip
   * re-downloading an object we already stored — a local mini-tool
   * handler uploads to our own bucket then returns our own URL, and a
   * sync-transport buffer output is uploaded here too; neither is an
   * external provider temp URL, so Case 2 must NOT re-host it
   * (adversarial round-2 #A + round-3: the old `/uploads/` substring only
   * recognized local storage, so cloud URLs fell through and got
   * re-downloaded / double-stored / — post no-swallow — failed on a blip).
   */
  isOwnUrl(url: string): boolean;
}

// Singleton
let _adapter: StorageAdapter | null = null;

/**
 * Get the configured storage adapter singleton.
 * @returns the adapter selected by `STORAGE_PROVIDER` (local / s3 / aliyun_oss)
 */
export async function getStorageAdapter(): Promise<StorageAdapter> {
  if (_adapter) return _adapter;

  switch (env.STORAGE_PROVIDER) {
    case "local": {
      const { LocalStorageAdapter } = await import("@core/infra/storage/local.js");
      _adapter = new LocalStorageAdapter();
      break;
    }
    case "s3": {
      const { S3StorageAdapter } = await import("@core/infra/storage/s3.js");
      _adapter = new S3StorageAdapter();
      break;
    }
    case "aliyun_oss": {
      const { AliyunOSSStorageAdapter } = await import("@core/infra/storage/oss.js");
      _adapter = new AliyunOSSStorageAdapter();
      break;
    }
  }

  return _adapter;
}

/**
 * Generate a unique storage key.
 *
 * Format (with user): {userId}/{projectId}/{taskType}/{date}/{unixtime}_{uuid}{ext}
 * Format (without user): {taskType}/{date}/{unixtime}_{uuid}{ext}
 * @param opts - the key components (user / project / task type / extension)
 * @param opts.userId - User ID (optional — omit for transport-level uploads)
 * @param opts.projectId - Project ID (defaults to "default")
 * @param opts.taskType - Task type (image, video, audio, tts, etc.)
 * @param opts.ext - File extension (e.g. ".png", ".mp4")
 * @returns the unique storage key path for the object
 */
export function storageKey(opts: {
  userId?: string;
  projectId?: string;
  taskType: string;
  ext: string;
}): string {
  const date = new Date().toISOString().slice(0, 10);
  const filename = `${Date.now()}_${newId()}${opts.ext}`;
  if (opts.userId) {
    const project = opts.projectId || "default";
    return `${opts.userId}/${project}/${opts.taskType}/${date}/${filename}`;
  }
  return `${opts.taskType}/${date}/${filename}`;
}

/**
 * Download from a temporary URL and persist to storage. Delegates to
 * the adapter's persistFromUrl(), which also returns the content sha256
 * + byte size (computed on the transfer stream) for the asset layer.
 * @param url - the temporary source URL to download from
 * @param key - the storage key to persist the object under
 * @returns the permanent URL + content sha256 + byte size + contentType
 */
export async function downloadAndStore(
  url: string,
  key: string,
): Promise<PersistedObject> {
  const adapter = await getStorageAdapter();
  return adapter.persistFromUrl(url, key);
}

/**
 * sha256 hex digest of a buffer — the asset layer's dedup key. Shared by
 * the storage adapters (URL transfer path) and the worker (local-buffer
 * path) so both compute the hash identically.
 * @param data - The bytes to hash.
 * @returns Lowercase hex sha256.
 */
export function sha256Hex(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** A download failure worth retrying (server 5xx / 429 — self-healing). */
class TransientDownloadError extends Error {}

/**
 * One download attempt with transfer-stream completeness guards.
 * @param sourceUrl - The remote URL to download (120s timeout).
 * @returns The full downloaded bytes plus the resolved content type.
 * @throws {TransientDownloadError} On HTTP 5xx / 429 (retryable).
 * @throws {Error} On HTTP 4xx, a content-length mismatch (truncation), or
 *   a zero-byte body (permanent — not retried).
 */
async function downloadOnce(
  sourceUrl: string,
): Promise<{ buffer: Buffer; contentType: string }> {
  const response = await fetch(sourceUrl, {
    signal: AbortSignal.timeout(120_000),
    // Request an uncompressed transfer so content-length equals the bytes
    // we receive and the completeness check below actually validates the
    // wire (adversarial #B round-3: undici does NOT throw on a truncated
    // gzip/br stream — it silently returns the partial decoded bytes; an
    // identity transfer restores real truncation detection). If a server
    // ignores this and still encodes, the isEncoded fallback skips the
    // length check to avoid a false "truncated" on a complete body.
    headers: { "accept-encoding": "identity" },
  });
  if (!response.ok) {
    if (response.status >= 500 || response.status === 429) {
      throw new TransientDownloadError(
        `Download ${sourceUrl}: HTTP ${response.status}`,
      );
    }
    throw new Error(`Failed to download ${sourceUrl}: HTTP ${response.status}`);
  }
  const contentType =
    response.headers.get("content-type") ?? "application/octet-stream";
  const buffer = Buffer.from(await response.arrayBuffer());
  // content-length is the COMPRESSED size when the body is content-encoded
  // (fetch/undici auto-decompresses), so it will not equal the decoded
  // buffer length — only assert equality for unencoded responses
  // (adversarial #B: a gzip/br response must not read as "truncated").
  const encoding = response.headers.get("content-encoding");
  const isEncoded = encoding !== null && encoding.toLowerCase() !== "identity";
  const declared = response.headers.get("content-length");
  if (!isEncoded && declared !== null && Number(declared) !== buffer.length) {
    throw new Error(
      `Truncated download ${sourceUrl}: content-length ${declared} != received ${buffer.length} bytes`,
    );
  }
  if (buffer.length === 0) {
    throw new Error(`Empty download ${sourceUrl}: received 0 bytes`);
  }
  return { buffer, contentType };
}

/**
 * Download a remote file with transfer-stream completeness guards, shared
 * by every StorageAdapter.persistFromUrl. A silently-truncated or empty
 * response must NOT be hashed / stored / registered / billed as a
 * complete asset (asset-layer adversarial holes #3 truncation / #5
 * zero-byte): it throws so the worker's Stage-2 persist path fails the
 * task (markFailed + no charge) instead of storing wrong content.
 *
 * Server-side transient failures (HTTP 5xx / 429, common self-healing CDN
 * blips) are retried up to `maxAttempts` with linear backoff — the
 * re-fetch is idempotent (re-download → re-upload under a fresh key), and
 * job-level retry is fenced off after the provider call, so this is the
 * correct resilience layer (adversarial #E). Permanent failures (HTTP 4xx,
 * truncation, zero-byte) throw immediately without retry.
 * @param sourceUrl - The remote URL to download (120s timeout per attempt).
 * @param opts - Retry tuning (defaults: 3 attempts, 500ms linear backoff).
 * @param opts.maxAttempts - Total attempts including the first.
 * @param opts.retryBackoffMs - Base backoff (multiplied by attempt number).
 * @returns The full downloaded bytes plus the resolved content type.
 * @throws {Error} On a permanent failure, or after exhausting retries.
 */
export async function downloadValidated(
  sourceUrl: string,
  opts?: { maxAttempts?: number; retryBackoffMs?: number },
): Promise<{ buffer: Buffer; contentType: string }> {
  const maxAttempts = opts?.maxAttempts ?? 3;
  const backoffMs = opts?.retryBackoffMs ?? 500;
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      return await downloadOnce(sourceUrl);
    } catch (err) {
      const retryable = err instanceof TransientDownloadError;
      if (!retryable || attempt >= maxAttempts) throw err;
      await new Promise((resolve) => setTimeout(resolve, backoffMs * attempt));
    }
  }
}
