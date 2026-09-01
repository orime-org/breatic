// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Assets route — the browser's half of an upload (#173).
 *
 *   1. GET  /assets/upload-config  → the knobs the browser sizes its work by
 *   2. POST /assets/upload-ticket  → a signed ticket, or an instant dedup hit
 *   3. (the browser sends its parts to the ingest Worker, not to us)
 *   4. POST /assets/ingest-report  → the Worker tells us how it went
 *
 * The bytes never pass through this server. What it owns is the decision to
 * allow an upload, the row that records it, and what happens once the Worker
 * reports back.
 */

import { Hono } from "hono";
import { timingSafeEqual } from "node:crypto";
import { validate } from "@server/middleware/validate.js";
import { z } from "zod";
import { signUploadTicket, t } from "@breatic/shared";
import { assetService } from "@breatic/domain";
import { requireAuth } from "@server/middleware/auth.js";
import type { AuthVariables } from "@server/middleware/auth.js";
import { rateLimitFor } from "@server/middleware/rate-limit.js";
import {
  assertStorageAllowance,
  assetUploadService,
  ingestReportService,
  projectService,
} from "@server/modules";
import {
  getStorageAdapter,
  getStorageConfig,
  env,
  logger,
  ValidationError,
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
  // Whatever is declared here becomes the stored object's Content-Type, which
  // a public read hands straight to whoever opens the URL. The canvas only
  // ever uploads these three kinds — `fileToNodeSpec` reads every other file
  // locally into a text node and sends no bytes at all (design §4.5).
  //
  // Reduced to one essence before it is checked, because a browser honours the
  // LAST parsable value when a header carries commas: measured in Chromium,
  // "video/mp4,text/html" renders as HTML and runs the scripts in it. What
  // survives here is what the ticket signs and what R2 stores, so the value
  // the gate read is the value the browser is handed.
  content_type: z
    .string()
    .min(1)
    .max(100)
    .transform((value) => value.split(/[;,]/)[0]!.trim().toLowerCase())
    .refine(
      (value) => /^(image|video|audio)\//.test(value),
      "content_type is not an uploadable kind",
    ),
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
  /**
   * The node's fencing gen at the moment handling opened. Stored on the grant,
   * which is where every consequence of this upload reads it from, so a
   * sweep-authored failure event survives collab's CAS.
   */
  lease_gen: z.coerce.number().int().nonnegative(),
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
      // before: it gets its history row and the event that ends its handling.
      // The project activity feed gets nothing, because its only shape for
      // this is `asset:uploaded` and nothing was uploaded.
      await assetUploadService.settleDedupHit({
        projectId: body.project_id,
        hit: dedupHit,
        userId: user.id,
        leaseGen: body.lease_gen,
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
        "ingest Worker is not configured: INGEST_BASE_URL and INGEST_SHARED_SECRET are both required",
      );
    }

    const kind = assetService.detectAssetKind(body.content_type);
    // storageKey's ext contract is dotted (#1630): the upload filename yields
    // a BARE extension ("png"), so dot it — the caller owns the format.
    const ext = `.${body.filename.split(".").pop() ?? "bin"}`;

    const expiresAt = Date.now() + ingest.ticket_expires_seconds * 1000;

    const { key, studioId } = await assetUploadService.issueUploadGrant({
      projectId: body.project_id,
      actingUserId: user.id,
      declaredSize: body.size,
      taskType: kind,
      ext,
      expiresAt: new Date(expiresAt),
      leaseGen: body.lease_gen,
      context: {
        nodeId: body.node_id ?? null,
        spaceId: body.space_id ?? null,
        source: body.source ?? null,
        toolName: body.tool_name ?? null,
        derived: body.derived ?? null,
        filename: body.filename,
      },
    });

    // A single-part upload is exempt from R2's 5 MiB floor, so a small file
    // travels as one part rather than being padded up to the configured size.
    const totalParts = Math.max(
      1,
      Math.ceil(body.size / ingest.part_size_bytes),
    );
    const ticket = await signUploadTicket(
      {
        storageKey: key,
        studioId,
        userId: user.id,
        totalParts,
        partSize: ingest.part_size_bytes,
        contentType: body.content_type,
        expiresAt,
        alarmIdleSeconds: ingest.alarm_idle_seconds,
        sessionTokenTtlSeconds: ingest.session_token_ttl_seconds,
      },
      env.INGEST_SHARED_SECRET,
    );

    logger.info(
      { key, kind, totalParts, userId: user.id },
      "upload_ticket_issued",
    );

    return c.json(
      {
        data: {
          ticket,
          storageKey: key,
          uploadUrl: env.INGEST_BASE_URL,
          kind,
          partSize: ingest.part_size_bytes,
          totalParts,
        },
      },
      201,
    );
  },
);

// ── Ingest report (#173) ────────────────────────────────────────────

// A success and an abort carry different things, so they are different shapes
// rather than one shape whose fields are all optional. What a success reports
// is the only account of the stored object anyone gets: the browser's claims
// were answered before a byte moved, and nothing downstream reads the object
// back. Left optional, a success naming no hash would register a row under the
// empty string — and the second such row in a studio collides on
// `(studio_id, content_hash)`.
const ingestReportSchema = z.discriminatedUnion("outcome", [
  z.object({
    storage_key: z.string().min(1).max(512),
    outcome: z.literal("completed"),
    /** What the Worker computed over the bytes that landed. */
    sha256: z.string().regex(SHA256_HEX),
    /** What actually landed, which is the authority over what was declared. */
    size_bytes: z.coerce.number().int().nonnegative(),
    content_type: z.string().min(1).max(100),
  }),
  z.object({
    storage_key: z.string().min(1).max(512),
    outcome: z.literal("aborted"),
    reason: z.string().max(200).optional(),
  }),
]);

/**
 * Compare two secrets without leaking where they diverge.
 * @param a - The value the caller sent.
 * @param b - The value we hold.
 * @returns True when they are the same string.
 */
function secretsMatch(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  // `timingSafeEqual` throws on a length mismatch, which would itself be a
  // signal, so the lengths are compared first and the result folded in.
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * `POST /assets/ingest-report` — the ingest Worker telling us how an upload
 * went (design §4.6).
 *
 * No user session: the caller is our own Worker, and all it can prove is that
 * it holds the shared secret. Everything that decides consequences is read off
 * the grant row, so a report can name a key and say what landed, and nothing
 * else.
 */
assets.post(
  "/ingest-report",
  validate("json", ingestReportSchema),
  async (c) => {
    const presented = c.req.header("x-ingest-secret") ?? "";
    if (
      !env.INGEST_SHARED_SECRET ||
      !secretsMatch(presented, env.INGEST_SHARED_SECRET)
    ) {
      logger.warn(
        { hasSecret: presented.length > 0 },
        "ingest_report_unauthorized",
      );
      return c.json(
        { error: { code: 401, message: t("server.auth.not_authenticated") } },
        401,
      );
    }

    const body = c.req.valid("json");
    const outcome = await ingestReportService.applyIngestReport(
      body.outcome === "completed"
        ? {
            storageKey: body.storage_key,
            outcome: "completed",
            sha256: body.sha256,
            sizeBytes: body.size_bytes,
            contentType: body.content_type,
          }
        : {
            storageKey: body.storage_key,
            outcome: "aborted",
            ...(body.reason !== undefined && { reason: body.reason }),
          },
    );

    if (outcome.status === "rejected") {
      logger.info(
        {
          key: body.storage_key,
          size: body.outcome === "completed" ? body.size_bytes : undefined,
        },
        "ingest_report_over_cap",
      );
      return c.json(
        { error: { message: t("server.error.upload_too_large") } },
        413,
      );
    }
    if (outcome.status === "voided") {
      logger.info(
        {
          key: body.storage_key,
          reason: body.outcome === "aborted" ? body.reason : undefined,
        },
        "ingest_report_aborted",
      );
      return c.json({ data: { ok: true } });
    }
    logger.info(
      { key: body.storage_key, status: outcome.status },
      "ingest_report_registered",
    );
    return c.json({
      data: { ok: true, fileUrl: outcome.fileUrl, kind: outcome.kind },
    });
  },
);

// ── Local direct upload (fallback for STORAGE_PROVIDER=local) ───────

/**
 * `PUT /assets/local-upload/:key` — local storage upload target.
 *
 * Only available when STORAGE_PROVIDER=local. Write authorisation is checked
 * against the upload-grant ledger (`authorizeUploadWrite`, #1826 §3.2): the key
 * must be one issued to this user and not yet consumed. This replaced the
 * retired prefix-based `isOwnedKey` / `startsWith(user.id)` guard — the
 * tenant-neutral key carries no user prefix.
 */
assets.put("/local-upload/*", requireAuth, async (c) => {
  const user = c.get("user");

  if (env.STORAGE_PROVIDER !== "local") {
    throw new ValidationError(
      t("server.asset.direct_upload_unavailable"),
    );
  }

  // Extract the key from the URL path (everything after /local-upload/)
  const key = decodeURIComponent(
    c.req.path.replace(/^\/api\/v1\/assets\/local-upload\//, ""),
  );

  // Anti-spoof (#1826, design §3.2): the upload-grant ledger authorises this
  // write — the key must be one issued to THIS user and not yet consumed. This
  // is the write-time gate; it does NOT consume (/ingest-report consumes once). It
  // replaces the old `startsWith(user.id)` + `..`/`//` guard: the minted key is
  // tenant-neutral (no prefix to check) and a forged key isn't in the ledger,
  // so a `..`/`//` traversal attempt is rejected here before touching disk.
  const authorized = await assetUploadService.authorizeUploadWrite({
    storageKey: key,
    actingUserId: user.id,
  });
  if (!authorized) {
    return c.json({ error: { message: t("server.error.validation") } }, 422);
  }

  // Stream to disk WITHOUT buffering the whole body in memory (#1826, design
  // §4.2 — the old arrayBuffer() OOM'd on a big file). Over the authoritative
  // cap → 413 with the partial file removed.
  const adapter = await getStorageAdapter();
  const body = c.req.raw.body;
  if (adapter.uploadStream === undefined || body === null) {
    // Local always provides uploadStream; a null body is a malformed PUT.
    return c.json({ error: { message: t("server.error.validation") } }, 422);
  }
  const { upload } = getStorageConfig();
  const result = await adapter.uploadStream(key, body, upload.max_upload_bytes);
  if (!result.ok) {
    return c.json(
      { error: { message: t("server.error.upload_too_large") } },
      413,
    );
  }

  logger.info(
    { key, size: result.size, userId: user.id },
    "local_upload_received",
  );
  return c.json({ data: { key, size: result.size } });
});

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
