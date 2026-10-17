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
import { createMiddleware } from "hono/factory";
import { validate } from "@server/middleware/validate.js";
import { z } from "zod";
import {
  verifySessionToken,
  reduceMediaType,
  isUploadableMediaType,
  INGEST_NOT_STARTED,
  UPLOAD_STATUS_MAX_KEYS,
  t,
} from "@breatic/shared";
import {
  MINI_TOOLS,
  miniToolById,
  mostOutputsOf,
} from "@breatic/shared/mini-tools";
import {
  assetService,
  ingestReportService,
  mediaReadService,
  studioAuthService,
  uploadStatusService,
  UPLOAD_FINISH_QUEUE,
  type UploadFinishJob,
} from "@breatic/domain";
import {
  issueUploadTicket,
  issueUploadTicketBatch,
  type TicketOutcome,
} from "@server/modules/asset/upload-ticket.service.js";
import { noteIngestSideEffects } from "@server/modules/asset/ingest-side-effects.js";
import { requireAuth } from "@server/middleware/auth.js";
import type { AuthVariables } from "@server/middleware/auth.js";
import { rateLimitFor } from "@server/middleware/rate-limit.js";
import {
  assertStudioStorageAllowance,
  projectService,
} from "@server/modules";
import {
  createQueue,
  defaultJobOpts,
  getStorageConfig,
  getStorageAdapter,
  env,
  logger,
} from "@breatic/core";
import { recordProjectActivity } from "@server/modules/activity/projectActivity.service.js";

const assets = new Hono<{ Variables: AuthVariables }>();

/** Finishing a browser upload, which runs as a job (inner#1367 §4.2a). */
const uploadFinishQueue = createQueue(UPLOAD_FINISH_QUEUE);

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
      uploadIdleTimeoutMs: upload.upload_idle_timeout_seconds * 1000,
      uploadStatusPollSeconds: upload.upload_status_poll_seconds,
      assetUrlPrefix: store.publicUrl(""),
    },
  });
});

// ── Upload status (inner#1367 §4.2a) ────────────────────────────────

/**
 * How the caller's uploads ended. Finishing answers 202 and runs as a job, so
 * the page asks here — every upload it is waiting on, in one request — until
 * each has an ending. A key that is not the caller's reads as `unknown`.
 */
assets.get(
  "/upload-status",
  requireAuth,
  rateLimitFor("upload-status", "user"),
  validate(
    "query",
    z.object({
      // One `key` arrives as a string, several as an array.
      key: z.preprocess(
        (v) => (Array.isArray(v) ? v : [v]),
        z.array(z.string().min(1).max(512)).min(1).max(UPLOAD_STATUS_MAX_KEYS),
      ),
    }),
  ),
  async (c) => {
    const user = c.get("user");
    const { key } = c.req.valid("query");
    const items = await uploadStatusService.statusOf(user.id, key);
    c.header("Retry-After", String(getStorageConfig().upload.upload_status_poll_seconds));
    return c.json({ data: { items } });
  },
);

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

/** The browser tools whose results land in a group: the only ones that upload many files at once. */
const GROUPED_TOOLS = MINI_TOOLS.filter((spec) => spec.run.kind === "browser" && spec.groupOutputs === true);

/**
 * One browser tool's export of many files, each onto its own node of one
 * Space (inner#1303 §7). A cover or an avatar is one file and uses the single
 * form, so neither `studio_id` nor `purpose` is taken here.
 */
const uploadTicketBatchSchema = z
  .strictObject({
    project_id: z.string().uuid(),
    space_id: z.string().uuid(),
    source: z.literal("mini_tool"),
    tool_name: z.string().refine((id) => GROUPED_TOOLS.some((spec) => spec.id === id)),
    items: z
      .array(
        z.strictObject({
          filename: uploadTicketFields.shape.filename,
          content_type: uploadTicketFields.shape.content_type,
          size: uploadTicketFields.shape.size,
          client_hash: uploadTicketFields.shape.client_hash,
          node_id: z.string().uuid(),
        }),
      )
      .min(1)
      .max(Math.max(...GROUPED_TOOLS.map(mostOutputsOf))),
  })
  .superRefine((body, ctx) => {
    if (new Set(body.items.map((item) => item.node_id)).size !== body.items.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["items"], message: "each file lands on its own node" });
    }
  });

/**
 * The wire shape of a ticket or a dedup hit.
 * @param outcome - The answer, other than a refusal.
 * @returns What the browser reads.
 */
function ticketBody(outcome: Exclude<TicketOutcome, { kind: "refused" }>): Record<string, unknown> {
  return outcome.kind === "alreadyExists"
    ? {
        alreadyExists: true,
        // The row a cover or an avatar is then pointed at.
        assetId: outcome.assetId,
        fileUrl: outcome.fileUrl,
        kind: outcome.assetKind,
        // The picture's size, read off it when it was stored (inner#1367).
        width: outcome.width,
        height: outcome.height,
      }
    : {
        ticket: outcome.ticket,
        storageKey: outcome.storageKey,
        uploadUrl: outcome.uploadUrl,
        kind: outcome.assetKind,
        partSize: outcome.partSize,
        totalParts: outcome.totalParts,
        // Which task row this upload is. The browser keys a failed upload's
        // File by it, so two uploads onto one node each keep their own (#186
        // §3.7.2). Absent on an upload with no node.
        taskId: outcome.taskId,
      };
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
  validate("json", z.union([uploadTicketSchema, uploadTicketBatchSchema])),
  async (c) => {
    const user = c.get("user");
    const body = c.req.valid("json");

    // A batch answers every file in order, each a ticket, a hit or a refusal.
    if ("items" in body) {
      await projectService.assertAccess(body.project_id, user.id, "editor");
      const studioId = await assetService.resolveOwnerStudioId(body.project_id);
      const outcomes = await issueUploadTicketBatch(
        { userId: user.id, studioId, projectId: body.project_id },
        { spaceId: body.space_id, toolName: body.tool_name },
        body.items,
      );
      return c.json({
        data: {
          items: outcomes.map((outcome) =>
            outcome.kind === "refused" ? { refused: { reason: outcome.reason } } : ticketBody(outcome),
          ),
        },
      });
    }

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

    const outcome = await issueUploadTicket(
      { userId: user.id, studioId, projectId: body.project_id },
      body,
      async () => {
        await assertStudioStorageAllowance(studioId, "upload");
        return true;
      },
    );
    if (outcome.kind === "refused") {
      return c.json({ error: { message: t("server.error.upload_too_large") } }, 413);
    }
    return c.json({ data: ticketBody(outcome) }, outcome.kind === "alreadyExists" ? 200 : 201);
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
/** The upload a token was signed for, as the Worker signed it. */
type UploadSession = NonNullable<Awaited<ReturnType<typeof verifySessionToken>>>;

/**
 * Admit a request whose upload token was signed for the upload in its path,
 * and hand the signed session on. It runs before the limiter, which keeps one
 * bucket per user and upload id: only an id the Worker signed gets one.
 */
const requireUploadSession = createMiddleware<{ Variables: { uploadSession: UploadSession } }>(async (c, next) => {
  const session = await verifySessionToken(c.req.header("x-upload-token") ?? "", env.INGEST_SHARED_SECRET, Date.now());
  if (session === null || session.uploadId !== c.req.param("uploadId")) {
    return c.json({ error: { code: 401, message: t("server.auth.not_authenticated") } }, 401);
  }
  c.set("uploadSession", session);
  await next();
});

assets.post(
  "/uploads/:uploadId/complete",
  requireAuth,
  requireUploadSession,
  rateLimitFor("upload-complete", { userAndParam: "uploadId" }),
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
    const session = c.get("uploadSession");
    const { storageKey, uploadId } = session;

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

    // Finishing lasts as long as the Worker takes, bounded by the upload's two
    // hours, so it runs as a job and the browser learns the ending from the
    // status query (inner#1367 §4.2a). The key is the job id: a browser that
    // did not hear 202 sends this again, and a job with that id already queued
    // or kept takes no second one.
    try {
      await uploadFinishQueue.add(
        "finish",
        {
          storageKey,
          uploadId,
          token: c.req.header("x-upload-token") ?? "",
          parts,
          assetSource: claim.assetSource,
        } satisfies UploadFinishJob,
        { ...defaultJobOpts(), jobId: storageKey },
      );
    } catch (err) {
      logger.error({ err, key: storageKey }, "upload_finish_enqueue_failed");
      noteIngestSideEffects(
        storageKey,
        await ingestReportService.applyIngestReport({
          storageKey,
          outcome: "aborted",
          reason: INGEST_NOT_STARTED,
        }),
      );
      return c.json({ error: { message: t("server.error.internal") } }, 502);
    }
    return c.json({ data: { storageKey } }, 202);
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
