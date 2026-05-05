/**
 * Assets route — presigned URL upload + history reporting.
 *
 * New flow (replaces old prepare → PUT → complete 3-step):
 *
 *   1. GET /assets/presign  → presigned PUT URL + final file URL
 *   2. (client PUTs file directly to cloud storage or local endpoint)
 *   3. Client writes Yjs directly (canvas) or calls API (agent attach)
 *   4. POST /assets/history  → optional upload record for node_history
 *
 * For `STORAGE_PROVIDER=local`, step 2 PUTs to this server at
 * `PUT /assets/local-upload/:key`. For s3/aliyun_oss, the PUT goes
 * directly to cloud storage via the presigned URL.
 */

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import type { AuthVariables } from "../middleware/auth.js";
import {
  projectService,
  getStorageAdapter,
  storageKey,
  env,
  nodeHistoryService,
  logger,
  ValidationError,
  checkRateLimit,
  getRedis,
} from "@breatic/core";
import type { MiddlewareHandler } from "hono";

const assets = new Hono<{ Variables: AuthVariables }>();

// ── File kind detection ─────────────────────────────────────────────

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif", "image/svg+xml"]);
const VIDEO_TYPES = new Set(["video/mp4", "video/webm", "video/quicktime", "video/x-matroska"]);
const AUDIO_TYPES = new Set(["audio/mpeg", "audio/wav", "audio/ogg", "audio/flac", "audio/aac", "audio/mp3"]);

function detectKind(contentType: string): "image" | "video" | "audio" | "document" | "file" {
  if (IMAGE_TYPES.has(contentType)) return "image";
  if (VIDEO_TYPES.has(contentType)) return "video";
  if (AUDIO_TYPES.has(contentType)) return "audio";
  if (contentType.startsWith("text/") || contentType === "application/pdf") return "document";
  return "file";
}

// ── Rate limit for presign ──────────────────────────────────────────

const presignRateLimit: MiddlewareHandler = async (c, next) => {
  const user = c.get("user") as { id: string } | undefined;
  const key = user?.id ?? "anonymous";
  const redis = getRedis();
  const allowed = await checkRateLimit(redis, `presign:${key}`, 30, 60);
  if (!allowed) {
    return c.json({ error: { code: 429, message: "Too many upload requests" } }, 429);
  }
  await next();
};

// ── Presign ─────────────────────────────────────────────────────────

const presignSchema = z.object({
  filename: z.string().min(1).max(255),
  content_type: z.string().min(1).max(100),
  project_id: z.string().uuid(),
});

/**
 * `GET /assets/presign` — get a presigned PUT URL for direct upload.
 *
 * Returns `{ uploadUrl, fileUrl, key, kind }`:
 *   - `uploadUrl`: where the client PUTs the file (presigned S3/OSS
 *     URL, or this server's local upload endpoint)
 *   - `fileUrl`: the permanent public URL after upload completes
 *   - `key`: storage key (for local upload path)
 *   - `kind`: detected file kind (image/video/audio/document/file)
 *
 * The client uploads directly to `uploadUrl`, then writes the result
 * to Yjs (for canvas nodes) or calls a separate API (for agent
 * attachments). No Redis ticket, no lock, no event stream.
 */
assets.get(
  "/presign",
  requireAuth,
  presignRateLimit,
  zValidator("query", presignSchema),
  async (c) => {
    const user = c.get("user");
    const { filename, content_type, project_id } = c.req.valid("query");

    // Upload is a write — edit-or-above can presign.
    await projectService.assertAccess(project_id, user.id, "edit");

    const kind = detectKind(content_type);
    const key = storageKey({
      userId: user.id,
      projectId: project_id,
      taskType: kind,
      ext: filename.split(".").pop() ?? "bin",
    });

    const adapter = await getStorageAdapter();
    let uploadUrl: string;

    if (adapter.getUploadUrl) {
      // S3 / OSS — presigned PUT directly to cloud (5 min expiry)
      uploadUrl = await adapter.getUploadUrl(key, content_type, 300);
    } else {
      // Local storage — PUT to this server
      const url = new URL(c.req.url);
      const apiBaseUrl = `${url.protocol}//${url.host}`;
      uploadUrl = `${apiBaseUrl}/api/v1/assets/local-upload/${encodeURIComponent(key)}`;
    }

    const fileUrl = adapter.publicUrl(key);

    logger.info({ key, kind, filename, userId: user.id }, "presign_issued");

    return c.json({
      data: { uploadUrl, fileUrl, key, kind },
    });
  },
);

// ── Local direct upload (fallback for STORAGE_PROVIDER=local) ───────

/**
 * `PUT /assets/local-upload/:key` — local storage upload target.
 *
 * Only available when STORAGE_PROVIDER=local. The key is validated
 * to ensure it starts with the authenticated user's ID prefix.
 */
assets.put("/local-upload/*", requireAuth, async (c) => {
  const user = c.get("user");

  if (env.STORAGE_PROVIDER !== "local") {
    throw new ValidationError(
      "Direct upload endpoint is only available when STORAGE_PROVIDER=local",
    );
  }

  // Extract the key from the URL path (everything after /local-upload/)
  const key = decodeURIComponent(c.req.path.replace(/^\/api\/v1\/assets\/local-upload\//, ""));

  // Security: validate key format and ownership
  if (key.includes("..") || key.includes("//") || !key.startsWith(user.id)) {
    throw new ValidationError("Invalid or unauthorized upload key");
  }

  const arrayBuf = await c.req.arrayBuffer();
  const buffer = Buffer.from(arrayBuf);
  const contentType = c.req.header("Content-Type") ?? "application/octet-stream";

  const adapter = await getStorageAdapter();
  await adapter.upload(key, buffer, contentType);

  logger.info({ key, size: buffer.length, userId: user.id }, "local_upload_received");
  return c.json({ data: { key, size: buffer.length } });
});

// ── History reporting ───────────────────────────────────────────────

const historySchema = z.object({
  type: z.literal("upload"),
  project_id: z.string().uuid(),
  node_id: z.string().min(1),
  content: z.string().url(),
  thumbnail_url: z.string().url().optional(),
  metadata: z.object({
    filename: z.string().max(255),
    size: z.number().int().positive(),
    mimeType: z.string().max(100),
  }),
});

/**
 * `POST /assets/history` — report a file upload to node_history.
 *
 * Called by the frontend AFTER writing to Yjs. This is async and
 * best-effort — if it fails, the upload still succeeded (the file
 * is in storage and the Yjs node content is updated). The history
 * record enables version timeline and restore.
 */
assets.post(
  "/history",
  requireAuth,
  zValidator("json", historySchema),
  async (c) => {
    const user = c.get("user");
    const body = c.req.valid("json");

    await projectService.assertAccess(body.project_id, user.id, "edit");

    await nodeHistoryService.recordUpload({
      projectId: body.project_id,
      nodeId: body.node_id,
      userId: user.id,
      content: body.content,
      thumbnailUrl: body.thumbnail_url,
      metadata: body.metadata,
    });

    return c.json({ data: { ok: true } });
  },
);

export { assets as assetsRoute };
