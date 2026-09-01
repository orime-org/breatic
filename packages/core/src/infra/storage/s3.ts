// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * S3-compatible storage adapter (AWS S3, MinIO, Cloudflare R2).
 *
 * One implementation, two configurations. What separates them is a pair of
 * addresses that must not be confused: the API endpoint, which answers only to
 * SigV4-signed requests, and the public base, which is what a browser fetches.
 * A URL built on the first is unreadable, and it is the URL that gets pinned
 * onto nodes and into node_history.
 *
 * For persistFromUrl: downloads the file then uploads. The S3 API has no
 * server-side copy from an external URL.
 */

import { S3Client, PutObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "@core/config/env.js";
import type {
  StorageAdapter,
  ObjectHead,
  PersistedObject,
} from "@core/infra/storage/index.js";
import { downloadValidated, sha256Hex } from "@core/infra/storage/index.js";

/** Everything needed to reach one S3-compatible bucket. */
export interface S3CompatibleConfig {
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /**
   * API endpoint, when the SDK cannot derive it. R2's is account-scoped rather
   * than regional, so leaving this out sends every write to an AWS hostname.
   */
  endpoint?: string;
  /** Where a stored object is read back from. Never the API endpoint. */
  publicBaseUrl: string;
}

/**
 * Read the AWS S3 configuration out of the environment.
 * @returns The bucket's configuration.
 * @throws {Error} When a required S3 variable is missing.
 */
export function s3ConfigFromEnv(): S3CompatibleConfig {
  const bucket = env.S3_BUCKET;
  const region = env.S3_REGION;
  if (!bucket || !env.S3_ACCESS_KEY || !env.S3_SECRET_KEY) {
    throw new Error(
      "S3 storage requires S3_BUCKET, S3_REGION, S3_ACCESS_KEY, S3_SECRET_KEY",
    );
  }
  return {
    bucket,
    region,
    accessKeyId: env.S3_ACCESS_KEY,
    secretAccessKey: env.S3_SECRET_KEY,
    // An AWS bucket is publicly addressable at its own regional hostname, so a
    // missing base is a plain default here rather than a broken URL.
    publicBaseUrl:
      env.UPLOAD_BASE_URL || `https://${bucket}.s3.${region}.amazonaws.com`,
  };
}

/**
 * Read the Cloudflare R2 configuration out of the environment.
 * @returns The bucket's configuration.
 * @throws {Error} When a required R2 variable is missing.
 */
export function r2ConfigFromEnv(): S3CompatibleConfig {
  const missing: string[] = [];
  if (!env.R2_BUCKET) missing.push("R2_BUCKET");
  if (!env.R2_ACCESS_KEY) missing.push("R2_ACCESS_KEY");
  if (!env.R2_SECRET_KEY) missing.push("R2_SECRET_KEY");
  if (!env.R2_S3_ENDPOINT) missing.push("R2_S3_ENDPOINT");
  // R2 has no regional hostname to fall back on, and the API endpoint needs a
  // signature on every request — so without this every stored object would be
  // pinned to a URL no browser can fetch.
  if (!env.UPLOAD_BASE_URL) missing.push("UPLOAD_BASE_URL");
  if (missing.length > 0) {
    throw new Error(`R2 storage requires ${missing.join(", ")}`);
  }
  return {
    bucket: env.R2_BUCKET,
    // R2 is a single region and the SDK still demands the field; "auto" is what
    // Cloudflare's own S3 API documentation uses.
    region: "auto",
    accessKeyId: env.R2_ACCESS_KEY,
    secretAccessKey: env.R2_SECRET_KEY,
    endpoint: env.R2_S3_ENDPOINT,
    publicBaseUrl: env.UPLOAD_BASE_URL,
  };
}

/** Storage adapter that persists files to an S3-compatible service. */
export class S3StorageAdapter implements StorageAdapter {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly publicBaseUrl: string;

  /**
   * Build the client for one S3-compatible bucket.
   * @param config - Where the bucket is and how to reach it.
   */
  constructor(config: S3CompatibleConfig) {
    this.bucket = config.bucket;
    this.publicBaseUrl = config.publicBaseUrl;

    this.client = new S3Client({
      region: config.region,
      ...(config.endpoint !== undefined && { endpoint: config.endpoint }),
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      // Pin the retry policy explicitly (#1625 Slice 3) — these are the aws-sdk
      // v3 defaults, made visible instead of implicit. "standard" mode retries
      // transient failures with exponential backoff + full jitter internally.
      maxAttempts: 3,
      retryMode: "standard",
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

    return `${this.publicBaseUrl}/${key}`;
  }

  /**
   * Download a remote file and upload it to S3 under `key`.
   * @param sourceUrl - the remote URL to download (120s timeout)
   * @param key - the S3 object key to store the file under
   * @returns the public URL of the uploaded object
   * @throws {Error} when the download fails, is truncated, or is empty
   */
  async persistFromUrl(sourceUrl: string, key: string): Promise<PersistedObject> {
    const { buffer, contentType } = await downloadValidated(sourceUrl);
    const url = await this.upload(key, buffer, contentType);
    return { url, sha256: sha256Hex(buffer), sizeBytes: buffer.length, contentType };
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
    return `${this.publicBaseUrl}/${key}`;
  }

  /**
   * Whether `url` points at an object in our S3 bucket / CDN base.
   * @param url - the URL to test
   * @returns true when the URL starts with our public base
   */
  isOwnUrl(url: string): boolean {
    return url.startsWith(`${this.publicBaseUrl}/`);
  }
}
