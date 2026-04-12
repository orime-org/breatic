/**
 * Assets route — unified file upload for Agent / Canvas / Editor.
 *
 * Two-phase upload:
 *   1. POST /assets/upload/prepare  → validate, reserve key, return upload URL
 *   2. (client PUT to upload URL)
 *   3. POST /assets/upload/complete → verify, extract video cover, route by context
 *
 * For `STORAGE_PROVIDER=local`, step 2 PUTs back to this server at
 * `PUT /assets/upload/:upload_id`. For `s3`/`aliyun_oss`, the upload URL
 * is a presigned URL pointing directly at cloud storage.
 */

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import type { AuthVariables } from "../middleware/auth.js";
import * as uploadService from "../modules/upload.service.js";
import * as attachmentService from "../modules/conversation-attachment.service.js";
import * as nodeHistoryService from "../modules/node-history.service.js";
import * as projectService from "../modules/project.service.js";
import * as conversationService from "../modules/conversation.service.js";
import { getStorageAdapter } from "../infra/storage/index.js";
import { getRedis } from "../infra/redis.js";
import { acquireNodeLock, releaseNodeLock } from "../infra/canvas-lock.js";
import { publishNodeEvent } from "../infra/event-stream.js";
import { env } from "../config/env.js";
import { ConflictError, NotFoundError, ValidationError } from "../errors.js";
import { logger } from "../logger.js";

const assets = new Hono<{ Variables: AuthVariables }>();

// ── Prepare ──────────────────────────────────────────────────────────

const prepareSchema = z.object({
  filename: z.string().min(1).max(255),
  content_type: z.string().min(1).max(100),
  size: z.number().int().positive(),
  context: z.enum(["agent", "canvas", "editor"]),
  project_id: z.string().uuid(),
  conversation_id: z.string().uuid().optional(),
  node_id: z.string().min(1).optional(),
});

/**
 * `POST /assets/upload/prepare` — start an upload, get an upload URL.
 *
 * The client subsequently PUTs the file to `upload_url`. For cloud
 * providers this goes directly to S3/OSS; for local it comes back
 * to `PUT /assets/upload/:upload_id` on this server.
 */
assets.post(
  "/upload/prepare",
  requireAuth,
  zValidator("json", prepareSchema),
  async (c) => {
    const user = c.get("user");
    const body = c.req.valid("json");

    // Context-specific required fields
    if (body.context === "agent" && !body.conversation_id) {
      throw new ValidationError("conversation_id is required for agent uploads");
    }
    if ((body.context === "canvas" || body.context === "editor") && !body.node_id) {
      throw new ValidationError("node_id is required for canvas/editor uploads");
    }

    // Cross-tenant guard: the ticket records project_id / conversation_id
    // straight from the request body and later drives writes into the
    // target project's canvas node history and the target conversation's
    // attachment pool. Without an ownership check here a logged-in user
    // who knows a victim project/conversation UUID can inject content
    // into it.
    await projectService.assertAccess(body.project_id, user.id);
    if (body.context === "agent" && body.conversation_id) {
      await conversationService.assertAccess(body.conversation_id, user.id);
    }

    // Full URL for local fallback (e.g. http://localhost:3000)
    const url = new URL(c.req.url);
    const apiBaseUrl = `${url.protocol}//${url.host}`;

    const redis = getRedis();
    const actor = { userId: user.id, username: user.email };

    // Canvas uploads take the node lock at prepare-time and hold it
    // across the PUT upload phase. This means a large video upload
    // (multi-minute) keeps the node in `handling` state for its
    // entire duration — other collaborators see "X is handling" and
    // cannot start a concurrent operation. The lock is released by
    // Collab when it processes the completed/failed event.
    if (body.context === "canvas" && body.node_id) {
      const acquired = await acquireNodeLock(redis, body.project_id, body.node_id, actor);
      if (!acquired) {
        throw new ConflictError(
          "Another user is currently handling this node. Try again after they finish.",
        );
      }
    }

    let result;
    try {
      result = await uploadService.prepare({
        userId: user.id,
        filename: body.filename,
        contentType: body.content_type,
        size: body.size,
        context: body.context,
        projectId: body.project_id,
        conversationId: body.conversation_id,
        nodeId: body.node_id,
        apiBaseUrl,
      });
    } catch (err) {
      // If ticket creation fails, immediately release the lock we
      // just took so the node isn't stuck in handling state.
      if (body.context === "canvas" && body.node_id) {
        await releaseNodeLock(redis, body.project_id, body.node_id);
      }
      throw err;
    }

    // Broadcast handling state to every collaborator — done AFTER
    // the ticket is created so the event's nodeId is guaranteed to
    // correspond to a real in-progress upload.
    if (body.context === "canvas" && body.node_id) {
      await publishNodeEvent(redis, {
        type: "handling",
        projectId: body.project_id,
        nodeId: body.node_id,
        actor,
      });
    }

    return c.json({ data: result }, 201);
  },
);

// ── Local direct upload (fallback for STORAGE_PROVIDER=local) ───────

/**
 * `PUT /assets/upload/:upload_id` — local storage direct upload target.
 *
 * Body is raw binary. The upload_id ticket in Redis tells us where
 * to write the file and enforces user ownership.
 */
assets.put("/upload/:upload_id", requireAuth, async (c) => {
  const user = c.get("user");
  const uploadId = c.req.param("upload_id");

  if (env.STORAGE_PROVIDER !== "local") {
    throw new ValidationError(
      "Direct upload endpoint is only available when STORAGE_PROVIDER=local",
    );
  }

  const ticket = await uploadService.loadTicket(uploadId, user.id);

  const arrayBuf = await c.req.arrayBuffer();
  const buffer = Buffer.from(arrayBuf);

  if (buffer.length !== ticket.declaredSize) {
    logger.warn(
      { expected: ticket.declaredSize, actual: buffer.length, uploadId },
      "Upload size mismatch (client declared vs actual)",
    );
  }

  const adapter = await getStorageAdapter();
  await adapter.upload(ticket.key, buffer, ticket.mimeType);

  logger.info({ uploadId, key: ticket.key, size: buffer.length }, "local_upload_received");
  return c.json({ data: { key: ticket.key, size: buffer.length } });
});

// ── Complete ─────────────────────────────────────────────────────────

const completeSchema = z.object({
  upload_id: z.string().uuid(),
  name: z.string().max(255).optional(),
});

/**
 * `POST /assets/upload/complete` — finalize the upload.
 *
 * Verifies the file landed in storage, extracts a video cover if
 * applicable, and routes the result based on context:
 *
 *  - agent  → persist to `conversation_attachments`, return full pool
 *  - canvas → persist to `node_history` (silent), return file metadata
 *  - editor → return file metadata only
 */
assets.post(
  "/upload/complete",
  requireAuth,
  zValidator("json", completeSchema),
  async (c) => {
    const user = c.get("user");
    const body = c.req.valid("json");

    const ticket = await uploadService.loadTicket(body.upload_id, user.id);

    // 1. Verify file is in storage and get actual size
    const adapter = await getStorageAdapter();
    const head = await adapter.head(ticket.key);
    if (!head.exists) {
      // Upload never landed. For canvas uploads, publish `failed` so
      // the node's handling state clears and the lock is released.
      if (ticket.context === "canvas" && ticket.nodeId) {
        const redis = getRedis();
        await publishNodeEvent(redis, {
          type: "failed",
          projectId: ticket.projectId,
          nodeId: ticket.nodeId,
        });
      }
      throw new NotFoundError("File not found in storage; upload may have failed");
    }
    const url = adapter.publicUrl(ticket.key);
    const actualSize = head.size || ticket.declaredSize;

    // 2. Video cover extraction
    let coverUrl: string | undefined;
    let thumbnailUrl: string | undefined;
    if (ticket.kind === "video") {
      const { extractVideoCover } = await import("../worker/video-cover.js");
      coverUrl = await extractVideoCover(url, {
        userId: ticket.userId,
        projectId: ticket.projectId,
      });
      thumbnailUrl = coverUrl;
    } else if (ticket.kind === "image") {
      thumbnailUrl = url;
    }

    // 3. Context branching
    const displayName = body.name ?? ticket.filename;
    const baseResult = {
      url,
      thumbnail_url: thumbnailUrl,
      cover_url: coverUrl,
      size: actualSize,
      mime_type: ticket.mimeType,
      kind: ticket.kind,
    };

    if (ticket.context === "agent") {
      if (!ticket.conversationId) {
        throw new ValidationError("Agent upload ticket missing conversation_id");
      }
      await attachmentService.create({
        conversationId: ticket.conversationId,
        userId: ticket.userId,
        url,
        thumbnailUrl: thumbnailUrl ?? null,
        name: displayName,
        mimeType: ticket.mimeType,
        size: actualSize,
        kind: ticket.kind,
      });
      const attachments = await attachmentService.listByConversation(ticket.conversationId);
      await uploadService.consumeTicket(body.upload_id);
      return c.json({ data: { ...baseResult, attachments } });
    }

    if (ticket.context === "canvas") {
      if (!ticket.nodeId) {
        throw new ValidationError("Canvas upload ticket missing node_id");
      }
      await nodeHistoryService.recordUpload({
        projectId: ticket.projectId,
        nodeId: ticket.nodeId,
        userId: ticket.userId,
        content: url,
        thumbnailUrl,
        metadata: {
          filename: displayName,
          size: actualSize,
          mimeType: ticket.mimeType,
        },
      });
      await uploadService.consumeTicket(body.upload_id);

      // Publish completion — Collab updates canvas node content +
      // cover_url, clears handlingBy, and releases the node lock.
      const redis = getRedis();
      await publishNodeEvent(redis, {
        type: "completed",
        projectId: ticket.projectId,
        nodeId: ticket.nodeId,
        content: url,
        cover_url: coverUrl,
      });

      return c.json({ data: baseResult });
    }

    // editor
    await uploadService.consumeTicket(body.upload_id);
    return c.json({ data: baseResult });
  },
);

export { assets as assetsRoute };
