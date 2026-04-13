/**
 * S3-compatible storage adapter (AWS S3, MinIO, Cloudflare R2).
 *
 * For persistFromUrl: downloads the file then uploads to S3.
 * S3 doesn't support server-side copy from external URLs.
 */

import { S3Client, PutObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "../../config/env.js";
import { logger } from "../../logger.js";
import type { StorageAdapter, ObjectHead } from "./index.js";

export class S3StorageAdapter implements StorageAdapter {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly region: string;

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
    logger.debug({ key, size: data.length, bucket: this.bucket }, "File uploaded to S3");
    return url;
  }

  async persistFromUrl(sourceUrl: string, key: string): Promise<string> {
    const response = await fetch(sourceUrl, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) {
      throw new Error(`Failed to download ${sourceUrl}: HTTP ${response.status}`);
    }

    const contentType = response.headers.get("content-type") ?? "application/octet-stream";
    const buffer = Buffer.from(await response.arrayBuffer());
    return this.upload(key, buffer, contentType);
  }

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
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- AWS SDK v3 @smithy/types version mismatch
    return getSignedUrl(this.client as never, command as never, { expiresIn: expiresSeconds });
  }

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

  publicUrl(key: string): string {
    const baseUrl = env.UPLOAD_BASE_URL || `https://${this.bucket}.s3.${this.region}.amazonaws.com`;
    return `${baseUrl}/${key}`;
  }
}
