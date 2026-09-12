// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Storage adapter — unified interface for file persistence.
 *
 * One provider: Cloudflare R2, reached over the S3 API (#173, #174).
 *
 * Assets no longer arrive through here: an upload's bytes go to the ingest
 * Worker, which writes them to R2 and hashes what landed. A studio avatar is
 * the one thing whose bytes still pass through us into `upload`. The other two
 * callers never hand it bytes: the ingest report turns a storage key into the
 * URL a node gets pinned to, and the worker's dispatch asks whether a URL it
 * already holds is one of ours.
 */

import { newId } from "@breatic/shared";


/** Storage adapter interface. */
export interface StorageAdapter {
  /** Upload binary data and return a public URL. */
  upload(key: string, data: Buffer, contentType: string): Promise<string>;

  /**
   * Build the public URL for a storage key without fetching.
   * Used after a client direct upload to construct the asset URL.
   */
  publicUrl(key: string): string;

  /**
   * Whether `url` points at an object in our own bucket — it starts with the
   * public base every stored object is read back from.
   *
   * The worker's re-host step asks this before pulling a URL a provider
   * handed it. A local mini-tool's output and a sync-transport's buffer are
   * already in the bucket by the time it looks (both went through the ingest
   * Worker), so pulling them would store a second copy of what we have.
   */
  isOwnUrl(url: string): boolean;
}

// Singleton
let _adapter: StorageAdapter | null = null;

/**
 * Get the storage adapter singleton.
 *
 * Built lazily so importing this module never reads configuration: the client
 * is constructed the first time something stores or reads an object.
 * @returns the R2 adapter.
 * @throws {Error} When an R2 setting is missing.
 */
export async function getStorageAdapter(): Promise<StorageAdapter> {
  if (_adapter) return _adapter;

  // R2 speaks the S3 API, so the S3 client reaches it; what it needs is the
  // account-scoped endpoint the SDK cannot derive.
  const { S3StorageAdapter, r2ConfigFromEnv } = await import(
    "@core/infra/storage/s3.js"
  );
  _adapter = new S3StorageAdapter(r2ConfigFromEnv());

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
 * The key a stored object's cover frame is written to.
 *
 * Derived from the object rather than minted, so asking twice for one upload
 * names the same place. The request that asks for a cover is replay-safe and
 * is re-delivered; a fresh key per delivery would leave a second frame in
 * storage that no ledger row names and no reclaim list holds.
 *
 * It keeps the object's own task type and date, which is what makes it sit
 * beside what it was cut from and stay tenant-neutral.
 * @param objectKey - The key of the object the frame comes out of.
 * @returns The cover's key.
 */
export function coverKeyFor(objectKey: string): string {
  const lastSlash = objectKey.lastIndexOf("/");
  const dot = objectKey.indexOf(".", lastSlash + 1);
  const stem = dot === -1 ? objectKey : objectKey.slice(0, dot);
  return `${stem}_cover.png`;
}
