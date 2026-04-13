/**
 * Aliyun OSS storage adapter.
 *
 * For persistFromUrl: uses OSS putStream or downloads then uploads.
 */

import OSS from "ali-oss";
import { env } from "../../config/env.js";
import { logger } from "../../logger.js";
import type { StorageAdapter, ObjectHead } from "./index.js";

export class AliyunOSSStorageAdapter implements StorageAdapter {
  private readonly client: OSS;
  private readonly bucket: string;

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

  async upload(key: string, data: Buffer, _contentType: string): Promise<string> {
    await this.client.put(key, data);
    // Use CDN base URL if configured, otherwise OSS direct URL
    const baseUrl = env.UPLOAD_BASE_URL || `${env.OSS_ENDPOINT}/${this.bucket}`;
    const url = `${baseUrl}/${key}`;
    logger.debug({ key, size: data.length, bucket: this.bucket }, "File uploaded to Aliyun OSS");
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
    return this.client.signatureUrl(key, {
      method: "PUT",
      expires: expiresSeconds,
      "Content-Type": contentType,
    });
  }

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

  publicUrl(key: string): string {
    const baseUrl = env.UPLOAD_BASE_URL || `${env.OSS_ENDPOINT}/${this.bucket}`;
    return `${baseUrl}/${key}`;
  }
}
