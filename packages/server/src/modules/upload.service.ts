/**
 * Upload service — orchestrates the two-phase upload flow.
 *
 * Phase 1 (prepare): validate size/type, reserve a storage key, and
 * return an upload URL (presigned for S3/OSS, server-side for local).
 *
 * Phase 2 (complete): verify the file was uploaded, extract video
 * cover if applicable, and route the result based on context
 * (agent/canvas/editor).
 *
 * The handoff between phases uses a Redis-backed upload ticket
 * keyed by upload_id with a 10-minute TTL.
 */

import { randomUUID } from "node:crypto";
import type { AssetKind } from "@breatic/shared";
import { env } from "../config/env.js";
import { getRedis } from "../infra/redis.js";
import { getStorageAdapter, storageKey } from "../infra/storage/index.js";
import { ValidationError, NotFoundError, ForbiddenError } from "../errors.js";
import { logger } from "../logger.js";

/** Upload ticket stored in Redis between prepare and complete. */
export interface UploadTicket {
  userId: string;
  projectId: string;
  conversationId?: string;
  nodeId?: string;
  context: UploadContext;
  key: string;
  filename: string;
  mimeType: string;
  declaredSize: number;
  kind: AssetKind;
  createdAt: number;
}

export type UploadContext = "agent" | "canvas" | "editor";

/** Upload ticket TTL in seconds. */
const TICKET_TTL_SECONDS = 600;

/** Redis key for upload tickets. */
function ticketKey(uploadId: string): string {
  return `${env.ENV}:upload:ticket:${uploadId}`;
}

/** Resolve MIME type → AssetKind classification. */
export function classifyKind(mimeType: string): AssetKind {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType === "model/gltf-binary" || mimeType === "model/gltf+json") return "3d";
  return "document";
}

/** MIME type allowlist per kind (rejects anything not in this set). */
const MIME_ALLOWLIST: Record<AssetKind, readonly string[]> = {
  image: [
    "image/png", "image/jpeg", "image/webp", "image/gif", "image/bmp", "image/tiff",
  ],
  video: [
    "video/mp4", "video/webm", "video/quicktime", "video/x-matroska",
  ],
  audio: [
    "audio/mpeg", "audio/wav", "audio/ogg", "audio/flac", "audio/x-m4a", "audio/mp4",
  ],
  "3d": [
    "model/gltf-binary", "model/gltf+json", "application/octet-stream",
  ],
  document: [
    "text/plain", "text/markdown", "application/pdf",
    "application/json", "text/csv",
  ],
};

/** Per-kind max size in bytes, from env. */
function maxSizeFor(kind: AssetKind): number {
  const MB = 1024 * 1024;
  switch (kind) {
    case "image": return env.UPLOAD_MAX_IMAGE_MB * MB;
    case "video": return env.UPLOAD_MAX_VIDEO_MB * MB;
    case "audio": return env.UPLOAD_MAX_AUDIO_MB * MB;
    case "3d": return env.UPLOAD_MAX_3D_MB * MB;
    case "document": return env.UPLOAD_MAX_DOCUMENT_MB * MB;
  }
}

/** File extension from MIME type. */
function extFromMime(mimeType: string, filename: string): string {
  const fromName = filename.includes(".") ? filename.slice(filename.lastIndexOf(".")) : "";
  if (fromName) return fromName;
  const map: Record<string, string> = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "video/mp4": ".mp4",
    "video/webm": ".webm",
    "video/quicktime": ".mov",
    "audio/mpeg": ".mp3",
    "audio/wav": ".wav",
    "audio/ogg": ".ogg",
    "model/gltf-binary": ".glb",
    "model/gltf+json": ".gltf",
    "application/pdf": ".pdf",
    "text/plain": ".txt",
    "text/markdown": ".md",
  };
  return map[mimeType] ?? ".bin";
}

/** Storage subdirectory from context (reuses taskType slot in storageKey). */
function subDirForContext(context: UploadContext): string {
  return `upload-${context}`;
}

/**
 * Phase 1: validate + reserve a storage key + return upload URL.
 *
 * @returns `{ upload_id, upload_url, expires_at, key }`
 * @throws ValidationError when size/mime is rejected
 */
export async function prepare(opts: {
  userId: string;
  filename: string;
  contentType: string;
  size: number;
  context: UploadContext;
  projectId: string;
  conversationId?: string;
  nodeId?: string;
  apiBaseUrl: string; // full base URL for local fallback (e.g. http://localhost:3000)
}): Promise<{
  upload_id: string;
  upload_url: string;
  key: string;
  expires_at: string;
}> {
  const kind = classifyKind(opts.contentType);

  // 1. MIME allowlist
  const allowedMimes = MIME_ALLOWLIST[kind];
  if (!allowedMimes.includes(opts.contentType)) {
    throw new ValidationError(
      `Unsupported content type: ${opts.contentType}. Allowed for ${kind}: ${allowedMimes.join(", ")}`,
    );
  }

  // 2. Size check
  const maxSize = maxSizeFor(kind);
  if (opts.size <= 0) {
    throw new ValidationError("File size must be greater than 0");
  }
  if (opts.size > maxSize) {
    throw new ValidationError(
      `File too large: ${opts.size} bytes > ${maxSize} bytes limit for ${kind}`,
    );
  }

  // 3. Generate storage key
  const key = storageKey({
    userId: opts.userId,
    projectId: opts.projectId,
    taskType: subDirForContext(opts.context),
    ext: extFromMime(opts.contentType, opts.filename),
  });

  // 4. Generate upload URL (provider-specific)
  let upload_url: string;
  if (env.STORAGE_PROVIDER === "local") {
    // Local fallback — client PUTs back to this server
    upload_url = `${opts.apiBaseUrl}/api/v1/assets/upload/`;
    // Actual upload_id appended after generation below
  } else {
    const adapter = await getStorageAdapter();
    // Both S3 and OSS adapters support getUploadUrl
    const adapterWithPresign = adapter as unknown as {
      getUploadUrl?: (key: string, contentType: string, expiresSeconds: number) => Promise<string>;
    };
    if (!adapterWithPresign.getUploadUrl) {
      throw new Error(`Storage provider '${env.STORAGE_PROVIDER}' does not support presigned uploads`);
    }
    upload_url = await adapterWithPresign.getUploadUrl(key, opts.contentType, TICKET_TTL_SECONDS);
  }

  // 5. Store ticket in Redis
  const upload_id = randomUUID();
  const ticket: UploadTicket = {
    userId: opts.userId,
    projectId: opts.projectId,
    conversationId: opts.conversationId,
    nodeId: opts.nodeId,
    context: opts.context,
    key,
    filename: opts.filename,
    mimeType: opts.contentType,
    declaredSize: opts.size,
    kind,
    createdAt: Date.now(),
  };
  const redis = getRedis();
  await redis.setex(
    ticketKey(upload_id),
    TICKET_TTL_SECONDS,
    JSON.stringify(ticket),
  );

  if (env.STORAGE_PROVIDER === "local") {
    upload_url = `${upload_url}${upload_id}`;
  }

  const expires_at = new Date(Date.now() + TICKET_TTL_SECONDS * 1000).toISOString();
  logger.info(
    { upload_id, userId: opts.userId, context: opts.context, kind, size: opts.size },
    "upload_prepared",
  );
  return { upload_id, upload_url, key, expires_at };
}

/**
 * Load a ticket from Redis by upload_id, enforcing caller ownership.
 *
 * @throws NotFoundError when the ticket is missing/expired
 * @throws ForbiddenError when the caller is not the ticket owner
 */
export async function loadTicket(
  uploadId: string,
  callerUserId: string,
): Promise<UploadTicket> {
  const redis = getRedis();
  const raw = await redis.get(ticketKey(uploadId));
  if (!raw) {
    throw new NotFoundError(`Upload ticket not found or expired: ${uploadId}`);
  }
  const ticket = JSON.parse(raw) as UploadTicket;
  if (ticket.userId !== callerUserId) {
    throw new ForbiddenError("Upload ticket belongs to another user");
  }
  return ticket;
}

/** Delete a ticket after it has been consumed. */
export async function consumeTicket(uploadId: string): Promise<void> {
  const redis = getRedis();
  await redis.del(ticketKey(uploadId));
}
