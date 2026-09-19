// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Cloudflare R2, reached over its S3-compatible API.
 *
 * The configuration carries a pair of addresses that must not be confused: the
 * API endpoint, which answers only to SigV4-signed requests, and the public
 * base, which is what a browser fetches. A URL built on the first is
 * unreadable, and it is the URL that gets pinned onto nodes and into
 * node_history.
 */

import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { env } from "@core/config/env.js";
import type { StorageAdapter } from "@core/infra/storage/index.js";

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
   * Build the public URL for an S3 key without fetching.
   * @param key - the S3 object key to build a URL for
   * @returns the public (CDN or S3-direct) URL for the key
   */
  publicUrl(key: string): string {
    return `${this.publicBaseUrl}/${key}`;
  }

  /**
   * The key `url` names, or null when it names nothing of ours.
   *
   * The prefix that decides whether a URL is ours is the same one that has to
   * come off to leave the key, so both answers are read here. Two functions
   * each holding their own copy of it disagree the moment the base carries a
   * path or a trailing slash — and a key stripped wrong reaches the bucket as
   * a miss with nothing in it to trace back.
   * @param url - The URL to read.
   * @returns The object's key, or null.
   */
  keyFromUrl(url: string): string | null {
    const prefix = `${this.publicBaseUrl}/`;
    if (!url.startsWith(prefix)) return null;
    const key = url.slice(prefix.length);
    return key === "" ? null : key;
  }

}
