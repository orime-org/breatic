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

export class LocalStorageAdapter implements StorageAdapter {
  private readonly uploadDir: string;
  private readonly baseUrl: string;

  constructor() {
    // LOCAL_UPLOAD_DIR overrides; default = monorepo root /uploads
    const dir = env.LOCAL_UPLOAD_DIR || resolve(MONOREPO_ROOT, "uploads");
    this.uploadDir = resolve(dir);
    // UPLOAD_BASE_URL for CDN; fallback to local server
    this.baseUrl = env.UPLOAD_BASE_URL || `http://localhost:${env.PORT}/uploads`;

    mkdirSync(this.uploadDir, { recursive: true });
  }

  async upload(key: string, data: Buffer, _contentType: string): Promise<string> {
    const filePath = resolve(this.uploadDir, key);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, data);

    const url = `${this.baseUrl}/${key}`;
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

  publicUrl(key: string): string {
    return `${this.baseUrl}/${key}`;
  }

  /** Absolute filesystem path for a key (local-only helper). */
  getFilePath(key: string): string {
    return resolve(this.uploadDir, key);
  }
}
