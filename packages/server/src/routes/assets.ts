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
import { assetUploadService, projectService } from "@server/modules";
import {
  getStorageAdapter,
  getStorageConfig,
  storageKey,
  env,
  logger,
  ValidationError,
} from "@breatic/core";
import { assetService, nodeHistoryService } from "@breatic/domain";
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

// ── Upload config (#1609 slice 2) ───────────────────────────────────

/**
 * `GET /assets/upload-config` — browser upload knobs from
 * `config/storage.yaml` (`upload:` section). The frontend fetches this
 * once per session and caches it: upload size cap (pre-checked on file
 * selection; authoritatively enforced by /presign) + retry attempts /
 * backoff base for presign + PUT.
 */
assets.get("/upload-config", requireAuth, (c) => {
  const { upload } = getStorageConfig();
  return c.json({
    data: {
      maxUploadBytes: upload.max_upload_bytes,
      clientMaxAttempts: upload.client_max_attempts,
      clientRetryBaseDelayMs: upload.client_retry_base_delay_ms,
      clientRequestTimeoutMs: upload.client_request_timeout_ms,
      clientPutMinBytesPerSec: upload.client_put_min_bytes_per_sec,
    },
  });
});

// ── Presign ─────────────────────────────────────────────────────────

/** sha256 hex — the only hash shape the dedup ledger stores. */
const SHA256_HEX = /^[0-9a-f]{64}$/;

const presignSchema = z.object({
  filename: z.string().min(1).max(255),
  content_type: z.string().min(1).max(100),
  project_id: z.string().uuid(),
  /** Declared byte size — the authoritative upload-cap gate input. */
  size: z.coerce.number().int().positive(),
  /** Client-computed content hash; present → dedup lookup (#1609). */
  hash: z.string().regex(SHA256_HEX).optional(),
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
    const { filename, content_type, project_id, size, hash } =
      c.req.valid("query");

    // Upload is a write — edit-or-above can presign.
    await projectService.assertAccess(project_id, user.id, "editor");

    // Authoritative upload cap (the frontend pre-check is UX only).
    const { upload } = getStorageConfig();
    if (size > upload.max_upload_bytes) {
      logger.info(
        { size, cap: upload.max_upload_bytes, userId: user.id },
        "presign_rejected_over_cap",
      );
      return c.json(
        { error: { message: t("server.error.upload_too_large") } },
        413,
      );
    }

    // Dedup lookup (#1609, B.2): the owner studio already holding this
    // content (with a matching size) skips the upload — the node reuses
    // the existing asset's URL. A size mismatch falls through to a
    // normal presign (content claim not trusted, spec §8).
    if (hash !== undefined) {
      const dedupHit = await assetUploadService.checkUploadDedup({
        projectId: project_id,
        actingUserId: user.id,
        contentHash: hash,
        sizeBytes: size,
      });
      if (dedupHit) {
        logger.info(
          { hash, userId: user.id, projectId: project_id },
          "presign_dedup_hit",
        );
        return c.json({
          data: {
            alreadyExists: true,
            fileUrl: dedupHit.fileUrl,
            kind: dedupHit.kind,
          },
        });
      }
    }

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

const uploadedSchema = z
  .object({
    project_id: z.string().uuid(),
    /**
     * Storage key returned by /presign - the head() verification target.
     * Required on the regular path; absent on the dedup path (no new
     * object was stored).
     */
    key: z.string().min(1).max(512).optional(),
    /**
     * Dedup report (#1609, B.2): the presign answered `alreadyExists`,
     * nothing was uploaded — the server re-verifies the (studio, hash)
     * row instead of key ownership + head().
     */
    dedup: z.literal(true).optional(),
    /** Content sha256; regular path → ledger registration, dedup path → the lookup key. */
    hash: z.string().regex(SHA256_HEX).optional(),
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
  })
  .superRefine((val, ctx) => {
    if (val.dedup === true && val.hash === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "hash is required for a dedup report",
        path: ["hash"],
      });
    }
    if (val.dedup !== true && val.key === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "key is required for an upload report",
        path: ["key"],
      });
    }
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

    let fileUrl: string;
    if (body.dedup === true && body.hash !== undefined) {
      // Dedup path (#1609, B.2): nothing was uploaded — verify the
      // claimed (studio, hash) row server-side (stronger than the
      // key-prefix anti-spoof below: the URL is re-derived, never
      // trusted from the client).
      const verified = await assetUploadService.verifyDedupUpload({
        projectId: body.project_id,
        actingUserId: user.id,
        contentHash: body.hash,
      });
      if (!verified) {
        return c.json(
          { error: { message: t("server.error.validation") } },
          422,
        );
      }
      fileUrl = verified.fileUrl;
    } else if (body.key !== undefined) {
      // Regular path: the key MUST be one this caller presigned for THIS
      // project, and must not traverse. head() only proves existence —
      // without this binding an editor could report a foreign /
      // off-project asset URL into this project's history + feed (or, on
      // local storage, traverse out of the upload dir).
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
      fileUrl = adapter.publicUrl(body.key);

      // Ledger registration (#1609): every hashed upload lands in
      // studio_assets with the size + content type STORAGE reports (the
      // client claim is never the source of truth). A missing hash can
      // only be the hashing-worker degrade — the upload stays available
      // but untracked (monitored signal, plan §6).
      if (body.hash !== undefined) {
        const mimeType =
          head.contentType !== ""
            ? head.contentType
            : (body.metadata?.mimeType ?? "application/octet-stream");
        try {
          await assetService.register({
            projectId: body.project_id,
            actingUserId: user.id,
            contentHash: body.hash,
            storageKey: body.key,
            fileUrl,
            sizeBytes: head.size,
            mimeType,
            kind: detectKind(mimeType),
            source: "upload",
          });
        } catch (err) {
          logger.error(
            { err, projectId: body.project_id, key: body.key, userId: user.id },
            "asset_ledger_register_failed",
          );
        }
      } else {
        logger.info(
          { projectId: body.project_id, key: body.key, userId: user.id },
          "asset_upload_untracked_no_hash",
        );
      }
    } else {
      // Unreachable: the schema superRefine guarantees dedup→hash and
      // regular→key. Kept for TS narrowing + defense in depth.
      return c.json({ error: { message: t("server.error.validation") } }, 422);
    }

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
