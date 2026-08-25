// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Storage adapter — unified interface for file persistence.
 *
 * Three providers:
 * - local: filesystem (default, downloads file to disk)
 * - s3: AWS S3 / MinIO / R2 (uploads buffer to S3)
 * - aliyun_oss: Alibaba Cloud OSS (uploads buffer to OSS)
 */

import { createHash } from "node:crypto";

import { newId, httpRequest } from "@breatic/shared";

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
   * Stream-write a request body to disk, aborting past `maxBytes` WITHOUT
   * buffering it all in memory (#1826, design §4.2). LOCAL ONLY — cloud
   * providers receive direct presigned PUTs (getUploadUrl), never a body
   * through our server. Returns the written size, or an over-limit sentinel
   * the caller maps to 413.
   * @param key - Storage key to write
   * @param body - Request body as a web ReadableStream
   * @param maxBytes - Hard byte cap (from storage config)
   */
  uploadStream?(
    key: string,
    body: ReadableStream<Uint8Array>,
    maxBytes: number,
  ): Promise<{ ok: true; size: number } | { ok: false; overLimit: true }>;

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
 * TENANT-NEUTRAL (#1826, design §3.1): the key carries NO `{userId}/{projectId}/`
 * prefix — a single format `{taskType}/{date}/{ts}_{uuid}{ext}`. Ownership is no
 * longer welded into the physical key (it leaked account topology + broke on
 * transfer); the upload-grant ledger is the authenticity authority instead.
 * @param opts - the key components (task type / extension)
 * @param opts.taskType - Task type (image, video, audio, tts, etc.)
 * @param opts.ext - File extension the CALLER must dot (".png", or a
 *   compound suffix like "_cover.png"), or "" for none — appended verbatim.
 *   A bare "png" throws: the caller owns the format (#1630).
 * @returns the unique storage key path for the object
 * @throws {Error} If `ext` is non-empty and contains no dot (bare extension).
 */
export function storageKey(opts: { taskType: string; ext: string }): string {
  // Extension contract (#1630): the caller passes a dotted extension
  // (".png"), a compound dotted suffix ("_cover.png"), or "" for none — it
  // is appended verbatim below. A bare "png" is a caller bug; fail fast
  // here (the single choke point every key flows through — upload / AIGC /
  // cover / local) instead of silently producing a dot-less
  // "..._<uuid>png". `includes('.')` (not startsWith) so compound suffixes
  // like "_cover.png" satisfy the contract.
  if (opts.ext !== "" && !opts.ext.includes(".")) {
    throw new Error(
      `storageKey: ext must be a dotted extension (e.g. ".png") or "", got "${opts.ext}"`,
    );
  }
  const date = new Date().toISOString().slice(0, 10);
  const filename = `${Date.now()}_${newId()}${opts.ext}`;
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

/**
 * Fetch the bytes, then check the transfer actually completed.
 *
 * Retrying is the transport's, declared by `replaySafe: true` — a download
 * is a pure GET, so a replay costs nothing and changes nothing. That
 * declaration also buys something the loop this replaced never had: a
 * dropped connection is retried. The old loop only recognised its own
 * `TransientDownloadError` (5xx / 429), and `fetch`'s connection errors are
 * not that, so exactly the failure most worth retrying went straight out.
 *
 * What stays here is the part that is about the CONTENT rather than the
 * transfer: whether these bytes are a complete asset.
 * @param sourceUrl - The remote URL to download (120s per delivery).
 * @returns The full downloaded bytes plus the resolved content type.
 * @throws {Error} On a non-ok status, a content-length mismatch
 *   (truncation), or a zero-byte body; or the transport's own failure when
 *   no delivery produced a response.
 */
async function downloadOnce(
  sourceUrl: string,
): Promise<{ buffer: Buffer; contentType: string }> {
  const response = await httpRequest(
    sourceUrl,
    {
      // Request an uncompressed transfer so content-length equals the bytes
      // we receive and the completeness check below actually validates the
      // wire (adversarial #B round-3: undici does NOT throw on a truncated
      // gzip/br stream — it silently returns the partial decoded bytes; an
      // identity transfer restores real truncation detection). If a server
      // ignores this and still encodes, the isEncoded fallback skips the
      // length check to avoid a false "truncated" on a complete body.
      headers: { "accept-encoding": "identity" },
    },
    { replaySafe: true, timeoutMs: 120_000 },
  );
  if (!response.ok) {
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
 * Transient failures are the transport's business now, declared through
 * `replaySafe: true` in `downloadOnce`: 5xx and 429 as before, and — new
 * here — a dropped connection, which the loop this replaced could never
 * retry because `fetch`'s connection errors are not the sentinel it keyed
 * on.
 *
 * Permanent failures still throw at once, for two different reasons. A 4xx
 * throws from the `!response.ok` branch: the transport already declined to
 * replay it, a 4xx being a fact about the request that a replay cannot
 * change. Truncation and zero-byte are thrown after a 200, where no retry
 * policy could reach them at all.
 * @param sourceUrl - The remote URL to download (120s per delivery).
 * @returns The full downloaded bytes plus the resolved content type.
 * @throws {Error} On a permanent failure, or when no delivery produced a
 *   response.
 */
export async function downloadValidated(
  sourceUrl: string,
): Promise<{ buffer: Buffer; contentType: string }> {
  return downloadOnce(sourceUrl);
}
