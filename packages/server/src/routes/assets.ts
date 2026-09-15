// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Assets route — the browser's half of an upload (#173).
 *
 *   1. GET  /assets/upload-config  → the knobs the browser sizes its work by
 *   2. POST /assets/upload-ticket  → a signed ticket, or an instant dedup hit
 *   3. (the browser sends its parts to the ingest Worker, not to us)
 *   4. POST /assets/uploads/{id}/complete → we finish it and register what landed
 *
 * The bytes never pass through this server. What it owns is the decision to
 * allow an upload, the row that records it, and driving the finish once every
 * part has landed — the Worker asks for a secret the browser does not hold.
 */

import { Hono } from "hono";
import { validate } from "@server/middleware/validate.js";
import { z } from "zod";
import {
  finishUploadAtIngest,
  verifySessionToken,
  reduceMediaType,
  isUploadableMediaType,
  t,
} from "@breatic/shared";
import {
  assetService,
  ingestReportService,
  uploadTicketService,
} from "@breatic/domain";
import { openUpload } from "@server/modules/asset/upload-opening.js";
import { noteIngestSideEffects } from "@server/modules/asset/ingest-side-effects.js";
import { safeExt } from "@server/modules/asset/sourceUrl.js";
import { requireAuth } from "@server/middleware/auth.js";
import type { AuthVariables } from "@server/middleware/auth.js";
import { rateLimitFor } from "@server/middleware/rate-limit.js";
import {
  assertStorageAllowance,
  assetUploadService,
  projectService,
} from "@server/modules";
import {
  getStorageConfig,
  env,
  logger,
  getNodeTaskConfig,
} from "@breatic/core";
import { recordProjectActivity } from "@server/modules/activity/projectActivity.service.js";

const assets = new Hono<{ Variables: AuthVariables }>();

// ── File kind detection ─────────────────────────────────────────────

// ── Upload config (#1609 slice 2) ───────────────────────────────────

/**
 * `GET /assets/upload-config` — browser upload knobs from
 * `config/storage.yaml` (`upload:` section). The frontend fetches this
 * once per session and caches it: the upload size cap (pre-checked on file
 * selection; authoritatively enforced by /upload-ticket), the retry attempts
 * and backoff base for the **ticket request**, and the floor and rate that
 * size a part's stall guard.
 *
 * A part's retry count is deliberately absent: parts go through the shared
 * HTTP transport, which owns how many times each one is delivered, so no knob
 * here can move it.
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

// ── Upload ticket (#173) ────────────────────────────────────────────

/** sha256 hex — the only hash shape the dedup ledger stores. */
const SHA256_HEX = /^[0-9a-f]{64}$/;

const uploadTicketSchema = z.object({
  filename: z
    .string()
    .min(1)
    .max(255)
    // The extension is spliced into the storage key, so a "/" or "\\" could
    // inject a path segment. Unicode letters,
    // spaces and punctuation stay allowed — this is a global product.
    // eslint-disable-next-line no-control-regex -- rejecting control chars IS the intent
    .regex(/^[^/\\\x00-\x1f\x7f]+$/, "filename contains an unsafe character"),
  // A preflight, not the answer. What the ledger records is read off the
  // stored bytes at the edge; this only decides whether to move any, out of
  // the one thing available before a byte moves — what the caller says it is
  // (#240).
  //
  // Judged against the shared list rather than the family, because the family
  // is not the question: `image/svg+xml` is an image by family and a script by
  // content, and `image/gif` is an image nothing downstream reads. The list
  // also knows the other names one format goes by, so an `.m4a` announced as
  // `audio/x-m4a` is the same answer as one announced as `audio/mp4`.
  //
  // Reduced to one essence first, through the shared reduction every lane an
  // outside type arrives on reads. A rule about what a browser does with a
  // comma-carrying header holds wherever such a header can arrive, and two
  // hand-written copies of it hold only where somebody remembered.
  content_type: z
    .string()
    .min(1)
    .max(100)
    .transform(reduceMediaType)
    .refine(isUploadableMediaType, "content_type is not an uploadable kind"),
  project_id: z.string().uuid(),
  /** Declared byte size — the authoritative upload-cap gate input. */
  size: z.coerce.number().int().positive(),
  /**
   * Client-computed content hash — REQUIRED ("no hash, no upload"). Here it
   * only answers the dedup question; it is NOT recorded on the grant, because
   * the hash that names the content is the one the Worker computes over the
   * bytes that really landed.
   */
  client_hash: z.string().regex(SHA256_HEX),
  /** Where the bytes land. Absent for a focus crop, which has no node. */
  node_id: z.string().uuid().optional(),
  space_id: z.string().uuid().optional(),
  /**
   * What started this upload. Only the mini-tool value is ever sent, and it
   * decides how the ledger files what is stored — a column the offline reclaim
   * job reads — so nothing else is admitted.
   */
  source: z.enum(["mini_tool"]).optional(),
  tool_name: z.string().max(100).optional(),
  derived: z.boolean().optional(),
});

/**
 * `POST /assets/upload-ticket` — the permission slip the browser carries to
 * the ingest Worker (design §4.1).
 *
 * It runs the whole gate — project access, the upload cap, the dedup pass, the
 * storage allowance — and then leaves behind the one row that survives until
 * the Worker reports back. The context the browser declares is
 * checked against this user's access before it lands on that row, so from the
 * report's point of view it is ours rather than the client's: the Worker knows
 * only what the ticket told it, and cannot be asked to prove any of it.
 */
assets.post(
  "/upload-ticket",
  requireAuth,
  rateLimitFor("upload-ticket", "user"),
  validate("json", uploadTicketSchema),
  async (c) => {
    const user = c.get("user");
    const body = c.req.valid("json");

    // Upload is a write — edit-or-above can ask for a ticket.
    await projectService.assertAccess(body.project_id, user.id, "editor");

    const { upload, ingest } = getStorageConfig();
    if (body.size > upload.max_upload_bytes) {
      logger.info(
        { size: body.size, cap: upload.max_upload_bytes, userId: user.id },
        "upload_ticket_rejected_over_cap",
      );
      return c.json(
        { error: { message: t("server.error.upload_too_large") } },
        413,
      );
    }

    // Dedup: the owner studio already holding this content (with a matching
    // size) skips the upload entirely — no key, no grant, no ticket.
    const dedupHit = await assetUploadService.checkUploadDedup({
      projectId: body.project_id,
      contentHash: body.client_hash,
      sizeBytes: body.size,
    });
    if (dedupHit) {
      logger.info(
        { hash: body.client_hash, userId: user.id, projectId: body.project_id },
        "upload_ticket_dedup_hit",
      );
      // No bytes move, but the node now shows something it did not show
      // before: it gets its history row, and a task row opened and settled in
      // the same pass.
      // The project activity feed gets nothing, because its only shape for
      // this is `asset:uploaded` and nothing was uploaded.
      await assetUploadService.settleDedupHit({
        projectId: body.project_id,
        hit: dedupHit,
        userId: user.id,
        metadata: {
          filename: body.filename,
          size: body.size,
          mimeType: body.content_type,
        },
        nodeId: body.node_id,
        spaceId: body.space_id,
      });
      return c.json({
        data: {
          alreadyExists: true,
          fileUrl: dedupHit.fileUrl,
          kind: dedupHit.kind,
        },
      });
    }

    // Storage gate, after the dedup return: that path consumes nothing.
    await assertStorageAllowance(body.project_id, "upload");

    // Both settings have to be present before a byte is authorised. Without
    // the secret the Worker would reject every ticket we sign; without the
    // base URL the browser has nowhere to send its parts. Neither is anything
    // the user did, so this is our own misconfiguration and reads as a 500.
    if (!env.INGEST_SHARED_SECRET || !env.INGEST_BASE_URL) {
      logger.error(
        {
          hasSecret: Boolean(env.INGEST_SHARED_SECRET),
          hasBaseUrl: Boolean(env.INGEST_BASE_URL),
        },
        "upload_ticket_ingest_unconfigured",
      );
      throw new Error(
        "ingest Worker is not configured: INGEST_BASE_URL and " +
          "INGEST_SHARED_SECRET are both required",
      );
    }

    const kind = assetService.detectAssetKind(body.content_type);
    // One rule for what may go in a key, shared with the lane that takes an
    // address. A separator or a query character spliced in makes publicUrl
    // point at a key R2 does not hold, and every read of that asset 404s.
    const ext = safeExt(body.filename);

    const expiresAt = Date.now() + ingest.ticket_expires_seconds * 1000;

    // The grant, and the task row this upload is on whatever node it lands on,
    // opened before the ticket that starts it (#186, design §4.6.5). Nothing
    // schedules a deadline: the row carries its own budget, and whoever opens
    // this node's task list is what judges it against the clock.
    const { key, studioId, taskId } = await openUpload(
      {
        projectId: body.project_id,
        actingUserId: user.id,
        declaredSize: body.size,
        taskType: kind,
        ext,
        expiresAt: new Date(expiresAt),
        context: {
          nodeId: body.node_id ?? null,
          spaceId: body.space_id ?? null,
          source: body.source ?? null,
          toolName: body.tool_name ?? null,
          derived: body.derived ?? null,
          filename: body.filename,
        },
      },
      {
        budgetMs: getNodeTaskConfig().default_budget_ms,
        label: body.filename,
      },
    );

    const target = await uploadTicketService.signTicketFor({
      storageKey: key,
      studioId,
      userId: user.id,
      declaredSize: body.size,
      contentType: body.content_type,
      expiresAt,
    });

    logger.info(
      { key, kind, totalParts: target.totalParts, userId: user.id },
      "upload_ticket_issued",
    );

    return c.json(
      {
        data: {
          ticket: target.ticket,
          storageKey: key,
          uploadUrl: target.uploadUrl,
          kind,
          partSize: target.partSize,
          totalParts: target.totalParts,
          // Which task row this upload is. The browser keys a failed
          // upload's File by it, so two uploads onto one node each keep
          // their own (#186 §3.7.2). Absent on an upload with no node.
          taskId,
        },
      },
      201,
    );
  },
);

// ── Finishing an upload (#206) ──────────────────────────────────────


/**
 * `POST /assets/uploads/{uploadId}/complete` — the browser handing back what
 * it holds, so this server can finish the upload for it (design §3.1).
 *
 * The browser cannot finish one itself: the Worker asks for the shared secret,
 * which only our own servers hold. What it hands over is the upload id, the
 * token every part's answer gave it, and R2's receipt for each part — the
 * whole of what one upload needs remembered, since the Worker remembers
 * nothing between requests.
 *
 * The key is never in the body. Everything past this point is indexed by it
 * and decides consequences off the grant row rather than off who is asking, so
 * it is read out of the signature the Worker put on that token.
 */
assets.post(
  "/uploads/:uploadId/complete",
  requireAuth,
  rateLimitFor("upload-complete", "user"),
  validate(
    "json",
    z.object({
      parts: z
        .array(
          z.object({
            partNumber: z.number().int().positive(),
            etag: z.string().min(1).max(200),
          }),
        )
        .min(1),
    }),
  ),
  async (c) => {
    const uploadId = c.req.param("uploadId");
    const session = await verifySessionToken(
      c.req.header("x-upload-token") ?? "",
      env.INGEST_SHARED_SECRET,
      Date.now(),
    );
    if (session === null || session.uploadId !== uploadId) {
      return c.json(
        { error: { code: 401, message: t("server.auth.not_authenticated") } },
        401,
      );
    }
    const { storageKey } = session;

    // How many parts this upload has is signed into the token, so a list of
    // the wrong length is answered here rather than after a round trip. The
    // Worker judges the list again on its own account.
    const parts = c.req.valid("json").parts;
    if (parts.length !== session.totalParts) {
      return c.json(
        { error: { message: t("server.error.validation") } },
        400,
      );
    }

    // Before the Worker is asked to assemble, because what this stops is a
    // write: a ticket still inside its window opening a second upload over a
    // key the ledger already describes, and completing that one overwrites the
    // object other members of the studio are pointed at by dedup.
    const claim = await ingestReportService.claimFinalize({
      storageKey,
      uploadId,
    });
    if (!claim.granted) {
      logger.info({ key: storageKey, reason: claim.reason }, "upload_finalize_refused");
      return claim.reason === "no_grant"
        ? c.json({ error: { message: t("server.error.not_found") } }, 404)
        : c.json({ error: { message: t("server.error.conflict") } }, 409);
    }

    // The Worker could not turn the parts into an object: it failed to
    // assemble them, or to read the result back to hash it. The bytes stay in
    // R2 for the sweep to collect, and the grant and the task row are ours to
    // settle — nothing else will, now that the Worker reports to nobody.
    let answered;
    try {
      answered = await finishUploadAtIngest(
        env.INGEST_BASE_URL,
        { uploadId, token: c.req.header("x-upload-token") ?? "", parts },
        env.INGEST_SHARED_SECRET,
        // What the ticket signed is what a reader will be served, so it is
        // what decides whether there is a frame to cut; the key it goes to is
        // derived from the video's own, so re-delivering this request names
        // the same place rather than leaving a second frame behind.
        assetService.coverRequestFor(storageKey),
        assetService.mediaLimits(),
      );
    } catch (err) {
      // Both ways this can go wrong end here: the Worker refused, or it
      // answered something the ledger cannot be written from. Either way the
      // bytes stay in R2 for the sweep, and the grant and the task row are
      // ours to settle.
      logger.error({ err, key: storageKey }, "upload_finish_failed");
      noteIngestSideEffects(
        storageKey,
        await ingestReportService.applyIngestReport({
          storageKey,
          outcome: "aborted",
        }),
      );
      return c.json({ error: { message: t("server.error.internal") } }, 502);
    }

    const outcome = await ingestReportService.applyIngestReport({
      storageKey,
      outcome: "completed",
      ...answered,
    });
    noteIngestSideEffects(storageKey, outcome);

    if (outcome.status === "rejected") {
      logger.info(
        { key: storageKey, size: answered.sizeBytes, reason: outcome.reason },
        `ingest_report_${outcome.reason}`,
      );
      return outcome.reason === "over_cap"
        ? c.json({ error: { message: t("server.error.upload_too_large") } }, 413)
        : c.json({ error: { message: t("server.error.upload_empty") } }, 422);
    }
    if (outcome.status === "stale" || outcome.status === "voided") {
      logger.info({ key: storageKey, status: outcome.status }, "ingest_report_stale");
      return c.json({ data: { ok: true } });
    }
    logger.info({ key: storageKey, status: outcome.status }, "ingest_report_registered");
    return c.json({
      data: {
        ok: true,
        // The ledger row this key ended up on, which a caller hanging
        // something off the asset needs (a video's cover, #181 §4.6).
        assetId: outcome.assetId,
        fileUrl: outcome.fileUrl,
        kind: outcome.kind,
      },
    });
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
  validate("json", deletedSchema),
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
