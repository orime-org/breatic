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

import { GetObjectCommand, NoSuchKey, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { env } from "@core/config/env.js";
import { ObjectMissing, ObjectTooLarge } from "@core/infra/storage/errors.js";
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
   * Read at most `maxBytes` of an object. Asks for one byte more than that
   * with a Range, so an object holding exactly `maxBytes` is told apart from
   * a larger one without reading the rest of it.
   * @param key - The object's key.
   * @param maxBytes - The most bytes the caller takes.
   * @returns The object's bytes.
   * @throws {ObjectTooLarge} When the object holds more than `maxBytes`.
   * @throws {ObjectMissing} When no object is stored under the key.
   */
  async read(key: string, maxBytes: number): Promise<Uint8Array> {
    let bytes: Uint8Array;
    try {
      const out = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key, Range: `bytes=0-${maxBytes}` }),
      );
      bytes = (await out.Body?.transformToByteArray()) ?? new Uint8Array(0);
    } catch (err) {
      if (err instanceof NoSuchKey) throw new ObjectMissing(key);
      throw err;
    }
    if (bytes.length > maxBytes) throw new ObjectTooLarge(key);
    return bytes;
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
   * Source authorization and re-hosting share this classification. Equivalent
   * origins and view-only query parameters must resolve to the same object.
   * @param url - The URL to read.
   * @returns The object's key, or null.
   * @throws {never} Invalid addresses do not name a stored object.
   */
  keyFromUrl(url: string): string | null {
    const source = URL.parse(url);
    const base = URL.parse(`${this.publicBaseUrl}/`);
    if (source === null || base === null || source.origin !== base.origin || !source.pathname.startsWith(base.pathname)) return null;
    const key = source.pathname.slice(base.pathname.length);
    return key === "" ? null : key;
  }

}
