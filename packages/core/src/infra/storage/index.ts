// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Storage adapter — unified interface for file persistence.
 *
 * Four providers:
 * - local: filesystem (default, downloads file to disk)
 * - s3: AWS S3 / MinIO (uploads buffer to S3)
 * - aliyun_oss: Alibaba Cloud OSS (uploads buffer to OSS)
 * - r2: Cloudflare R2 over the S3 API, which is where assets live (#173)
 *
 * Assets no longer arrive through here: an upload's bytes go to the ingest
 * Worker, which writes them to R2 and hashes what landed. What still calls the
 * adapter is a studio avatar and, under the local provider, the endpoint the
 * browser puts straight to this server.
 */

import { newId } from "@breatic/shared";

import { env } from "@core/config/env.js";

/** Metadata returned by StorageAdapter.head() after a client upload. */
export interface ObjectHead {
  size: number;
  contentType: string;
  exists: boolean;
}

/** Storage adapter interface. */
export interface StorageAdapter {
  /** Upload binary data and return a public URL. */
  upload(key: string, data: Buffer, contentType: string): Promise<string>;

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
 * @returns the adapter selected by `STORAGE_PROVIDER` (local / s3 / aliyun_oss / r2)
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
      const { S3StorageAdapter, s3ConfigFromEnv } = await import(
        "@core/infra/storage/s3.js"
      );
      _adapter = new S3StorageAdapter(s3ConfigFromEnv());
      break;
    }
    case "aliyun_oss": {
      const { AliyunOSSStorageAdapter } = await import("@core/infra/storage/oss.js");
      _adapter = new AliyunOSSStorageAdapter();
      break;
    }
    case "r2": {
      // R2 speaks the S3 API, so the same client reaches it; what it needs is
      // the account-scoped endpoint the SDK cannot derive.
      const { S3StorageAdapter, r2ConfigFromEnv } = await import(
        "@core/infra/storage/s3.js"
      );
      _adapter = new S3StorageAdapter(r2ConfigFromEnv());
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
