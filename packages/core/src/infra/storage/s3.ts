// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * S3-compatible storage adapter (AWS S3, MinIO, Cloudflare R2).
 *
 * For persistFromUrl: downloads the file then uploads to S3.
 * S3 doesn't support server-side copy from external URLs.
 */

import { S3Client, PutObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "@core/config/env.js";
import type { StorageAdapter, ObjectHead } from "@core/infra/storage/index.js";

/** Storage adapter that persists files to an S3-compatible service. */
export class S3StorageAdapter implements StorageAdapter {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly region: string;

  /**
   * Validate the required S3 credentials and build the S3 client.
   * @throws {Error} when any required S3 env var is missing
   */
  constructor() {
    this.bucket = env.S3_BUCKET;
    this.region = env.S3_REGION;

    if (!this.bucket || !env.S3_ACCESS_KEY || !env.S3_SECRET_KEY) {
      throw new Error("S3 storage requires S3_BUCKET, S3_REGION, S3_ACCESS_KEY, S3_SECRET_KEY");
    }

    this.client = new S3Client({
      region: this.region,
      credentials: {
        accessKeyId: env.S3_ACCESS_KEY,
        secretAccessKey: env.S3_SECRET_KEY,
      },
    });
  }

  /**
   * Upload binary data to S3 under `key` and return its public URL.
   * @param key - the S3 object key
   * @param data - the file bytes to upload
   * @param contentType - the MIME type stored as the object's Content-Type
   * @returns the public (CDN or S3-direct) URL of the object
   */
  async upload(key: string, data: Buffer, contentType: string): Promise<string> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: data,
        ContentType: contentType,
      }),
    );

    // Use CDN base URL if configured, otherwise S3 direct URL
    const baseUrl = env.UPLOAD_BASE_URL || `https://${this.bucket}.s3.${this.region}.amazonaws.com`;
    const url = `${baseUrl}/${key}`;
    return url;
  }

  /**
   * Download a remote file and upload it to S3 under `key`.
   * @param sourceUrl - the remote URL to download (120s timeout)
   * @param key - the S3 object key to store the file under
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
   * @param key - the S3 object key the client will PUT to
   * @param contentType - the expected MIME type the client must send
   * @param expiresSeconds - the URL lifetime in seconds
   * @returns the presigned PUT URL
   */
  async getUploadUrl(
    key: string,
    contentType: string,
    expiresSeconds: number,
  ): Promise<string> {
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: contentType,
    });
     
    return getSignedUrl(this.client as never, command as never, { expiresIn: expiresSeconds });
  }

  /**
   * Inspect an S3 object's size and content type by key.
   * @param key - the S3 object key to inspect
   * @returns the object metadata, with `exists: false` on a 404 / NotFound
   * @throws {Error} when the S3 head request fails for a reason other than not-found
   */
  async head(key: string): Promise<ObjectHead> {
    try {
      const result = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return {
        size: result.ContentLength ?? 0,
        contentType: result.ContentType ?? "application/octet-stream",
        exists: true,
      };
    } catch (err) {
      const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
      if (e.name === "NotFound" || e.$metadata?.httpStatusCode === 404) {
        return { size: 0, contentType: "", exists: false };
      }
      throw err;
    }
  }

  /**
   * Build the public URL for an S3 key without fetching.
   * @param key - the S3 object key to build a URL for
   * @returns the public (CDN or S3-direct) URL for the key
   */
  publicUrl(key: string): string {
    const baseUrl = env.UPLOAD_BASE_URL || `https://${this.bucket}.s3.${this.region}.amazonaws.com`;
    return `${baseUrl}/${key}`;
  }
}
