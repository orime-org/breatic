// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Direct R2 API operations exposed exclusively to the maintenance executor.
 */
import { DeleteObjectCommand, HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { r2ConfigFromEnv, type S3CompatibleConfig } from "@core/infra/storage/s3.js";

/**
 * Minimal exact-key physical executor port.
 */
export interface MaintenanceStorage {
  head(key: string): Promise<"missing" | "present">;
  delete(key: string): Promise<void>;
  /** Release the maintenance client at graceful shutdown. */
  close?(): void;
}

/** A direct DELETE can fail definitively or leave its physical outcome unknown. */
export class MaintenanceDeleteError extends Error {
  /**
   * Wrap a storage exception without treating a timeout as a failed deletion.
   * @param uncertain - Whether the remote call may still finish.
   * @param cause - Original SDK failure for application logging.
   */
  constructor(readonly uncertain: boolean, cause: unknown) {
    super("maintenance_delete_failed", {
      cause
    });
    this.name = "MaintenanceDeleteError";
  }
}

/**
 * Build direct signed HEAD/DELETE operations; no CDN or suffix expansion.
 * @param timeoutMs - Deadline for each physical API call.
 * @param config - Explicit compatible endpoint, or the production R2 environment.
 * @returns Maintenance-only storage operations.
 * @throws {Error} When R2 credentials are absent.
 */
export function createR2MaintenanceStorage(timeoutMs: number, config:S3CompatibleConfig=r2ConfigFromEnv()): MaintenanceStorage {
  const client = new S3Client({
    region: config.region, endpoint: config.endpoint, credentials: {
      accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey
    }, maxAttempts: 1, retryMode: "standard"
  });
  return {
    close():void {client.destroy();},
    async head(key: string): Promise<"missing" | "present"> {
      try {
        await client.send(new HeadObjectCommand({
          Bucket: config.bucket, Key: key
        }), {
          abortSignal: AbortSignal.timeout(timeoutMs)
        });
        return "present";
      }
      catch (err) {
        if (typeof err === "object" && err !== null && "$metadata" in err && (err.$metadata as {
          httpStatusCode?: number;
        }).httpStatusCode === 404)
          return "missing";
        throw err;
      }
    },
    async delete(key: string): Promise<void> {
      try {
        await client.send(new DeleteObjectCommand({
          Bucket: config.bucket, Key: key
        }), {
          abortSignal: AbortSignal.timeout(timeoutMs)
        });
      }
      catch (error) {
        const status = typeof error === "object" && error !== null && "$metadata" in error ? (error.$metadata as {
          httpStatusCode?: number;
        }).httpStatusCode : undefined;
        throw new MaintenanceDeleteError(status === undefined || status >= 500, error);
      }
    },
  };
}
