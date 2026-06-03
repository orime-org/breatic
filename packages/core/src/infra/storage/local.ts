// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Local filesystem storage adapter.
 *
 * Stores files in uploads/ at the monorepo root.
 * Files are served via the /uploads/* static route in app.ts.
 */

import { mkdirSync, writeFileSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { env, MONOREPO_ROOT } from "@core/config/env.js";
import type { StorageAdapter, ObjectHead } from "@core/infra/storage/index.js";

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
    writeFileSync(filePath, data);

    const url = `${this.baseUrl}/${key}`;
    return url;
  }

  /**
   * Download a remote file and persist it to disk under `key`.
   * @param sourceUrl - the remote URL to download (120s timeout)
   * @param key - the storage key to write the downloaded file under
   * @returns the public URL serving the persisted file
   * @throws {Error} when the source URL responds with a non-OK status
   */
  async persistFromUrl(sourceUrl: string, key: string): Promise<string> {
    const response = await fetch(sourceUrl, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) {
      throw new Error(`Failed to download ${sourceUrl}: HTTP ${response.status}`);
    }

    const contentType = response.headers.get("content-type") ?? "application/octet-stream";
    const buffer = Buffer.from(await response.arrayBuffer());
    return this.upload(key, buffer, contentType);
  }

  /**
   * Inspect a stored object's size and existence by key.
   * @param key - the storage key to inspect
   * @returns the object metadata, with `exists: false` when the file is absent
   */
  async head(key: string): Promise<ObjectHead> {
    const filePath = resolve(this.uploadDir, key);
    try {
      const stat = statSync(filePath);
      return {
        size: stat.size,
        contentType: "application/octet-stream",
        exists: true,
      };
    } catch {
      return { size: 0, contentType: "", exists: false };
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
   * Absolute filesystem path for a key (local-only helper).
   * @param key - the storage key to resolve to an absolute path
   * @returns the absolute filesystem path under the upload dir
   */
  getFilePath(key: string): string {
    return resolve(this.uploadDir, key);
  }
}
