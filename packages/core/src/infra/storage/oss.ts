// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Aliyun OSS storage adapter.
 *
 * For persistFromUrl: uses OSS putStream or downloads then uploads.
 */

import OSS from "ali-oss";
import { env } from "@core/config/env.js";
import type { StorageAdapter, ObjectHead } from "@core/infra/storage/index.js";

/** Storage adapter that persists files to Alibaba Cloud OSS. */
export class AliyunOSSStorageAdapter implements StorageAdapter {
  private readonly client: OSS;
  private readonly bucket: string;

  /**
   * Validate the required OSS credentials and build the OSS client.
   * @throws {Error} when any required OSS env var is missing
   */
  constructor() {
    this.bucket = env.OSS_BUCKET;

    if (!this.bucket || !env.OSS_ENDPOINT || !env.OSS_ACCESS_KEY || !env.OSS_SECRET_KEY) {
      throw new Error("Aliyun OSS requires OSS_BUCKET, OSS_ENDPOINT, OSS_ACCESS_KEY, OSS_SECRET_KEY");
    }

    this.client = new OSS({
      bucket: this.bucket,
      endpoint: env.OSS_ENDPOINT,
      accessKeyId: env.OSS_ACCESS_KEY,
      accessKeySecret: env.OSS_SECRET_KEY,
    });
  }

  /**
   * Upload binary data to OSS under `key` and return its public URL.
   * @param key - the OSS object key
   * @param data - the file bytes to upload
   * @param _contentType - MIME type (unused; OSS infers it)
   * @returns the public (CDN or OSS-direct) URL of the object
   */
  async upload(key: string, data: Buffer, _contentType: string): Promise<string> {
    await this.client.put(key, data);
    // Use CDN base URL if configured, otherwise OSS direct URL
    const baseUrl = env.UPLOAD_BASE_URL || `${env.OSS_ENDPOINT}/${this.bucket}`;
    const url = `${baseUrl}/${key}`;
    return url;
  }

  /**
   * Download a remote file and upload it to OSS under `key`.
   * @param sourceUrl - the remote URL to download (120s timeout)
   * @param key - the OSS object key to store the file under
   * @returns the public URL of the uploaded object
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
   * Generate a presigned PUT URL for client-side direct upload.
   * @param key - the OSS object key the client will PUT to
   * @param contentType - the expected MIME type the client must send
   * @param expiresSeconds - the URL lifetime in seconds
   * @returns the presigned PUT URL
   */
  async getUploadUrl(
    key: string,
    contentType: string,
    expiresSeconds: number,
  ): Promise<string> {
    return this.client.signatureUrl(key, {
      method: "PUT",
      expires: expiresSeconds,
      "Content-Type": contentType,
    });
  }

  /**
   * Inspect an OSS object's size and content type by key.
   * @param key - the OSS object key to inspect
   * @returns the object metadata, with `exists: false` on a 404 / NoSuchKey
   * @throws {Error} when the OSS head request fails for a reason other than not-found
   */
  async head(key: string): Promise<ObjectHead> {
    try {
      const result = await this.client.head(key);
      const headers = (result.res?.headers ?? {}) as Record<string, string | undefined>;
      const size = Number(headers["content-length"] ?? 0);
      const contentType = headers["content-type"] ?? "application/octet-stream";
      return { size, contentType, exists: true };
    } catch (err) {
      const e = err as { status?: number; code?: string };
      if (e.status === 404 || e.code === "NoSuchKey") {
        return { size: 0, contentType: "", exists: false };
      }
      throw err;
    }
  }

  /**
   * Build the public URL for an OSS key without fetching.
   * @param key - the OSS object key to build a URL for
   * @returns the public (CDN or OSS-direct) URL for the key
   */
  publicUrl(key: string): string {
    const baseUrl = env.UPLOAD_BASE_URL || `${env.OSS_ENDPOINT}/${this.bucket}`;
    return `${baseUrl}/${key}`;
  }
}
