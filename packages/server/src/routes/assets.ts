// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

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
import { t } from "@breatic/shared";
import { requireAuth } from "@server/middleware/auth.js";
import type { AuthVariables } from "@server/middleware/auth.js";
import { rateLimitFor } from "@server/middleware/rate-limit.js";
import { projectService } from "@server/modules";
import {
  getStorageAdapter,
  storageKey,
  env,
  logger,
  ValidationError,
} from "@breatic/core";
import { nodeHistoryService } from "@breatic/domain";
import { recordProjectActivity } from "@server/modules/activity/projectActivity.service.js";

const assets = new Hono<{ Variables: AuthVariables }>();

// ── File kind detection ─────────────────────────────────────────────

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif", "image/svg+xml"]);
const VIDEO_TYPES = new Set(["video/mp4", "video/webm", "video/quicktime", "video/x-matroska"]);
const AUDIO_TYPES = new Set(["audio/mpeg", "audio/wav", "audio/ogg", "audio/flac", "audio/aac", "audio/mp3"]);

/**
 * Classify an upload into a coarse asset kind from its MIME type.
 * @param contentType - The MIME content type of the uploaded file.
 * @returns The detected asset kind: `image`, `video`, `audio`, `document` (text/PDF), or `file` for anything else.
 */
function detectKind(contentType: string): "image" | "video" | "audio" | "document" | "file" {
  if (IMAGE_TYPES.has(contentType)) return "image";
  if (VIDEO_TYPES.has(contentType)) return "video";
  if (AUDIO_TYPES.has(contentType)) return "audio";
  if (contentType.startsWith("text/") || contentType === "application/pdf") return "document";
  return "file";
}

// ── Per-user key-ownership guard ────────────────────────────────────

/**
 * Reject a client-supplied storage key that is not bound to this
 * caller + project, or that attempts path traversal. A legitimate key
 * from `/presign` always starts with `{userId}/{projectId}/`
 * (`storageKey()` format), so this makes `head()` a genuine
 * authenticity boundary instead of a bare existence check — without it
 * an editor could report a foreign project's asset URL into this
 * project's node history + feed, or (local storage) traverse out of
 * the upload dir. Mirrors the `/local-upload` guard.
 * @param key - The client-supplied storage key.
 * @param userId - Authenticated caller id.
 * @param projectId - Target project id.
 * @returns True when the key is safe to trust for this caller + project.
 */
function isOwnedKey(key: string, userId: string, projectId: string): boolean {
  if (key.includes("..") || key.includes("//")) return false;
  return key.startsWith(`${userId}/${projectId}/`);
}

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
  rateLimitFor("presign", "user"),
  zValidator("query", presignSchema),
  async (c) => {
    const user = c.get("user");
    const { filename, content_type, project_id } = c.req.valid("query");

    // Upload is a write — edit-or-above can presign.
    await projectService.assertAccess(project_id, user.id, "editor");

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

// ── Upload handshake + delete report (activity feed) ────────────────
//
// ADR 2026-07-04 project-activity-feed (D1, upload handshake): the
// client MUST report a completed upload here; the server verifies the
// object actually exists in storage (head()) before recording the
// activity - an unverified client claim never enters the audit trail.
// This route replaced the never-wired `POST /assets/history` upload
// reporter and absorbed its node_history recording.

const uploadedSchema = z.object({
  project_id: z.string().uuid(),
  /** Storage key returned by /presign - the head() verification target. */
  key: z.string().min(1).max(512),
  node_id: z.string().min(1).max(128).optional(),
  space_id: z.string().uuid().optional(),
  kind: z.string().min(1).max(32),
  /**
   * `mini_tool` marks a FRONTEND-executed mini-tool product (capability
   * rule: pure media transforms run in the browser and never pass
   * through worker Stage 4) - the row lands as generation:succeeded
   * instead of asset:uploaded. Plain uploads omit it.
   */
  source: z.literal("mini_tool").optional(),
  tool_name: z.string().max(64).optional(),
  metadata: z
    .object({
      filename: z.string().max(255),
      size: z.number().int().positive(),
      mimeType: z.string().max(100),
    })
    .optional(),
});

assets.post(
  "/uploaded",
  requireAuth,
  rateLimitFor("asset-report", "user"),
  zValidator("json", uploadedSchema),
  async (c) => {
    const user = c.get("user");
    const body = c.req.valid("json");

    await projectService.assertAccess(body.project_id, user.id, "editor");

    // The key MUST be one this caller presigned for THIS project, and
    // must not traverse. head() only proves existence — without this
    // binding an editor could report a foreign / off-project asset URL
    // into this project's history + feed (or, on local storage,
    // traverse out of the upload dir).
    if (!isOwnedKey(body.key, user.id, body.project_id)) {
      return c.json(
        { error: { message: t("server.error.validation") } },
        422,
      );
    }

    // Verify the object really landed in storage before trusting the
    // claim (first real caller of StorageAdapter.head).
    const adapter = await getStorageAdapter();
    const head = await adapter.head(body.key);
    if (!head.exists) {
      return c.json(
        { error: { message: t("server.error.validation") } },
        422,
      );
    }
    const fileUrl = adapter.publicUrl(body.key);

    // Node history record (version timeline), when node-bound.
    if (body.node_id) {
      try {
        await nodeHistoryService.recordUpload({
          projectId: body.project_id,
          nodeId: body.node_id,
          userId: user.id,
          content: fileUrl,
          metadata: body.metadata,
        });
      } catch (err) {
        logger.warn(
          { err, projectId: body.project_id, nodeId: body.node_id },
          "upload_history_record_failed",
        );
      }
    }

    await recordProjectActivity({
      projectId: body.project_id,
      actorUserId: user.id,
      type: body.source === "mini_tool" ? "generation:succeeded" : "asset:uploaded",
      spaceId: body.space_id ?? null,
      nodeId: body.node_id ?? null,
      payload:
        body.source === "mini_tool"
          ? {
              source: "mini_tool",
              ...(body.tool_name !== undefined && { toolName: body.tool_name }),
              executedOn: "frontend",
              fileUrl,
              kind: body.kind,
            }
          : { fileUrl, kind: body.kind },
    });

    return c.json({ data: { ok: true, fileUrl } });
  },
);

const deletedSchema = z.object({
  project_id: z.string().uuid(),
  entries: z
    .array(
      z.object({
        // Capped so a flood loop cannot bloat the append-only feed
        // table with multi-KB payloads (2048 comfortably fits any
        // real asset URL).
        file_url: z.string().url().max(2048),
        kind: z.string().min(1).max(32),
        node_id: z.string().min(1).max(128).optional(),
        space_id: z.string().uuid().optional(),
      }),
    )
    .min(1)
    .max(100),
});

assets.post(
  "/deleted",
  requireAuth,
  rateLimitFor("asset-report", "user"),
  zValidator("json", deletedSchema),
  async (c) => {
    const user = c.get("user");
    const body = c.req.valid("json");

    await projectService.assertAccess(body.project_id, user.id, "editor");

    // Report-only (no verification): deleting a node is a client-side
    // Yjs operation the collab write-authz already gates; this records
    // the audit trail. Batch = one report per multi-node delete.
    for (const entry of body.entries) {
      await recordProjectActivity({
        projectId: body.project_id,
        actorUserId: user.id,
        type: "asset:deleted",
        spaceId: entry.space_id ?? null,
        nodeId: entry.node_id ?? null,
        payload: { fileUrl: entry.file_url, kind: entry.kind },
      });
    }

    return c.json({ data: { ok: true, recorded: body.entries.length } });
  },
);

export { assets as assetsRoute };
