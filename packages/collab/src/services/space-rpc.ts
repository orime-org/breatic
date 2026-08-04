// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Collab-side handlers for client-initiated Space lifecycle RPCs.
 *
 * Authorization (ADR 2026-05-23-yjs-collab-only-write-authz + task #27):
 *
 *   - create / delete / lock / unlock / rename - caller role ≥ editor
 *   - restore                                   - caller role = owner
 *   - tab:open / tab:close                      - any role that can reach
 *     the project, viewers included: each caller manages only their OWN
 *     tab bar, and the userId comes from the connection, never the request.
 *
 * Every operation follows §6 of the 2026-08-02 step-order design:
 *
 *   1. Validate the caller's role, then run every remaining check —
 *      read-only, changing nothing.
 *   2. Move the content rows (the PG rows holding the user's actual
 *      writing) — delete soft-deletes them, restore un-deletes them,
 *      create seeds the new one — BEFORE anything becomes visible.
 *   3. Publish the meta-doc change through {@link publishMetaChange},
 *      over a DirectConnection (never read-only; the `system` user marker
 *      rides along for logging). Publishing IS the broadcast, and the
 *      broadcast is the commit boundary: a failure before it undoes
 *      exactly the content rows this call changed and answers a
 *      controlled error; a failure after it logs one complete line and
 *      still answers success, because every client already applied it.
 *   4. Append the matching `project_activities` PG row + broadcast the
 *      `activity:new` signal (best-effort — a failure here logs what a
 *      repair needs and never fails the RPC).
 *
 * Returns a `SpaceRpcResponse` whose `id` echoes the request id so
 * the client can demultiplex concurrent in-flight RPCs.
 */
import { randomUUID } from "node:crypto";

import type { Hocuspocus } from "@hocuspocus/server";
import * as Y from "yjs";

import {
  createLogger,
  encodeInitialSpaceContentState,
  projectActivitiesRepo,
  writeSpaceEntry,
  type NewProjectActivity,
} from "@breatic/core";
import * as yjsDocumentsRepo from "@collab/services/yjs-documents.repo.js";
import {
  withSpaceDeleteLock,
  SpaceDeleteLockBusyError,
} from "@collab/services/space-delete-lock.js";
import {
  spaceContentDocName,
  projectMetaDocName,
  type DocKind,
  type ProjectRole,
  type SpaceRpcRequest,
  type SpaceRpcResponse,
  ACTIVITY_NEW_SIGNAL,
  type ActivityNewSignal,
} from "@breatic/shared";

const logger = createLogger("space-rpc");

export interface SpaceRpcContext {
  hocuspocus: Hocuspocus;
}

export interface SpaceRpcCaller {
  userId: string;
  role: ProjectRole;
}

const SYSTEM_USER_ID = "system";
const SYSTEM_SOURCE = "space-rpc";

/**
 * Compact reply builder so handlers stay one-liner-y.
 * @param id - Request id echoed back so the client can demultiplex concurrent RPCs.
 * @param result - Optional Space payload returned on success (only `space:create` populates it).
 * @param result.spaceId - Id of the created Space.
 * @param result.type - Doc kind of the created Space.
 * @param result.name - Display name of the created Space.
 * @returns A success `SpaceRpcResponse` echoing the request id.
 */
function ok(
  id: string,
  result?: { spaceId: string; type: "canvas" | "document" | "timeline"; name: string },
): SpaceRpcResponse {
  return { id, ok: true, result };
}

/**
 * Compact error-reply builder mirroring {@link ok}.
 * @param id - Request id echoed back so the client can demultiplex concurrent RPCs.
 * @param code - Machine-readable error code the client branches on for UX.
 * @param message - Human-readable failure reason.
 * @returns A failure `SpaceRpcResponse` carrying the error code + message.
 */
function err(
  id: string,
  code:
    | "FORBIDDEN"
    | "NOT_FOUND"
    | "CONFLICT"
    | "INVALID_INPUT"
    | "INTERNAL",
  message: string,
): SpaceRpcResponse {
  return { id, ok: false, error: { code, message } };
}

/** Role rank - higher is more privileged. */
const ROLE_RANK: Record<ProjectRole, number> = { viewer: 1, editor: 2, owner: 3 };

/**
 * Test whether a caller's role meets a minimum privilege threshold.
 * @param role - The caller's current project role.
 * @param min - Minimum role required for the operation.
 * @returns True when `role` ranks at or above `min`.
 */
function requireAtLeast(role: ProjectRole, min: ProjectRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[min];
}

/**
 * Broadcast the `activity:new` stateless signal on the project's meta
 * doc so connected members refetch the feed's first page. No-op when
 * the doc is not loaded (nobody online - next panel open refetches via
 * REST anyway).
 * @param hocuspocus - Running Hocuspocus server holding loaded docs.
 * @param projectId - Project whose meta doc receives the signal.
 */
function broadcastActivitySignal(
  hocuspocus: Hocuspocus,
  projectId: string,
): void {
  const doc = hocuspocus.documents?.get(projectMetaDocName(projectId));
  if (!doc) return;
  try {
    doc.broadcastStateless(
      JSON.stringify({
        t: ACTIVITY_NEW_SIGNAL,
        projectId,
      } satisfies ActivityNewSignal),
    );
  } catch (e) {
    logger.warn({ err: e, projectId }, "activity_signal_broadcast_failed");
  }
}

/**
 * Append one activity row for a completed space mutation + broadcast
 * the live signal. Best-effort by design: the Yjs mutation has already
 * been applied, so failing the RPC here would make the client retry an
 * operation that already succeeded - instead the failure is logged for
 * the audit trail to be repaired from.
 * The line it writes on failure is the only remaining record of what
 * happened, so callers pass whatever a person would need to repair it by
 * hand — always the Space and the actor, and for a delete the snapshot
 * itself, because that row IS the restore entry point.
 * @param ctx - Collab context providing the Hocuspocus server.
 * @param projectId - Project the activity belongs to.
 * @param activity - The activity row minus its projectId.
 * @param logCtx - Extra fields for the line written if the row is lost.
 */
async function recordSpaceActivity(
  ctx: SpaceRpcContext,
  projectId: string,
  activity: Omit<NewProjectActivity, "projectId">,
  logCtx: Record<string, unknown> = {},
): Promise<void> {
  try {
    await projectActivitiesRepo.insert({ projectId, ...activity });
    broadcastActivitySignal(ctx.hocuspocus, projectId);
  } catch (e) {
    logger.error(
      {
        err: e,
        projectId,
        activityType: activity.type,
        spaceId: activity.spaceId,
        actorUserId: activity.actorUserId,
        ...logCtx,
      },
      "activity_record_failed",
    );
  }
}


/**
 * Read a Y.Map's contents as a plain JS object suitable for stashing
 * inside a space:deleted activity row's snapshot payload. Skips nested CRDTs - Space
 * entries are flat (id / type / name / order / locked / createdAt), so
 * `toJSON()` returns a plain object.
 * @param m - A flat Space entry Y.Map (id / type / name / order / locked / createdAt).
 * @returns The Y.Map's contents as a plain JS object suitable for a snapshot field.
 */
function snapshotMap(m: Y.Map<unknown>): Record<string, unknown> {
  return m.toJSON() as Record<string, unknown>;
}

/**
 * All Space content-doc kinds. A Space is exactly ONE of these, but its
 * content doc is uniquely identified by (projectId, spaceId) — the kind is
 * only part of the NAME. delete / restore act on every variant so a
 * missing / corrupted meta `type` can never leave the real row untouched.
 */
const SPACE_CONTENT_KINDS: readonly Exclude<DocKind, "meta">[] = [
  "canvas",
  "document",
  "timeline",
];

/** The content-doc kinds a single call actually changed. */
type TouchedKinds = readonly Exclude<DocKind, "meta">[];

/**
 * What moving a Space's content rows left behind: the kinds THIS call
 * changed, and the first failure if any kind's write rejected.
 *
 * Both fields survive a partial failure on purpose. The three UPDATEs run
 * concurrently, so when one rejects the other two may already be
 * committed — a report that dies with the failure (what `Promise.all`
 * gives) would leave the caller undoing nothing while rows sit changed.
 */
interface ContentRowsOutcome {
  touched: TouchedKinds;
  failure: unknown;
}

/**
 * Run one content-row write per kind variant and keep BOTH halves of the
 * answer: what changed, and what failed.
 * @param write - The per-kind repo write; resolves true when it changed the row.
 * @returns The kinds that changed + the first rejection (null when none).
 */
async function moveContentRows(
  write: (kind: Exclude<DocKind, "meta">) => Promise<boolean>,
): Promise<ContentRowsOutcome> {
  const settled = await Promise.allSettled(
    SPACE_CONTENT_KINDS.map(async (kind) => ({
      kind,
      changed: await write(kind),
    })),
  );
  const touched: Exclude<DocKind, "meta">[] = [];
  let failure: unknown = null;
  for (const result of settled) {
    if (result.status === "fulfilled") {
      if (result.value.changed) touched.push(result.value.kind);
    } else if (failure === null) {
      failure = result.reason;
    }
  }
  return { touched, failure };
}

/**
 * Soft-delete a Space's content-doc `yjs_documents` rows via the shared core
 * repo. Covers EVERY kind variant of the (projectId, spaceId) content doc
 * (idempotent no-op for the ones that don't exist), so the real row is
 * always covered regardless of the meta `type` field — the authoritative
 * `countLiveSpaceDocs` therefore always decrements (a ghost row left live by
 * a corrupted type could otherwise inflate the count past the >=1 floor).
 * @param projectId - Project the content doc belongs to.
 * @param spaceId - Space whose content-doc row is marked deleted.
 * @returns The kinds this call soft-deleted + the first failure, if any.
 */
async function softDeleteSpaceContentRows(
  projectId: string,
  spaceId: string,
): Promise<ContentRowsOutcome> {
  return moveContentRows((kind) =>
    yjsDocumentsRepo.softDeleteByName(
      spaceContentDocName(projectId, spaceId, kind),
    ),
  );
}

/**
 * Restore (clear deleted_at on) a Space's content-doc rows, mirroring
 * {@link softDeleteSpaceContentRows} — every kind variant, so a delete /
 * restore cycle round-trips the real row regardless of the meta `type`.
 * @param projectId - Project the content doc belongs to.
 * @param spaceId - Space whose content-doc row has its `deleted_at` cleared.
 * @returns The kinds this call restored + the first failure, if any.
 */
async function restoreSpaceContentRows(
  projectId: string,
  spaceId: string,
): Promise<ContentRowsOutcome> {
  return moveContentRows((kind) =>
    yjsDocumentsRepo.restoreByName(
      spaceContentDocName(projectId, spaceId, kind),
    ),
  );
}

/**
 * Put back exactly the content rows a step already changed, when a later
 * step in the same operation fails before the broadcast.
 *
 * Best-effort by design (§6): if the undo itself fails the answer the caller
 * gets does not change — the original failure is still what happened — but it
 * leaves a line saying what the database is left holding, because at that
 * point only a person can put it right.
 * @param action - The compensating write: `soft-delete` undoes a seed or a
 *   restore, `restore` undoes a soft-delete.
 * @param projectId - Project the content docs belong to.
 * @param spaceId - Space whose content rows are being put back.
 * @param kinds - Exactly the kinds the failed step reported changing.
 * @param logCtx - Extra fields for the line written if the undo fails.
 */
async function undoContentRows(
  action: "soft-delete" | "restore",
  projectId: string,
  spaceId: string,
  kinds: TouchedKinds,
  logCtx: Record<string, unknown>,
): Promise<void> {
  if (kinds.length === 0) return;
  const put =
    action === "restore"
      ? yjsDocumentsRepo.restoreByName
      : yjsDocumentsRepo.softDeleteByName;
  try {
    await Promise.all(
      kinds.map((kind) => put(spaceContentDocName(projectId, spaceId, kind))),
    );
  } catch (undoError) {
    logger.error(
      { err: undoError, projectId, spaceId, kinds, action, ...logCtx },
      "space_rpc_content_row_undo_failed",
    );
  }
}

/**
 * Run a cleanup that must never change the answer the caller already has.
 *
 * `finally` blocks throw here for real reasons — a store failure poisons the
 * document, so `disconnect()` fails too, and releasing the cross-instance
 * lock fails whenever Redis is unreachable. A throw inside `finally`
 * REPLACES the function's return value, which turns an operation that
 * already broadcast successfully into an internal error carrying the
 * database's own words. So every cleanup goes through here (§6).
 * @param label - What is being cleaned up, for the log line.
 * @param logCtx - Extra fields for the log line.
 * @param run - The cleanup itself.
 */
async function safeCleanup(
  label: string,
  logCtx: Record<string, unknown>,
  run: () => Promise<unknown>,
): Promise<void> {
  try {
    await run();
  } catch (cleanupError) {
    logger.warn({ err: cleanupError, ...logCtx }, `space_rpc_${label}_failed`);
  }
}

/** The direct-connection surface the publish/read helpers need. */
interface MetaDirectConnection {
  transact: (fn: (doc: Y.Doc) => void) => Promise<unknown>;
}

/**
 * How the one transact that publishes an operation's change ended.
 *
 * - `published`: the callback wrote, so every client has applied the
 *   change — even when the store rejected afterwards (§3.2: the callback
 *   runs synchronously and the broadcast leaves inside it). The caller
 *   must carry on to its success answer.
 * - `no-op`: the callback returned without writing and nothing failed —
 *   one of its guards said stop, and the caller's own flags say which.
 * - `failed-before-broadcast`: the transact rejected before the callback
 *   wrote anything. Nothing went out; the caller undoes its earlier
 *   steps and answers a controlled error.
 */
type PublishOutcome = "published" | "no-op" | "failed-before-broadcast";

/**
 * Publish an operation's meta-doc change — the commit boundary of §6, as
 * ONE implementation every operation goes through rather than a
 * convention each handler re-earns.
 *
 * Two invariants live here and nowhere else:
 *
 * 1. **Everything the callback writes leaves as one update.** The
 *    library's `transact` runs the callback bare — each Y.js mutation
 *    inside it would otherwise be its own transaction and its own
 *    broadcast frame, so "remove the entry and sweep every tab in the
 *    same broadcast" (§6.2 step 5) would silently be several. The
 *    `doc.transact` wrapper is what makes "same broadcast" literal.
 * 2. **The boundary flag cannot be forgotten.** The callback receives
 *    `mark` and must call it immediately before its first write; a
 *    rejection is then classifiable as before or after the broadcast.
 *    Handlers that skip `mark` and write anyway would misreport — which
 *    is why the flag rides through this wrapper instead of being a local
 *    variable seven functions each remember to declare.
 * @param conn - Direct connection to the project's meta doc.
 * @param logCtx - Fields for the line written when either side fails.
 * @param write - The publishing callback; calls `mark()` right before its
 *   first write, then writes. Guards that decide not to write simply
 *   return without marking.
 * @returns See {@link PublishOutcome}.
 */
async function publishMetaChange(
  conn: MetaDirectConnection,
  logCtx: Record<string, unknown>,
  write: (doc: Y.Doc, mark: () => void) => void,
): Promise<PublishOutcome> {
  let wrote = false;
  /**
   * Records that the very next statement writes — from here on, the
   * change must be treated as broadcast.
   */
  const mark = (): void => {
    wrote = true;
  };
  try {
    await conn.transact((doc: Y.Doc) => {
      doc.transact(() => write(doc, mark));
    });
  } catch (transactError) {
    if (!wrote) {
      logger.error(
        { err: transactError, ...logCtx },
        "space_rpc_failed_before_broadcast",
      );
      return "failed-before-broadcast";
    }
    // Past the line: saying it failed would be a lie every client can see
    // through, and there is nothing left to undo. One complete line.
    logger.error(
      { err: transactError, ...logCtx },
      "space_rpc_not_persisted_after_broadcast",
    );
  }
  return wrote ? "published" : "no-op";
}

/**
 * Run a read-only transact against the meta doc, absorbing the rejection
 * a poisoned document produces (§8.1: one store failure makes every later
 * transact on that doc reject). Nothing has gone out when a pure read
 * fails, so the caller answers a controlled error and stops.
 * @param conn - Direct connection to the project's meta doc.
 * @param logCtx - Fields for the line written when the read fails.
 * @param read - The read; must not write.
 * @returns True when the read ran, false when the transact rejected.
 */
async function readMetaState(
  conn: MetaDirectConnection,
  logCtx: Record<string, unknown>,
  read: (doc: Y.Doc) => void,
): Promise<boolean> {
  try {
    await conn.transact((doc: Y.Doc) => read(doc));
    return true;
  } catch (readError) {
    logger.error({ err: readError, ...logCtx }, "space_rpc_precheck_failed");
    return false;
  }
}

// ── Handlers ────────────────────────────────────────────────────────

/**
 * Create a new Space entry in `meta.spaces`. Caller role ≥ editor.
 *
 * **The id is minted here**, not supplied by the caller. When clients
 * chose it, one could re-submit the id of a Space that had been deleted:
 * the "is this id taken" check reads `meta.spaces`, and a deleted Space
 * is no longer in it, so the check passed and the entry came back.
 *
 * The caller sends `claimToken` instead. It rides on the entry and comes
 * back in the broadcast, which is how the machine that asked recognises
 * the Space it asked for now that it does not know the id. Stored and
 * echoed verbatim; never parsed.
 * @param ctx - Collab context providing the Hocuspocus server.
 * @param projectId - Project whose meta doc the Space is added to.
 * @param caller - Authenticated caller's userId + role, gating the operation.
 * @param req - The `space:create` request carrying the Space type, name, and claim token.
 * @returns A success response carrying the minted Space, or a `FORBIDDEN` / `CONFLICT` error.
 */
async function handleCreate(
  ctx: SpaceRpcContext,
  projectId: string,
  caller: SpaceRpcCaller,
  req: Extract<SpaceRpcRequest, { type: "space:create" }>,
): Promise<SpaceRpcResponse> {
  if (!requireAtLeast(caller.role, "editor")) {
    return err(req.id, "FORBIDDEN", `Role ${caller.role} cannot create Space`);
  }
  const { type, name, claimToken } = req.payload;
  const spaceId = randomUUID();
  // Seed the new Space's content doc BEFORE making it visible in meta — a
  // Space must never be visible before its content doc exists (the same
  // invariant lazy-seed + duplicate uphold). Idempotent (ON CONFLICT DO
  // NOTHING); the doc name follows the Space type. Remember whether THIS
  // call inserted it: only then is there anything to undo later.
  let seeded = false;
  try {
    seeded = await yjsDocumentsRepo.seedInitialState(
      spaceContentDocName(projectId, spaceId, type),
      encodeInitialSpaceContentState(),
    );
  } catch (seedError) {
    logger.error(
      { err: seedError, projectId, spaceId, callerId: caller.userId },
      "space_rpc_create_seed_failed",
    );
    return err(req.id, "INTERNAL", "Could not prepare the new Space");
  }
  const docName = projectMetaDocName(projectId);
  const conn = await ctx.hocuspocus.openDirectConnection(docName, {
    context: { user: { id: SYSTEM_USER_ID }, source: SYSTEM_SOURCE },
  });
  const seededKinds: TouchedKinds = seeded ? [type] : [];
  const logCtx = {
    projectId,
    spaceId,
    callerId: caller.userId,
    during: "create",
  };
  try {
    let conflict = false;
    const outcome = await publishMetaChange(conn, logCtx, (doc, mark) => {
      const spaces = doc.getMap("spaces");
      // Unreachable by any input now that the id is minted here — it would
      // take a uuid v4 collision. Kept because it costs one line and the
      // alternative is silently overwriting somebody's Space.
      if (spaces.has(spaceId)) {
        conflict = true;
        return;
      }
      mark();
      writeSpaceEntry(spaces, {
        spaceId,
        type,
        name,
        order: spaces.size,
        createdAt: Date.now(),
        createdBy: caller.userId,
        claimToken,
      });
    });
    if (outcome === "failed-before-broadcast" || conflict) {
      await undoContentRows("soft-delete", projectId, spaceId, seededKinds, logCtx);
      return conflict
        ? err(req.id, "CONFLICT", `Space ${spaceId} already exists`)
        : err(req.id, "INTERNAL", "Could not create the Space");
    }
    await recordSpaceActivity(ctx, projectId, {
      actorUserId: caller.userId,
      type: "space:created",
      spaceId,
      payload: { spaceName: name },
    });
    return ok(req.id, { spaceId, type, name });
  } finally {
    await safeCleanup("disconnect", logCtx, () => conn.disconnect());
  }
}

/**
 * Delete a Space, serialized across collab instances by a per-project
 * distributed lock so the "keep >=1 Space" guard cannot be raced to zero.
 * Caller role ≥ editor. Maps a contended lock to `CONFLICT`.
 * @param ctx - Collab context providing the Hocuspocus server.
 * @param projectId - Project whose meta doc the Space is removed from.
 * @param caller - Authenticated caller's userId + role, gating the operation.
 * @param req - The `space:delete` request carrying the target spaceId.
 * @returns A success response, or a `FORBIDDEN` / `NOT_FOUND` / `CONFLICT` error.
 */
async function handleDelete(
  ctx: SpaceRpcContext,
  projectId: string,
  caller: SpaceRpcCaller,
  req: Extract<SpaceRpcRequest, { type: "space:delete" }>,
): Promise<SpaceRpcResponse> {
  if (!requireAtLeast(caller.role, "editor")) {
    return err(req.id, "FORBIDDEN", `Role ${caller.role} cannot delete Space`);
  }
  const { spaceId } = req.payload;
  try {
    // Serialize deletes for THIS project across every collab instance. The
    // "keep >=1 Space" guard is a read-modify-write; without cross-instance
    // mutual exclusion two collaborators on different instances can each
    // pass it against their own not-yet-synced in-memory doc and race the
    // project to zero Spaces (see the DD 2026-07-01).
    //
    // Once the critical section has answered, that answer is what
    // happened. The lock guards its own release (space-delete-lock.ts
    // swallows + logs a failing eval), so the only rejection that can
    // reach here after acquisition is one thrown by runDelete itself.
    return await withSpaceDeleteLock(projectId, () =>
      runDelete(ctx, projectId, caller, req, spaceId),
    );
  } catch (e) {
    if (e instanceof SpaceDeleteLockBusyError) {
      return err(
        req.id,
        "CONFLICT",
        "Another delete is in progress for this project; please retry",
      );
    }
    throw e; // unexpected — let the dispatcher log + return INTERNAL
  }
}

/**
 * The `space:delete` critical section, run under the per-project lock.
 *
 * §6.2's order: checks first (entry exists + the AUTHORITATIVE PG
 * live-Space count stays above zero — strongly consistent across
 * instances, unlike the eventually-consistent in-memory CRDT), then the
 * content rows are soft-deleted, then the meta entry is removed and every
 * tab list swept in one broadcast, then the audit row. A failure before
 * the broadcast restores exactly the content rows this call soft-deleted;
 * a failure after it logs and still answers success.
 * @param ctx - Collab context providing the Hocuspocus server.
 * @param projectId - Project whose meta doc the Space is removed from.
 * @param caller - Authenticated caller's userId + role (audit actor).
 * @param req - The `space:delete` request (for the echoed id).
 * @param spaceId - Target Space id.
 * @returns A success response, or a `NOT_FOUND` / `CONFLICT` (last Space) error.
 */
async function runDelete(
  ctx: SpaceRpcContext,
  projectId: string,
  caller: SpaceRpcCaller,
  req: Extract<SpaceRpcRequest, { type: "space:delete" }>,
  spaceId: string,
): Promise<SpaceRpcResponse> {
  // Authoritative Space count from PG (shared + strongly consistent) — NOT
  // the in-memory spaces.size, which lags cross-instance deletes by the
  // pub/sub propagation window.
  const liveCount = await yjsDocumentsRepo.countLiveSpaceDocs(projectId);
  const docName = projectMetaDocName(projectId);
  const conn = await ctx.hocuspocus.openDirectConnection(docName, {
    context: { user: { id: SYSTEM_USER_ID }, source: SYSTEM_SOURCE },
  });
  const logCtx = { projectId, spaceId, callerId: caller.userId, during: "delete" };
  try {
    // ── Every check first, and they change nothing ──────────────────
    let notFound = false;
    let isLast = false;
    const checked = await readMetaState(conn, logCtx, (doc: Y.Doc) => {
      const spaces = doc.getMap("spaces");
      if (!(spaces.get(spaceId) instanceof Y.Map)) {
        notFound = true;
        return;
      }
      // Refuse to delete the last remaining Space. `liveCount` is the PG
      // authority (read under the lock above), so this holds even when two
      // instances delete near-simultaneously: the lock serializes them and
      // each reads the count left by the previous holder's soft-delete.
      // INVARIANT: any future RPC that can REDUCE a project's live Space
      // count must run under withSpaceDeleteLock + this PG-count guard too,
      // or the cross-instance protection is defeated.
      if (liveCount <= 1) isLast = true;
    });
    if (!checked) {
      return err(req.id, "INTERNAL", "Could not delete the Space");
    }
    if (notFound) {
      return err(req.id, "NOT_FOUND", `Space ${spaceId} not found`);
    }
    if (isLast) {
      return err(
        req.id,
        "CONFLICT",
        "Cannot delete the last Space in a project",
      );
    }

    // ── Content rows, BEFORE the broadcast ──────────────────────────
    // Nothing is visible to anyone yet, so a failure here is still a
    // "nothing happened": undo what DID land and answer with a controlled
    // error. Covers every kind variant so a corrupted meta `type` cannot
    // leave a ghost row inflating the authoritative count.
    const softDeleted = await softDeleteSpaceContentRows(projectId, spaceId);
    if (softDeleted.failure !== null) {
      logger.error(
        { err: softDeleted.failure, ...logCtx },
        "space_rpc_delete_content_rows_failed",
      );
      await undoContentRows(
        "restore",
        projectId,
        spaceId,
        softDeleted.touched,
        logCtx,
      );
      return err(req.id, "INTERNAL", "Could not delete the Space");
    }

    // ── The broadcast ───────────────────────────────────────────────
    let vanished = false;
    let snapshot: Record<string, unknown> | null = null;
    let deletedName: string | undefined;
    const outcome = await publishMetaChange(conn, logCtx, (doc, mark) => {
      const spaces = doc.getMap("spaces");
      const entry = spaces.get(spaceId);
      // Only "is the entry still there" is re-checked here. The count is
      // NOT: the soft-delete above just decremented it, so re-reading it
      // would refuse every delete in a two-Space project. The lock taken
      // in handleDelete is what makes skipping it safe — no concurrent
      // delete can change the count inside this window.
      if (!(entry instanceof Y.Map)) {
        vanished = true;
        return;
      }
      snapshot = snapshotMap(entry);
      deletedName = entry.get("name") as string | undefined;
      mark();
      spaces.delete(spaceId);
      clearSpaceFromAllTabs(doc, spaceId);
    });
    if (outcome === "failed-before-broadcast" || vanished) {
      await undoContentRows(
        "restore",
        projectId,
        spaceId,
        softDeleted.touched,
        logCtx,
      );
      return vanished
        ? err(req.id, "NOT_FOUND", `Space ${spaceId} not found`)
        : err(req.id, "INTERNAL", "Could not delete the Space");
    }

    // ── Audit, allowed to fail ──────────────────────────────────────
    // This row carries the snapshot `space:restore` consumes to rebuild the
    // entry, so losing it is what makes a Space unrecoverable — hence the
    // snapshot goes into the log line if the write fails.
    await recordSpaceActivity(
      ctx,
      projectId,
      {
        actorUserId: caller.userId,
        type: "space:deleted",
        spaceId,
        payload: { spaceName: deletedName, spaceSnapshot: snapshot ?? {} },
      },
      { ...logCtx, lostSnapshot: snapshot ?? {}, consequence: "restore-entry-point-lost" },
    );
    return ok(req.id);
  } finally {
    await safeCleanup("disconnect", logCtx, () => conn.disconnect());
  }
}

/**
 * Lock or unlock a Space (set its `locked` flag) and push the matching
 * `space-locked` / `space-unlocked` audit message. Caller role ≥ editor.
 * @param ctx - Collab context providing the Hocuspocus server.
 * @param projectId - Project whose meta doc holds the target Space.
 * @param caller - Authenticated caller's userId + role, gating the operation.
 * @param req - The `space:lock` request carrying the spaceId and desired `locked` value.
 * @returns A success response, or a `FORBIDDEN` / `NOT_FOUND` error.
 */
async function handleLock(
  ctx: SpaceRpcContext,
  projectId: string,
  caller: SpaceRpcCaller,
  req: Extract<SpaceRpcRequest, { type: "space:lock" }>,
): Promise<SpaceRpcResponse> {
  if (!requireAtLeast(caller.role, "editor")) {
    return err(req.id, "FORBIDDEN", `Role ${caller.role} cannot lock Space`);
  }
  const { spaceId, locked } = req.payload;
  const docName = projectMetaDocName(projectId);
  const conn = await ctx.hocuspocus.openDirectConnection(docName, {
    context: { user: { id: SYSTEM_USER_ID }, source: SYSTEM_SOURCE },
  });
  const logCtx = { projectId, spaceId, callerId: caller.userId, during: "lock" };
  try {
    let notFound = false;
    let spaceName: string | undefined;
    const outcome = await publishMetaChange(conn, logCtx, (doc, mark) => {
      const spaces = doc.getMap("spaces");
      const entry = spaces.get(spaceId);
      if (!(entry instanceof Y.Map)) {
        notFound = true;
        return;
      }
      spaceName = entry.get("name") as string | undefined;
      mark();
      entry.set("locked", locked);
    });
    if (outcome === "failed-before-broadcast") {
      return err(req.id, "INTERNAL", "Could not update the Space");
    }
    if (notFound) {
      return err(req.id, "NOT_FOUND", `Space ${spaceId} not found`);
    }
    await recordSpaceActivity(ctx, projectId, {
      actorUserId: caller.userId,
      type: locked ? "space:locked" : "space:unlocked",
      spaceId,
      payload: { spaceName },
    });
    return ok(req.id);
  } finally {
    await safeCleanup("disconnect", logCtx, () => conn.disconnect());
  }
}

/**
 * Rename an existing Space's `name`. Caller role ≥ editor. Refuses
 * with `FORBIDDEN` if the Space is currently locked - locked Spaces
 * must be unlocked before any metadata mutation.
 * @param ctx - Collab context providing the Hocuspocus server.
 * @param projectId - Project whose meta doc holds the target Space.
 * @param caller - Authenticated caller's userId + role, gating the operation.
 * @param req - The `space:rename` request carrying the spaceId and new name.
 * @returns A success response (also for an idempotent same-name no-op), or a `FORBIDDEN` / `NOT_FOUND` error.
 */
async function handleRename(
  ctx: SpaceRpcContext,
  projectId: string,
  caller: SpaceRpcCaller,
  req: Extract<SpaceRpcRequest, { type: "space:rename" }>,
): Promise<SpaceRpcResponse> {
  if (!requireAtLeast(caller.role, "editor")) {
    return err(req.id, "FORBIDDEN", `Role ${caller.role} cannot rename Space`);
  }
  const { spaceId, name } = req.payload;
  const docName = projectMetaDocName(projectId);
  const conn = await ctx.hocuspocus.openDirectConnection(docName, {
    context: { user: { id: SYSTEM_USER_ID }, source: SYSTEM_SOURCE },
  });
  const logCtx = {
    projectId,
    spaceId,
    callerId: caller.userId,
    during: "rename",
  };
  try {
    let notFound = false;
    let locked = false;
    let noop = false;
    let oldName = "";
    const outcome = await publishMetaChange(conn, logCtx, (doc, mark) => {
      const spaces = doc.getMap("spaces");
      const entry = spaces.get(spaceId);
      if (!(entry instanceof Y.Map)) {
        notFound = true;
        return;
      }
      if (entry.get("locked") === true) {
        locked = true;
        return;
      }
      const previousName = entry.get("name");
      const oldSpaceName =
        typeof previousName === "string" ? previousName : "";
      if (oldSpaceName === name) {
        // Idempotent no-op - skip the audit entry so a rename to the
        // same name doesn't produce a phantom "X renamed Foo to Foo".
        noop = true;
        return;
      }
      oldName = oldSpaceName;
      mark();
      entry.set("name", name);
    });
    if (outcome === "failed-before-broadcast") {
      return err(req.id, "INTERNAL", "Could not rename the Space");
    }
    if (notFound) {
      return err(req.id, "NOT_FOUND", `Space ${spaceId} not found`);
    }
    if (locked) {
      return err(
        req.id,
        "FORBIDDEN",
        `Space ${spaceId} is locked; unlock before renaming`,
      );
    }
    if (!noop) {
      await recordSpaceActivity(ctx, projectId, {
        actorUserId: caller.userId,
        type: "space:renamed",
        spaceId,
        payload: { spaceName: name, oldSpaceName: oldName },
      });
    }
    return ok(req.id);
  } finally {
    await safeCleanup("disconnect", logCtx, () => conn.disconnect());
  }
}

/**
 * Restore a previously deleted Space. Two data layers, two mechanisms
 * (ADR 2026-07-04): the canvas CONTENT doc rows are soft-deleted in the
 * yjs PG database and merely un-deleted here (never snapshotted); the
 * meta DIRECTORY entry is rebuilt from the spaceSnapshot carried by the
 * latest unconsumed `space:deleted` activity row. Caller role = owner.
 *
 * Step order is §6.3's, and it is load-bearing:
 *   1. PG: read the latest unconsumed space:deleted activity row.
 *   2. Meta read: refuse CONFLICT if the space already exists.
 *   3. Content rows un-delete, BEFORE anything is visible — a Space must
 *      never be visible without its content. A failure here re-deletes
 *      exactly the rows this call brought back and reports a controlled
 *      error; nobody saw anything.
 *   4. Meta transact: rebuild the directory entry + sweep stale tab
 *      records, one broadcast. The "already back" re-check here is the
 *      guard that makes a retry after a partial failure safe.
 *   5. Business-DB transaction: mark the deleted row consumed + append
 *      the space:restored activity row.
 * A crash between 4 and 5 leaves the space alive with the deleted row
 * unconsumed - harmless: a retry is refused by the step-4 guard, and
 * the next delete/restore cycle targets its own newer deleted row.
 * Never reorder 5 before 4: consuming the snapshot before the rebuild
 * makes a step-4 failure unretryable.
 * @param ctx - Collab context providing the Hocuspocus server.
 * @param projectId - Project whose meta doc the Space is restored into.
 * @param caller - Authenticated caller's userId + role; only `owner` may restore.
 * @param req - The `space:restore` request carrying the target spaceId.
 * @returns A success response, or a `FORBIDDEN` / `NOT_FOUND` / `CONFLICT` error.
 */
async function handleRestore(
  ctx: SpaceRpcContext,
  projectId: string,
  caller: SpaceRpcCaller,
  req: Extract<SpaceRpcRequest, { type: "space:restore" }>,
): Promise<SpaceRpcResponse> {
  if (caller.role !== "owner") {
    return err(
      req.id,
      "FORBIDDEN",
      `Only owner can restore deleted Space (role: ${caller.role})`,
    );
  }
  const { spaceId } = req.payload;
  // Serialize the whole restore under the SAME per-project lock delete
  // uses. Restore un-deletes a content-doc row — mutating the very
  // count delete's floor-guard trusts — and rebuilds the meta entry, so
  // an unlocked restore can interleave with a concurrent delete of the
  // same spaceId and leave a ghost (live content, no meta entry) that
  // inflates countLiveSpaceDocs. The lock also serializes cross-instance
  // restore-vs-restore; the repo CAS below is the airtight backstop for
  // the residual lock-TTL window.
  try {
    return await withSpaceDeleteLock(projectId, () =>
      runRestore(ctx, projectId, caller, req, spaceId),
    );
  } catch (e) {
    if (e instanceof SpaceDeleteLockBusyError) {
      return err(
        req.id,
        "CONFLICT",
        "Another Space operation is in progress for this project; please retry",
      );
    }
    throw e;
  }
}

/**
 * The `space:restore` critical section, run under the per-project lock.
 * @param ctx - Collab context providing the Hocuspocus server.
 * @param projectId - Project whose meta doc the Space is restored into.
 * @param caller - Authenticated caller's userId + role (audit actor).
 * @param req - The `space:restore` request (for the echoed id).
 * @param spaceId - Target Space id.
 * @returns A success response, or a `NOT_FOUND` / `CONFLICT` error.
 */
async function runRestore(
  ctx: SpaceRpcContext,
  projectId: string,
  caller: SpaceRpcCaller,
  req: Extract<SpaceRpcRequest, { type: "space:restore" }>,
  spaceId: string,
): Promise<SpaceRpcResponse> {
  const deletedRow = await projectActivitiesRepo.latestUnrestoredDeleted(
    projectId,
    spaceId,
  );
  const snapshot = deletedRow?.payload["spaceSnapshot"];
  if (
    !deletedRow ||
    !snapshot ||
    typeof snapshot !== "object" ||
    Array.isArray(snapshot)
  ) {
    return err(
      req.id,
      "NOT_FOUND",
      `No deletion record found for Space ${spaceId} (or already restored)`,
    );
  }
  const snapshotRecord = snapshot as Record<string, unknown>;
  const docName = projectMetaDocName(projectId);
  const conn = await ctx.hocuspocus.openDirectConnection(docName, {
    context: { user: { id: SYSTEM_USER_ID }, source: SYSTEM_SOURCE },
  });
  const logCtx = {
    projectId,
    spaceId,
    callerId: caller.userId,
    during: "restore",
  };
  try {
    // ── Check first, changing nothing ───────────────────────────────
    let alreadyPresent = false;
    const checked = await readMetaState(conn, logCtx, (doc: Y.Doc) => {
      if (doc.getMap("spaces").has(spaceId)) alreadyPresent = true;
    });
    if (!checked) {
      return err(req.id, "INTERNAL", "Could not restore the Space");
    }
    if (alreadyPresent) {
      return err(req.id, "CONFLICT", `Space ${spaceId} is not deleted`);
    }

    // ── Content rows, BEFORE the broadcast ──────────────────────────
    // A Space must never be visible without its content, so the rows come
    // back first; nobody has seen anything yet if this fails — put back
    // what DID come back, and stop.
    const restored = await restoreSpaceContentRows(projectId, spaceId);
    if (restored.failure !== null) {
      logger.error(
        { err: restored.failure, ...logCtx },
        "space_rpc_restore_content_rows_failed",
      );
      await undoContentRows(
        "soft-delete",
        projectId,
        spaceId,
        restored.touched,
        logCtx,
      );
      return err(req.id, "INTERNAL", "Could not restore the Space");
    }

    // ── The broadcast ───────────────────────────────────────────────
    let raced = false;
    const outcome = await publishMetaChange(conn, logCtx, (doc, mark) => {
      const spaces = doc.getMap("spaces");
      // Someone else restored it while the content rows were coming back.
      if (spaces.has(spaceId)) {
        raced = true;
        return;
      }
      const entry = new Y.Map<unknown>();
      for (const [k, v] of Object.entries(snapshotRecord)) {
        entry.set(k, v);
      }
      mark();
      spaces.set(spaceId, entry);
      // Backstop for the cross-instance window: a tab:open can land after
      // another instance's delete sweep, leaving an entry pointing at a
      // Space that is gone. Nobody sees it — the tab bar drops ids it
      // cannot resolve — until the Space comes back, at which point the id
      // resolves again and a tab appears out of nowhere. Sweeping here is
      // what makes "restore does not restore tabs" true rather than
      // approximately true.
      clearSpaceFromAllTabs(doc, spaceId);
    });
    if (outcome === "failed-before-broadcast" || raced) {
      await undoContentRows(
        "soft-delete",
        projectId,
        spaceId,
        restored.touched,
        logCtx,
      );
      return raced
        ? err(req.id, "CONFLICT", `Space ${spaceId} is not deleted`)
        : err(req.id, "INTERNAL", "Could not restore the Space");
    }

    // ── Audit, allowed to fail ──────────────────────────────────────
    const spaceName =
      typeof snapshotRecord["name"] === "string"
        ? snapshotRecord["name"]
        : undefined;
    try {
      // CAS consume: only the winner appends space:restored + signals.
      const won = await projectActivitiesRepo.consumeRestoreAndAppend(
        deletedRow.id,
        {
          projectId,
          actorUserId: caller.userId,
          type: "space:restored",
          spaceId,
          payload: { spaceName },
        },
      );
      if (won) broadcastActivitySignal(ctx.hocuspocus, projectId);
    } catch (e) {
      // Space is fully restored; only the consumption marker + audit row
      // failed. The deletion row stays unconsumed, so its restore button
      // keeps offering an action the server will now refuse as CONFLICT —
      // the opposite shape of delete's lost-snapshot case.
      logger.error(
        { err: e, ...logCtx, consequence: "restore-button-stays-armed" },
        "activity_restore_consume_failed",
      );
    }
    return ok(req.id);
  } finally {
    await safeCleanup("disconnect", logCtx, () => conn.disconnect());
  }
}

// ── Tab RPCs ────────────────────────────────────────────────────────
//
// Which Spaces a person has open used to be the one thing a client wrote
// into the meta doc directly. That single exception is why the write gate
// had to work out which field an incoming frame touched — and a gate that
// must enumerate the framework's message types to do that fails open on
// the ones it misses. With tabs behind an RPC the rule is flat: a client
// never writes that doc, and its connection is simply read-only.
//
// Nothing here writes an activity row. Which tabs someone has open is
// their own window state, not a project event.

/** Key of the per-user open-tab list inside a `perUser` record. */
const OPEN_TAB_IDS_KEY = "openTabIds";

/**
 * Drop one Space from every user's open-tab list.
 *
 * Called when a Space stops existing (delete) and again when one comes
 * back (restore, as a backstop for the cross-instance window). Clients
 * cannot do this themselves any more — they do not write this doc — and
 * leaving it to them would also mean the tab only disappears for whoever
 * happens to be online.
 *
 * Users with no list are skipped rather than given an empty one: a
 * missing list means "show every Space", and manufacturing one here
 * would silently empty their tab bar.
 * @param doc - The project meta doc, inside a transaction.
 * @param spaceId - The Space to drop from every list.
 */
function clearSpaceFromAllTabs(doc: Y.Doc, spaceId: string): void {
  const perUser = doc.getMap<Y.Map<unknown>>("perUser");
  perUser.forEach((userMap) => {
    const list = userMap.get(OPEN_TAB_IDS_KEY) as Y.Array<string> | undefined;
    if (!list) return;
    for (let i = list.length - 1; i >= 0; i -= 1) {
      if (list.get(i) === spaceId) list.delete(i, 1);
    }
  });
}

/**
 * Get the caller's open-tab list, creating it — seeded with every Space
 * that currently exists — when they do not have one.
 *
 * **The gate is the LIST, not the record.** Three states exist and the
 * middle one is easy to miss:
 *
 * | state | what the tab bar shows |
 * | --- | --- |
 * | no record at all | every Space |
 * | a record with no list | nothing |
 * | a record with an empty list | nothing |
 *
 * A user with no record sees every Space, so the first write has to
 * preserve that: writing only the Space just clicked would drop the rest
 * from their bar. And a record without a list exists in production — the
 * old client-side close created the record, then returned without making
 * a list — so gating on the record would skip seeding for exactly those
 * users and leave them with an empty bar for good.
 *
 * Seeding happens once. After that the list is authoritative, including
 * when it is empty (the user closed everything, which is their choice).
 * @param doc - The project meta doc, inside a transaction.
 * @param userId - Caller's userId, taken from the authenticated connection.
 * @param spaces - The `spaces` map, used as the seed when there is no list.
 * @param mark - The publish boundary marker; called before this function's
 *   first write. Seeding writes even when the operation that asked turns
 *   out to be a no-op, so the marking cannot be left to the caller.
 * @returns The caller's open-tab list, ready to mutate.
 */
function ensureOpenTabList(
  doc: Y.Doc,
  userId: string,
  spaces: Y.Map<unknown>,
  mark: () => void,
): Y.Array<string> {
  const perUser = doc.getMap<Y.Map<unknown>>("perUser");
  let userMap = perUser.get(userId);
  if (!userMap) {
    mark();
    userMap = new Y.Map<unknown>();
    perUser.set(userId, userMap);
  }
  const existing = userMap.get(OPEN_TAB_IDS_KEY) as
    | Y.Array<string>
    | undefined;
  if (existing) return existing;
  mark();
  const list = new Y.Array<string>();
  userMap.set(OPEN_TAB_IDS_KEY, list);
  list.push(Array.from(spaces.keys()));
  return list;
}

/**
 * Open a Space in the caller's own tab bar. Any role that can reach the
 * project may do this — a viewer's tab bar is still theirs.
 * @param ctx - Collab context providing the Hocuspocus server.
 * @param projectId - Project whose meta doc holds the tab lists.
 * @param caller - Authenticated caller; the userId comes from here, never from the request.
 * @param req - The `tab:open` request carrying the Space to open.
 * @returns Success, or `NOT_FOUND` when that Space does not exist.
 */
async function handleTabOpen(
  ctx: SpaceRpcContext,
  projectId: string,
  caller: SpaceRpcCaller,
  req: Extract<SpaceRpcRequest, { type: "tab:open" }>,
): Promise<SpaceRpcResponse> {
  const { spaceId } = req.payload;
  const conn = await ctx.hocuspocus.openDirectConnection(
    projectMetaDocName(projectId),
    { context: { user: { id: SYSTEM_USER_ID }, source: SYSTEM_SOURCE } },
  );
  const logCtx = {
    projectId,
    spaceId,
    callerId: caller.userId,
    during: "tab:open",
  };
  try {
    let missing = false;
    const outcome = await publishMetaChange(conn, logCtx, (doc, mark) => {
      const spaces = doc.getMap("spaces");
      if (!spaces.has(spaceId)) {
        missing = true;
        return;
      }
      const list = ensureOpenTabList(doc, caller.userId, spaces, mark);
      // Already open: touch nothing. Re-adding would broadcast a change
      // that changes nothing to everyone on the account.
      if (!list.toArray().includes(spaceId)) {
        mark();
        list.push([spaceId]);
      }
    });
    if (outcome === "failed-before-broadcast") {
      return err(req.id, "INTERNAL", "Could not open the tab");
    }
    if (missing) {
      return err(req.id, "NOT_FOUND", `Space ${spaceId} does not exist`);
    }
    return ok(req.id);
  } finally {
    await safeCleanup("disconnect", logCtx, () => conn.disconnect());
  }
}

/**
 * Close a Space in the caller's own tab bar.
 *
 * Closing a Space that is not open succeeds without touching anything —
 * the caller's intent is already satisfied. The Space itself is never
 * checked: a tab pointing at a Space that has since been deleted is
 * exactly the case where closing has to keep working.
 * @param ctx - Collab context providing the Hocuspocus server.
 * @param projectId - Project whose meta doc holds the tab lists.
 * @param caller - Authenticated caller; the userId comes from here, never from the request.
 * @param req - The `tab:close` request carrying the Space to close.
 * @returns Success.
 */
async function handleTabClose(
  ctx: SpaceRpcContext,
  projectId: string,
  caller: SpaceRpcCaller,
  req: Extract<SpaceRpcRequest, { type: "tab:close" }>,
): Promise<SpaceRpcResponse> {
  const { spaceId } = req.payload;
  const conn = await ctx.hocuspocus.openDirectConnection(
    projectMetaDocName(projectId),
    { context: { user: { id: SYSTEM_USER_ID }, source: SYSTEM_SOURCE } },
  );
  const logCtx = {
    projectId,
    spaceId,
    callerId: caller.userId,
    during: "tab:close",
  };
  try {
    const outcome = await publishMetaChange(conn, logCtx, (doc, mark) => {
      const spaces = doc.getMap("spaces");
      // Seeding first is what makes "close one" mean "keep the others"
      // for a user who has never opened anything: their bar is showing
      // every Space, and without the seed the result would be a list
      // holding nothing at all.
      const list = ensureOpenTabList(doc, caller.userId, spaces, mark);
      for (let i = list.length - 1; i >= 0; i--) {
        if (list.get(i) === spaceId) {
          mark();
          list.delete(i, 1);
        }
      }
    });
    if (outcome === "failed-before-broadcast") {
      return err(req.id, "INTERNAL", "Could not close the tab");
    }
    return ok(req.id);
  } finally {
    await safeCleanup("disconnect", logCtx, () => conn.disconnect());
  }
}

// ── Dispatcher ──────────────────────────────────────────────────────

/**
 * Route a parsed SpaceRpcRequest to the matching handler and return
 * the response. Caller (server.ts onStateless) is responsible for the
 * Zod parse / error envelope.
 * @param ctx - Collab context providing the Hocuspocus server.
 * @param projectId - Project the RPC operates on.
 * @param caller - Authenticated caller's userId + role, forwarded to each handler for authorization.
 * @param request - The parsed, type-discriminated Space RPC request.
 * @returns The matching handler's response, or an `INTERNAL` error response when a handler throws.
 */
export async function handleSpaceRpc(
  ctx: SpaceRpcContext,
  projectId: string,
  caller: SpaceRpcCaller,
  request: SpaceRpcRequest,
): Promise<SpaceRpcResponse> {
  try {
    switch (request.type) {
      case "space:create":
        return await handleCreate(ctx, projectId, caller, request);
      case "space:delete":
        return await handleDelete(ctx, projectId, caller, request);
      case "space:lock":
        return await handleLock(ctx, projectId, caller, request);
      case "space:rename":
        return await handleRename(ctx, projectId, caller, request);
      case "space:restore":
        return await handleRestore(ctx, projectId, caller, request);
      case "tab:open":
        return await handleTabOpen(ctx, projectId, caller, request);
      case "tab:close":
        return await handleTabClose(ctx, projectId, caller, request);
    }
  } catch (e) {
    // Last resort for programmer errors only — every anticipated failure is
    // handled inside its handler with a controlled message. What a raw
    // error carries (database wording, connection strings) is for the log,
    // never for the client: the reply's message goes straight into a toast.
    logger.error(
      { err: e, projectId, callerId: caller.userId, type: request.type },
      "space_rpc_internal_error",
    );
    return err(request.id, "INTERNAL", "Unexpected server error");
  }
}
