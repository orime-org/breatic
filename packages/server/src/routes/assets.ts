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
  UploadHttpError,
  INGEST_REFUSED_UNNAMED,
  t,
  type NodeTaskAction,
} from "@breatic/shared";
import {
  miniToolById,
} from "@breatic/shared/mini-tools";
import {
  assetService,
  ingestReportService,
  mediaReadService,
  studioAuthService,
  uploadTicketService,
} from "@breatic/domain";
import { openUpload } from "@server/modules/asset/upload-opening.js";
import { noteIngestSideEffects } from "@server/modules/asset/ingest-side-effects.js";
import { safeExt } from "@server/modules/asset/sourceUrl.js";
import { requireAuth } from "@server/middleware/auth.js";
import type { AuthVariables } from "@server/middleware/auth.js";
import { rateLimitFor } from "@server/middleware/rate-limit.js";
import {
  assertStudioStorageAllowance,
  assetUploadService,
  projectService,
} from "@server/modules";
import {
  coverKeyFor,
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
 *
 * `assetUrlPrefix` is what every stored object's public URL starts with. A
 * document body keeps a pasted media block only when its address is one of
 * ours (inner#1127 A18), and this side is the one that knows the bucket's
 * public base.
 */
assets.get("/upload-config", requireAuth, async (c) => {
  const { upload } = getStorageConfig();
  const store = await getStorageAdapter();
  return c.json({
    data: {
      maxUploadBytes: upload.max_upload_bytes,
      clientMaxAttempts: upload.client_max_attempts,
      clientRetryBaseDelayMs: upload.client_retry_base_delay_ms,
      clientRequestTimeoutMs: upload.client_request_timeout_ms,
      clientPutMinBytesPerSec: upload.client_put_min_bytes_per_sec,
      assetUrlPrefix: store.publicUrl(""),
    },
  });
});

// ── Upload ticket (#173) ────────────────────────────────────────────

/** sha256 hex — the only hash shape the dedup ledger stores. */
const SHA256_HEX = /^[0-9a-f]{64}$/;

const uploadTicketFields = z.object({
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
  /** The browser tool whose export this is; present exactly when `source` is. */
  tool_name: z
    .string()
    .refine((id) => miniToolById(id)?.run.kind === "browser")
    .optional(),
  derived: z.boolean().optional(),
});

/**
 * Where the bytes land: a project, or — for its avatar — a studio, which is
 * the only thing a studio uploads on its own account. `purpose` is what the
 * picture is being uploaded to become; it is filed as the asset's source and
 * grants nothing, since what makes a picture a cover or an avatar is the call
 * that points at it afterwards.
 */
const uploadTicketSchema = z
  .union([
    uploadTicketFields.extend({
      project_id: z.string().uuid(),
      studio_id: z.never().optional(),
      purpose: z.literal("project_cover").optional(),
    }),
    uploadTicketFields.extend({
      studio_id: z.string().uuid(),
      project_id: z.never().optional(),
      purpose: z.literal("studio_avatar"),
      node_id: z.never().optional(),
      space_id: z.never().optional(),
    }),
  ])
  // A cover or an avatar can only ever be pointed at a picture, and its media
  // read is deferred on the strength of that (#299). So a purpose is taken for
  // a picture alone, and a cover lands on no node.
  .superRefine((body, ctx) => {
    // A browser tool's export names the tool its row is shown under.
    if ((body.source === undefined) !== (body.tool_name === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["tool_name"],
        message: "a mini-tool upload names its tool, and only a mini-tool upload does",
      });
    }
    if (body.purpose === undefined) return;
    if (!mediaReadService.purposeAccepts(body.content_type)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["content_type"],
        message: "a purpose takes a picture only",
      });
    }
    if (body.node_id !== undefined || body.space_id !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["node_id"],
        message: "a picture uploaded for a purpose lands on no node",
      });
    }
  });

/**
 * What an upload's task row says: a browser tool's export is shown as that
 * tool, every other upload by its file name.
 * @param body - The ticket request.
 * @param body.source - What started the upload.
 * @param body.tool_name - The browser tool, on a mini-tool upload.
 * @param body.filename - The picked file's name.
 * @returns The row's action and label.
 */
function uploadRowOf(body: {
  source?: "mini_tool" | undefined;
  tool_name?: string | undefined;
  filename: string;
}): { action: NodeTaskAction; label: string } {
  return body.source === "mini_tool" && body.tool_name !== undefined
    ? { action: "mini_tool", label: body.tool_name }
    : { action: "upload", label: body.filename };
}

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

    // Upload is a write — edit-or-above can ask for a ticket. A project's
    // cover follows the cover rule (the studio admin may set it without being
    // on the project); a studio's own picture is its admin's to change.
    if (body.project_id !== undefined && body.purpose === "project_cover") {
      await projectService.assertMayManage(body.project_id, user.id);
    } else if (body.project_id !== undefined) {
      await projectService.assertAccess(body.project_id, user.id, "editor");
    } else {
      await studioAuthService.assertStudioRole(user.id, body.studio_id, "admin");
    }
    const studioId =
      body.project_id !== undefined
        ? await assetService.resolveOwnerStudioId(body.project_id)
        : body.studio_id;

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
      studioId,
      contentHash: body.client_hash,
      sizeBytes: body.size,
    });
    if (dedupHit) {
      logger.info(
        { hash: body.client_hash, userId: user.id, studioId, projectId: body.project_id },
        "upload_ticket_dedup_hit",
      );
      // No bytes move, but the node now shows something it did not show
      // before: a task row is opened and settled in the same pass, pointing at
      // the node's history row for this content (written now, or the one the
      // node already holds).
      // The project activity feed gets nothing, because its only shape for
      // this is `asset:uploaded` and nothing was uploaded. A studio's avatar
      // has no project and no node, so there is nothing to settle.
      if (body.project_id !== undefined) {
        await assetUploadService.settleDedupHit({
          projectId: body.project_id,
          hit: dedupHit,
          userId: user.id,
          metadata: {
            filename: body.filename,
            size: body.size,
            mimeType: body.content_type,
          },
          row: uploadRowOf(body),
          nodeId: body.node_id,
          spaceId: body.space_id,
        });
      }
      return c.json({
        data: {
          alreadyExists: true,
          // The row a cover or an avatar is then pointed at.
          assetId: dedupHit.assetId,
          fileUrl: dedupHit.fileUrl,
          kind: dedupHit.kind,
        },
      });
    }

    // Storage gate, after the dedup return: that path consumes nothing.
    await assertStudioStorageAllowance(studioId, "upload");

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
    const { key, taskId } = await openUpload(
      {
        ...(body.project_id !== undefined
          ? { projectId: body.project_id }
          : { studioId }),
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
          // A cover is a byproduct: in the ledger, and not announced on the
          // project feed as something uploaded to the canvas.
          derived: body.purpose === "project_cover" ? true : (body.derived ?? null),
          filename: body.filename,
          assetSource: body.purpose ?? null,
        },
      },
      {
        budgetMs: getNodeTaskConfig().default_budget_ms,
        ...uploadRowOf(body),
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

    /**
     * Settle the grant and the task row as aborted, and answer the caller.
     *
     * The bytes stay in R2 for the sweep. A format we do not take came from
     * the caller and answers 415; every other way this ends is our own side
     * failing, which 502 is the honest answer for. The status is the part
     * that carries it: 502 is retried by the client and 4xx is not, and
     * retrying a format we do not take gets the same refusal every time. What
     * a person reads is the task row, which the reason settles.
     * @param reason - Why the upload stops here.
     * @returns The 415 or 502 answer.
     */
    const refuse = async (reason: string): Promise<Response> => {
      noteIngestSideEffects(
        storageKey,
        await ingestReportService.applyIngestReport({
          storageKey,
          outcome: "aborted",
          reason,
        }),
      );
      return reason === "unsupported_type"
        ? c.json({ error: { message: t("server.error.validation") } }, 415)
        : c.json({ error: { message: t("server.error.internal") } }, 502);
    };

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
        // Named unconditionally: which media have a frame to lift is decided
        // from the type, and the type is the edge's to read off the bytes, so
        // nobody here knows it yet. The key is derived from the object's own,
        // so re-delivering this request names the same place rather than
        // leaving a second frame behind.
        coverKeyFor(storageKey),
        assetService.mediaLimits(),
        !mediaReadService.readsMediaAtFinish(claim.assetSource),
      );
    } catch (err) {
      // Both ways this can go wrong end here: the Worker refused, or it
      // answered something the ledger cannot be written from. Either way the
      // bytes stay in R2 for the sweep, and the grant and the task row are
      // ours to settle.
      //
      // An UploadHttpError exists only because an answer arrived, so a missing
      // name on it is the Worker refusing without saying why. Without the name
      // the list reads "interrupted" for every one of them, which invites a
      // retry that the edge will refuse identically.
      //
      // Nothing arriving at all keeps that same "interrupted", because on this
      // lane it is the true sentence: the bytes came off a disk the person
      // picked from, so the tokens that speak of a source and its address —
      // what the URL lane settles on here — would describe something this
      // upload never had.
      const reason =
        err instanceof UploadHttpError
          ? (err.code ?? INGEST_REFUSED_UNNAMED)
          : "aborted";
      logger.error({ err, key: storageKey, reason }, "upload_finish_failed");
      return refuse(reason);
    }

    // The ticket named a picture; this is what the bytes that landed are. A
    // cover or an avatar that turns out to be anything else is refused the way
    // a format we do not take is, before a row is written for it.
    if (!mediaReadService.storedTypeAccepted(claim.assetSource, answered.contentType)) {
      logger.info(
        { key: storageKey, contentType: answered.contentType, source: claim.assetSource },
        "upload_purpose_type_refused",
      );
      return refuse("unsupported_type");
    }

    const outcome = await ingestReportService.applyIngestReport({
      storageKey,
      outcome: "completed",
      ...answered,
    });
    noteIngestSideEffects(storageKey, outcome);

    // The row stands either way; a read that could not be queued leaves it
    // without numbers, which is how a read that failed leaves it too.
    try {
      await mediaReadService.scheduleMediaRead(outcome, claim.assetSource);
    } catch (err) {
      logger.error({ err, key: storageKey }, "media_read_enqueue_failed");
    }

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
