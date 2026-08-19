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
import { validate } from "@server/middleware/validate.js";
import { z } from "zod";
import { t } from "@breatic/shared";
import { requireAuth } from "@server/middleware/auth.js";
import type { AuthVariables } from "@server/middleware/auth.js";
import { rateLimitFor } from "@server/middleware/rate-limit.js";
import {
  assertStorageAllowance,
  assetUploadService,
  projectService,
} from "@server/modules";
import {
  getStorageAdapter,
  getStorageConfig,
  env,
  logger,
  ValidationError,
} from "@breatic/core";
import { assetService, nodeHistoryService } from "@breatic/domain";
import { recordProjectActivity } from "@server/modules/activity/projectActivity.service.js";

const assets = new Hono<{ Variables: AuthVariables }>();

// ── File kind detection ─────────────────────────────────────────────

/**
 * Classify an upload into a coarse asset kind from its MIME type.
 *
 * Matches on the MIME **top-level type** rather than an allow-list of
 * subtypes. The type is authoritative — sniffed from the bytes (#1826 §4.2,
 * `sniffMimeType` via file-type), and `image/*` / `video/*` / `audio/*` is
 * exactly what the media-type registry means by those families. A narrow
 * subtype allow-list silently mis-files every format not enumerated: it dropped
 * sniffed avif / heic / bmp / tiff back to 'file' (the very #1825 symptom this
 * slice fixes), and the same trap bit us in #1824 when Firefox's .ogv fell
 * outside a video allow-list. New codecs must not require a code change.
 * @param contentType - The MIME content type of the uploaded file.
 * @returns The detected asset kind: `image`, `video`, `audio`, `document` (text/PDF), or `file` for anything else.
 */
function detectKind(contentType: string): "image" | "video" | "audio" | "document" | "file" {
  if (contentType.startsWith("image/")) return "image";
  if (contentType.startsWith("video/")) return "video";
  if (contentType.startsWith("audio/")) return "audio";
  if (contentType.startsWith("text/") || contentType === "application/pdf") return "document";
  return "file";
}

// ── Upload config (#1609 slice 2) ───────────────────────────────────

/**
 * `GET /assets/upload-config` — browser upload knobs from
 * `config/storage.yaml` (`upload:` section). The frontend fetches this
 * once per session and caches it: the upload size cap (pre-checked on file
 * selection; authoritatively enforced by /presign), the retry attempts and
 * backoff base for **presign**, and the floor and rate that size the PUT's
 * stall guard.
 *
 * The PUT's retry count is deliberately absent. It used to share the presign
 * figure; the browser PUT now goes through the shared HTTP transport, which
 * owns how many times it is delivered, so no knob here can move it.
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
  filename: z
    .string()
    .min(1)
    .max(255)
    // Reject path separators + control chars (#1630 hardening): the
    // filename's extension is spliced into the storage key, so a "/" or
    // "\\" could inject a stray path segment. Everything else — Unicode
    // letters (Chinese / Japanese filenames), spaces, punctuation — stays
    // allowed; this is a global product, an ASCII-only whitelist would
    // wrongly reject legitimate non-Latin filenames.
    // eslint-disable-next-line no-control-regex -- rejecting control chars IS the intent
    .regex(/^[^/\\\x00-\x1f\x7f]+$/, "filename contains an unsafe character"),
  content_type: z.string().min(1).max(100),
  project_id: z.string().uuid(),
  /** Declared byte size — the authoritative upload-cap gate input. */
  size: z.coerce.number().int().positive(),
  /**
   * Client-computed content hash — REQUIRED (user decision 2026-07-26, "no
   * hash, no upload"). It is the ticket for the whole storage design: the
   * instant-dedup lookup below, within-studio dedup, and the ledger row
   * (`studio_assets.content_hash` is NOT NULL) all key on it. Refusing here
   * rather than at `/uploaded` means a hashless client never receives an
   * upload grant, so it cannot burn bandwidth storing bytes that could never
   * be registered — and whose key a node would then pin as an offline-GC
   * orphan → 404.
   */
  hash: z.string().regex(SHA256_HEX),
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
  validate("query", presignSchema),
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
    const dedupHit = await assetUploadService.checkUploadDedup({
      projectId: project_id,
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

    // #89: storage gate. AFTER the dedup return above, deliberately — that
    // path mints no key, issues no grant and adds no `studio_assets` row, so
    // it consumes nothing and there is nothing to refuse. From here on the
    // upload is real, so a full account stops here and gets no upload URL.
    await assertStorageAllowance(project_id, "upload");

    const kind = detectKind(content_type);
    // storageKey's ext contract is dotted (#1630): the upload filename yields a
    // BARE extension ("png"), so dot it — the caller owns the format.
    const ext = `.${filename.split(".").pop() ?? "bin"}`;
    // Missed dedup → mint a tenant-neutral key + record the upload grant that
    // the upload endpoints later re-check for authenticity (#1826, design §2.2).
    // The dedup-hit path above already returned (no key, no grant).
    const { key } = await assetUploadService.issueUploadGrant({
      projectId: project_id,
      actingUserId: user.id,
      contentHash: hash,
      declaredSize: size,
      taskType: kind,
      ext,
    });

    const adapter = await getStorageAdapter();
    let uploadUrl: string;

    if (adapter.getUploadUrl) {
      // S3 / OSS — presigned PUT directly to cloud. The PUT window is the
      // provider's own (config, not the grant ledger — design §3.2).
      uploadUrl = await adapter.getUploadUrl(
        key,
        content_type,
        upload.presign_expires_seconds,
      );
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
  // is the write-time gate; it does NOT consume (/uploaded consumes once). It
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
    /**
     * Content sha256 — REQUIRED (user decision 2026-07-26, "no hash, no
     * upload"): regular path → ledger registration, dedup path → the lookup
     * key. The client refuses to upload without one; this enforces the same
     * rule independently, because a client can always be bypassed and a
     * hashless report could only ever pin an unregisterable (orphan) key.
     */
    hash: z.string().regex(SHA256_HEX),
    node_id: z.string().min(1).max(128).optional(),
    space_id: z.string().uuid().optional(),
    kind: z.string().min(1).max(32),
    /**
     * Upload sub-type. `mini_tool` marks a FRONTEND-executed mini-tool product
     * (pure media transform in the browser, never through worker Stage 4) - the
     * feed row lands as generation:succeeded. `cover` marks a video's cover
     * (#1826 §4.5) - registered as a first-class source='cover' studio_assets
     * row (paired with derived:true so it does not announce its own feed row).
     * Plain uploads omit it.
     */
    source: z.enum(["mini_tool", "cover"]).optional(),
    tool_name: z.string().max(64).optional(),
    /**
     * #1824 / #1826 §4.5: the uploaded video's cover reference. The cover is a
     * first-class studio_assets row (registered by its own derived report); the
     * video report rides only the cover's content HASH, and the server reads
     * that row's canonical URL by it (client URLs never trusted). Absent for a
     * non-video upload, which simply has no thumbnail. PRESENT means the caller
     * claims a cover, and a claim the server cannot resolve fails the report
     * (422) rather than degrading — see the resolution block in the handler.
     */
    cover_hash: z.string().regex(SHA256_HEX).optional(),
    /**
     * #1824: marks a DERIVED byproduct (auto-extracted cover / focus crop) —
     * registered in the ledger but NOT announced as its own activity-feed row
     * (product model A: the feed carries user events, not byproducts). A real
     * user upload omits it. First-class semantic, NOT inferred from node_id
     * absence (a future document-space upload has no node_id yet IS a feed
     * event).
     */
    derived: z.literal(true).optional(),
    metadata: z
      .object({
        filename: z.string().max(255),
        size: z.number().int().positive(),
        mimeType: z.string().max(100),
      })
      .optional(),
  })
  .superRefine((val, ctx) => {
    // (`hash` is unconditionally required by the field schema now — "no hash,
    // no upload" — so the old dedup→hash refinement is redundant.)
    if (val.dedup !== true && val.key === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "key is required for an upload report",
        path: ["key"],
      });
    }
    // Deliberately NOT tying cover_hash to kind==='video': the reported `kind`
    // is CLIENT input (`kind: z.string()`, never recomputed here — the
    // authoritative kind comes from detectKind(head().contentType) at
    // registration), so gating on it would be security theatre: a caller who
    // wanted to attach a cover to a non-video would simply report
    // kind='video'. It would also 422 legitimate reports whose bytes sniff to
    // something other than video/* — the failure mode #1824 actually hit.
    // A cover's integrity is bounded instead by verifyDedupUpload (#1826 §4.5:
    // cover_hash must resolve to a studio_assets row in this report's owner
    // studio — the GRANT's studio on the regular path, resolveOwnerStudioId's on
    // the dedup path. Since #1839 both are decided by a project, never by who
    // is calling).
    // The residual — an editor showing ANY asset from that studio, including
    // one another member put there. The lookup is kind-agnostic: it matches on
    // (studio_id, content_hash) with no kind predicate, so a pdf or mp3 in the
    // same studio resolves too and simply renders broken. The resolved cover
    // reaches three sinks: the node_history row's thumbnail, the project
    // activity row's thumbnail, and the response body — from which the client
    // writes it onto the node as `data.coverUrl`, the video poster in the
    // shared Yjs doc that every collaborator sees. ACCEPTED as LOW: it is
    // cosmetic, and the video's own bytes (`data.content`) are untouched. It
    // belongs to the same accepted class as the other within-studio residuals:
    // inviting someone into a studio is an act of trust, see asset.service.ts.
  });

assets.post(
  "/uploaded",
  requireAuth,
  rateLimitFor("asset-report", "user"),
  validate("json", uploadedSchema),
  async (c) => {
    const user = c.get("user");
    const body = c.req.valid("json");

    await projectService.assertAccess(body.project_id, user.id, "editor");

    // ONE authoritative owner studio for the WHOLE report (Gate-2 R9), resolved
    // before anything is read or written. Both halves of a video report (the
    // video and its cover) and the ledger row itself must agree on it:
    //
    //   - regular path: the GRANT's studio. It was resolved server-side at
    //     presign, so it cannot be steered by the report's `project_id` — the
    //     H7 hole. The same lookup authorises the report and binds it to the
    //     content the grant was issued for (R7).
    //   - dedup path: derived from the project, because an instant-dedup report
    //     uploads nothing and therefore has no grant to read (design §4.1
    //     step 0). `assertAccess` above already proved the caller may write
    //     here, and register is never reached on this path — nothing new is
    //     attributed, an existing row is merely re-served.
    let ownerStudioId: string;
    if (body.dedup === true) {
      ownerStudioId = await assetService.resolveOwnerStudioId(body.project_id);
    } else if (body.key !== undefined) {
      const granted = await assetUploadService.resolveGrantForReport({
        storageKey: body.key,
        actingUserId: user.id,
        contentHash: body.hash,
      });
      if (granted === null) {
        return c.json(
          { error: { message: t("server.error.validation") } },
          422,
        );
      }
      ownerStudioId = granted;
    } else {
      // Unreachable: the schema superRefine guarantees dedup→hash and
      // regular→key. Kept for TS narrowing + defence in depth.
      return c.json({ error: { message: t("server.error.validation") } }, 422);
    }

    // Cover thumbnail (#1824 / #1826 §4.5): the cover is a FIRST-CLASS
    // studio_assets row, registered by its OWN (derived, source='cover')
    // /uploaded report. Here the video report just reads that row's canonical
    // URL by the cover's content hash — no key-derivation, no isOwnedKey, no
    // kindFromStorageKey (all retired with the tenant-neutral key).
    //
    // FAIL-CLOSED, like everything else on this endpoint (zero exceptions, user
    // 2026-07-26). A report that CLAIMS a cover is one atomic half of a video
    // upload (#1816: "a video never lands without its cover"); the client
    // registers the cover FIRST and awaits it, so the row exists by now.
    // Failing to read it back is data trouble, not "no cover" — degrading would
    // land precisely the state #1816 forbids. The #1824 "a cover failure never
    // fails the video" invariant governs the WORKER path (an already-billed AI
    // video whose cover is genuinely auxiliary), which calls
    // assetService.register directly and never reaches this endpoint.
    //
    // Resolved BEFORE any write: this is a pure read, so failing here costs the
    // caller nothing — no ledger row, no consumed grant, no audit rows.
    let coverUrl: string | undefined;
    if (body.cover_hash !== undefined) {
      try {
        const coverAsset = await assetUploadService.verifyDedupUpload({
          studioId: ownerStudioId,
          contentHash: body.cover_hash,
        });
        if (!coverAsset) {
          return c.json(
            { error: { message: t("server.error.validation") } },
            422,
          );
        }
        coverUrl = coverAsset.fileUrl;
      } catch (err) {
        logger.error(
          {
            err,
            projectId: body.project_id,
            coverHash: body.cover_hash,
            userId: user.id,
          },
          "cover_resolve_failed",
        );
        return c.json(
          { error: { message: t("server.error.validation") } },
          422,
        );
      }
    }

    let fileUrl: string;
    // The AUTHORITATIVE kind, for every sink (Gate-2 R9). §4.2's rule — type
    // comes from what was STORED, never from the client — cannot hold for the
    // ledger row and not for the audit rows a human actually reads. `body.kind`
    // is unverified client input; on the regular path the truth is
    // detectKind(sniffed mime), on the dedup path it is the existing row's own
    // kind (itself sniffed when that row was registered).
    let authoritativeKind: string;
    if (body.dedup === true) {
      // Dedup path (#1609, B.2): nothing was uploaded — verify the claimed
      // (studio, hash) row server-side. The URL is re-derived from the ledger,
      // never trusted from the client. Resolved DB-only, with no storage
      // adapter: a fully-deduped report needs no storage at all, so an
      // unhealthy adapter must not drop it (fix 7beaf292, Gate-2 R3).
      const verified = await assetUploadService.verifyDedupUpload({
        studioId: ownerStudioId,
        contentHash: body.hash,
      });
      if (!verified) {
        return c.json(
          { error: { message: t("server.error.validation") } },
          422,
        );
      }
      fileUrl = verified.fileUrl;
      authoritativeKind = verified.kind;
    } else if (body.key !== undefined) {
      // The grant already authorised this report and yielded `ownerStudioId`
      // above (anti-spoof, design §3.2 — it replaces the prefix-based
      // isOwnedKey, since a tenant-neutral key has no prefix to check). It is
      // CONSUMED below, AFTER registration (§4.1 step 6): until then the
      // physical object still has an unconsumed grant as an in-flight signal
      // for the offline reclaim job.

      // Verify the object landed + read its AUTHORITATIVE size/type from
      // storage, never the client (#1825 / design §4.2).
      const adapter = await getStorageAdapter();
      const head = await adapter.head(body.key);
      if (!head.exists) {
        return c.json(
          { error: { message: t("server.error.validation") } },
          422,
        );
      }
      // Re-check the AUTHORITATIVE size against the cap (design §4.2, round-2):
      // presign's declared-size gate is UX only; a client that declared 1 KB
      // then PUT 50 GB is caught HERE → 413.
      if (head.size > getStorageConfig().upload.max_upload_bytes) {
        return c.json(
          { error: { message: t("server.error.upload_too_large") } },
          413,
        );
      }
      // Pre-register fallback only: every accepted upload carries a hash and
      // therefore registers ("no hash, no upload", §0 rule 4), so this is
      // ALWAYS overridden below by the registered row's canonical (§0 rule 2).
      fileUrl = adapter.publicUrl(body.key);

      // Ledger registration (#1609): size + content type come from what STORAGE
      // reports (head()), never the client. The dedup KEY (content_hash) IS the
      // client-asserted hash — the browser path trusts it (bounded to
      // studio-scoped insiders; the OFFLINE #1631 sweep re-hashes + quarantines
      // mismatches). The hash is always present (the schema requires it — "no
      // hash, no upload"), so EVERY accepted upload registers; there is no
      // "stored but untracked" state any more. A cover report (source='cover',
      // #1826 §4.5) registers as a first-class row that counts toward storage.
      const mimeType =
        head.contentType !== ""
          ? head.contentType
          : (body.metadata?.mimeType ?? "application/octet-stream");
      try {
        const { asset, reclaimQueueFailed } = await assetService.register({
          projectId: body.project_id,
          actingUserId: user.id,
          ownerStudioId,
          contentHash: body.hash,
          storageKey: body.key,
          fileUrl,
          sizeBytes: head.size,
          mimeType,
          kind: detectKind(mimeType),
          source: body.source === "cover" ? "cover" : "upload",
        });
        authoritativeKind = detectKind(mimeType);
        if (reclaimQueueFailed === true) {
          // The registration SUCCEEDED — this upload deduped against an
          // existing row, and only the bookkeeping insert that hands the
          // now-redundant object to the offline reclaim job failed. The library
          // layer may not log (@domain/CLAUDE.md), so it reports the failure as
          // a sentinel and THIS is where it becomes traceable: dropping it
          // would leave an object silently absent from the offline work list.
          logger.warn(
            {
              key: body.key,
              hash: body.hash,
              studioId: ownerStudioId,
              userId: user.id,
            },
            "asset_reclaim_queue_failed",
          );
        }
        // §0 rule 2 / §4.1 step 6: pin the REGISTERED row's canonical, never
        // body.key. On a concurrent same-content hit register() returns the
        // WINNER's row (its storage_key); body.key is then a loser orphan
        // (no live row) → offline GC reclaims it → 404. Pinning the row's
        // key is correct for both the single-writer and the dedup case.
        fileUrl = adapter.publicUrl(asset.storageKey);
      } catch (err) {
        logger.error(
          { err, projectId: body.project_id, key: body.key, userId: user.id },
          "asset_ledger_register_failed",
        );
        // §0 rule 3 (register fail-closed): an upload whose URL gets persisted
        // must never be pinned to an unregistered key (offline reclaim → 404).
        // Fail the report with 422 WITHOUT consuming the grant, so the client
        // retries (the physical object stays an in-flight orphan for the
        // offline job).
        //
        // NO EXCEPTIONS on this endpoint (user 2026-07-26). Earlier revisions
        // gated on node_id, then on "everything except the cover"; both were
        // wrong the same way — they tried to guess which uploads "have
        // something pinned to them". Every upload arriving here is a user's
        // upload: node content, the panel's focusImages (the CROP path, which
        // carries no node_id — and document / timeline spaces have no nodes at
        // all), a mini-tool output, and the COVER, which #1816 made one atomic
        // half of a video upload ("a video never lands without its cover and a
        // cover never lands without its video"). A cover that cannot be
        // REGISTERED therefore fails the upload exactly like a cover that could
        // not be PUT. The #1824 "a cover failure never fails the video"
        // invariant belongs to the WORKER path — an AI-generated video, already
        // billed, whose cover is genuinely auxiliary — and that path calls
        // assetService.register directly, never reaching this endpoint.
        return c.json(
          { error: { message: t("server.error.validation") } },
          422,
        );
      }

      // Consume the grant exactly once, AFTER registration (anti-replay; design
      // §4.1 step 6). A replay / concurrent second caller on this key → 422.
      const consumed = await assetUploadService.consumeUploadGrant({
        storageKey: body.key,
        actingUserId: user.id,
      });
      if (!consumed) {
        return c.json(
          { error: { message: t("server.error.validation") } },
          422,
        );
      }
    } else {
      // Unreachable: the schema superRefine guarantees dedup→hash and
      // regular→key. Kept for TS narrowing + defense in depth.
      return c.json({ error: { message: t("server.error.validation") } }, 422);
    }


    // Node history record (version timeline), when node-bound. Carries the
    // cover as the row's thumbnail (#1824, consumer ①).
    if (body.node_id) {
      try {
        await nodeHistoryService.recordUpload({
          projectId: body.project_id,
          nodeId: body.node_id,
          userId: user.id,
          content: fileUrl,
          thumbnailUrl: coverUrl,
          metadata: body.metadata,
        });
      } catch (err) {
        logger.warn(
          { err, projectId: body.project_id, nodeId: body.node_id },
          "upload_history_record_failed",
        );
      }
    }

    // Activity feed (#1824, product model A): a DERIVED byproduct (cover /
    // crop, `derived: true`) is registered in the ledger above but NOT
    // announced as its own feed row. A real upload emits its row, carrying the
    // cover as the row's thumbnail (consumer ②).
    if (body.derived !== true) {
      // BEST-EFFORT, like the node-history sink above: by this point the upload
      // has FULLY succeeded (bytes stored, ledger row written, grant consumed).
      // This endpoint now GATES the client's node pin (§4.1 step 7), so letting
      // an audit-sink blip escape would report a completed upload as failed and
      // make the user re-upload the whole file — for a feed that is a flat
      // ledger by design (v14: duplicates are acceptable, no idempotency).
      try {
        await recordProjectActivity({
          projectId: body.project_id,
          actorUserId: user.id,
          type:
            body.source === "mini_tool" ? "generation:succeeded" : "asset:uploaded",
          spaceId: body.space_id ?? null,
          nodeId: body.node_id ?? null,
          payload:
            body.source === "mini_tool"
              ? {
                  source: "mini_tool",
                  ...(body.tool_name !== undefined && { toolName: body.tool_name }),
                  executedOn: "frontend",
                  fileUrl,
                  kind: authoritativeKind,
                }
              : {
                  fileUrl,
                  kind: authoritativeKind,
                  ...(coverUrl !== undefined && { thumbnailUrl: coverUrl }),
                },
        });
      } catch (err) {
        logger.warn(
          { err, projectId: body.project_id, key: body.key, userId: user.id },
          "upload_activity_record_failed",
        );
      }
    }

    // Return the REGISTERED canonical(s) so the client pins them, never the
    // presign temp key (#1826 §0 rule 2 / §4.1 step 7). `coverUrl` is the
    // server-resolved cover canonical; it is absent only when the report
    // carried no cover_hash at all (anything that is not a video). A cover
    // that WAS claimed but could not be resolved already 422'd above — this
    // response never carries a silently degraded cover.
    return c.json({
      data: { ok: true, fileUrl, ...(coverUrl !== undefined && { coverUrl }) },
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
