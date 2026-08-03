// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Collab-side handlers for client-initiated Space lifecycle RPCs.
 *
 * Per ADR 2026-05-23-yjs-collab-only-write-authz:
 *
 *   - create / delete / lock / unlock / rename - caller role ≥ editor
 *   - restore                                   - caller role = owner
 *
 * Each handler:
 *
 *   1. Validates the caller's role.
 *   2. Opens a DirectConnection to the project's meta doc. A direct
 *      connection is not a client connection: it never carries the
 *      read-only flag that every client's connection to this doc does,
 *      which is what makes these handlers the only writers. The
 *      `context.user.id = 'system'` marker rides along for logging.
 *   3. Performs the meta-doc mutation (set / delete a `spaces` entry)
 *      in a single Y transaction, then appends the matching
 *      `project_activities` PG row + broadcasts the `activity:new`
 *      stateless signal (best-effort - the Yjs mutation is already
 *      applied, so an activity failure logs instead of failing the RPC;
 *      ADR 2026-07-04 project-activity-feed).
 *   4. For delete: also soft-deletes the canvas-{spaceId} row in PG so
 *      stale tabs cannot resurrect the data via Hocuspocus persistence
 *      (per `auth.ts` space-exists check - meta.spaces is the source of
 *      truth for "exists right now", `yjs_documents.deletedAt` is the
 *      defense-in-depth backstop).
 *   5. For restore: reverses both - sets the entry back and clears the
 *      `deletedAt` column on the canvas row.
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
 * @param ctx - Collab context providing the Hocuspocus server.
 * @param projectId - Project the activity belongs to.
 * @param activity - The activity row minus its projectId.
 */
async function recordSpaceActivity(
  ctx: SpaceRpcContext,
  projectId: string,
  activity: Omit<NewProjectActivity, "projectId">,
): Promise<void> {
  try {
    await projectActivitiesRepo.insert({ projectId, ...activity });
    broadcastActivitySignal(ctx.hocuspocus, projectId);
  } catch (e) {
    logger.error(
      { err: e, projectId, activityType: activity.type },
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

/**
 * Soft-delete a Space's content-doc `yjs_documents` row via the shared core
 * repo. Soft-deletes EVERY kind variant of the (projectId, spaceId) content
 * doc (idempotent no-op for the ones that don't exist), so the real row is
 * always covered regardless of the meta `type` field — the authoritative
 * `countLiveSpaceDocs` therefore always decrements (a ghost row left live by
 * a corrupted type could otherwise inflate the count past the >=1 floor).
 * @param projectId - Project the content doc belongs to.
 * @param spaceId - Space whose content-doc row is marked deleted.
 */
async function softDeleteSpaceContentRows(
  projectId: string,
  spaceId: string,
): Promise<void> {
  await Promise.all(
    SPACE_CONTENT_KINDS.map((kind) =>
      yjsDocumentsRepo.softDeleteByName(
        spaceContentDocName(projectId, spaceId, kind),
      ),
    ),
  );
}

/**
 * Restore (clear deleted_at on) a Space's content-doc row, mirroring
 * {@link softDeleteSpaceContentRows} — every kind variant, so a delete /
 * restore cycle round-trips the real row regardless of the meta `type`.
 * @param projectId - Project the content doc belongs to.
 * @param spaceId - Space whose content-doc row has its `deleted_at` cleared.
 */
async function restoreSpaceContentRows(
  projectId: string,
  spaceId: string,
): Promise<void> {
  await Promise.all(
    SPACE_CONTENT_KINDS.map((kind) =>
      yjsDocumentsRepo.restoreByName(
        spaceContentDocName(projectId, spaceId, kind),
      ),
    ),
  );
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
  // NOTHING); the doc name follows the Space type.
  await yjsDocumentsRepo.seedInitialState(
    spaceContentDocName(projectId, spaceId, type),
    encodeInitialSpaceContentState(),
  );
  const docName = projectMetaDocName(projectId);
  const conn = await ctx.hocuspocus.openDirectConnection(docName, {
    context: { user: { id: SYSTEM_USER_ID }, source: SYSTEM_SOURCE },
  });
  try {
    let conflict = false;
    await conn.transact((doc: Y.Doc) => {
      const spaces = doc.getMap("spaces");
      // Unreachable by any input now that the id is minted here — it would
      // take a uuid v4 collision. Kept because it costs one line and the
      // alternative is silently overwriting somebody's Space.
      if (spaces.has(spaceId)) {
        conflict = true;
        return;
      }
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
    if (conflict) {
      return err(req.id, "CONFLICT", `Space ${spaceId} already exists`);
    }
    await recordSpaceActivity(ctx, projectId, {
      actorUserId: caller.userId,
      type: "space:created",
      spaceId,
      payload: { spaceName: name },
    });
    return ok(req.id, { spaceId, type, name });
  } finally {
    await conn.disconnect();
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
 * Reads the AUTHORITATIVE live-Space count from PG (strongly consistent
 * across instances, unlike the eventually-consistent in-memory
 * `meta.spaces` CRDT), refuses if deleting would leave zero, removes the
 * meta entry + pushes the `space-deleted` audit, then soft-deletes the
 * TYPE-correct content-doc PG row so the count decrements.
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
  let notFound = false;
  let isLast = false;
  let snapshot: Record<string, unknown> | null = null;
  let deletedName: string | undefined;
  try {
    await conn.transact((doc: Y.Doc) => {
      const spaces = doc.getMap("spaces");
      const entry = spaces.get(spaceId);
      if (!(entry instanceof Y.Map)) {
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
      if (liveCount <= 1) {
        isLast = true;
        return;
      }
      snapshot = snapshotMap(entry);
      deletedName = entry.get("name") as string | undefined;
      spaces.delete(spaceId);
      clearSpaceFromAllTabs(doc, spaceId);
    });
  } finally {
    await conn.disconnect();
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
  // Soft-delete the content-doc PG row AFTER the meta mutation (a
  // reconnecting client is refused by the auth-hook space-exists check
  // regardless). This decrements the authoritative count the guard reads;
  // it covers every kind variant so a corrupted meta `type` can't leave a
  // ghost row inflating the count.
  await softDeleteSpaceContentRows(projectId, spaceId);
  // The space:deleted row carries the directory-entry snapshot that
  // space:restore consumes to rebuild the meta entry (the canvas
  // CONTENT doc is soft-deleted above and merely un-deleted on
  // restore - it is never snapshotted).
  await recordSpaceActivity(ctx, projectId, {
    actorUserId: caller.userId,
    type: "space:deleted",
    spaceId,
    payload: { spaceName: deletedName, spaceSnapshot: snapshot ?? {} },
  });
  return ok(req.id);
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
  try {
    let notFound = false;
    let spaceName: string | undefined;
    await conn.transact((doc: Y.Doc) => {
      const spaces = doc.getMap("spaces");
      const entry = spaces.get(spaceId);
      if (!(entry instanceof Y.Map)) {
        notFound = true;
        return;
      }
      entry.set("locked", locked);
      spaceName = entry.get("name") as string | undefined;
    });
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
    await conn.disconnect();
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
  try {
    let notFound = false;
    let locked = false;
    let noop = false;
    let oldName = "";
    await conn.transact((doc: Y.Doc) => {
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
      entry.set("name", name);
      oldName = oldSpaceName;
    });
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
    await conn.disconnect();
  }
}

/**
 * Restore a previously deleted Space. Two data layers, two mechanisms
 * (ADR 2026-07-04): the canvas CONTENT doc rows are soft-deleted in the
 * yjs PG database and merely un-deleted here (never snapshotted); the
 * meta DIRECTORY entry is rebuilt from the spaceSnapshot carried by the
 * latest unconsumed `space:deleted` activity row. Caller role = owner.
 *
 * Step order is load-bearing:
 *   1. PG: read the latest unconsumed space:deleted activity row.
 *   2. Meta transact: rebuild the directory entry (refuse CONFLICT if
 *      the space already exists - also the guard that makes a retry
 *      after a partial failure safe).
 *   3. Content rows un-delete (separate yjs PG database - cannot share
 *      a business-DB transaction; unconditional + idempotent).
 *   4. Business-DB transaction: mark the deleted row consumed + append
 *      the space:restored activity row.
 * A crash between 2 and 4 leaves the space alive with the deleted row
 * unconsumed - harmless: a retry is refused by the step-2 guard, and
 * the next delete/restore cycle targets its own newer deleted row.
 * Never reorder 4 before 2: consuming the snapshot before the rebuild
 * makes a step-2 failure unretryable.
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
  let alreadyPresent = false;
  try {
    await conn.transact((doc: Y.Doc) => {
      const spaces = doc.getMap("spaces");
      if (spaces.has(spaceId)) {
        alreadyPresent = true;
        return;
      }
      const entry = new Y.Map<unknown>();
      for (const [k, v] of Object.entries(snapshotRecord)) {
        entry.set(k, v);
      }
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
  } finally {
    await conn.disconnect();
  }
  if (alreadyPresent) {
    return err(req.id, "CONFLICT", `Space ${spaceId} is not deleted`);
  }
  await restoreSpaceContentRows(projectId, spaceId);
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
    // failed. A retry is refused by the already-present guard, so log
    // for repair instead of failing an already-applied restore.
    logger.error(
      { err: e, projectId, spaceId },
      "activity_restore_consume_failed",
    );
  }
  return ok(req.id);
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
 * @returns The caller's open-tab list, ready to mutate.
 */
function ensureOpenTabList(
  doc: Y.Doc,
  userId: string,
  spaces: Y.Map<unknown>,
): Y.Array<string> {
  const perUser = doc.getMap<Y.Map<unknown>>("perUser");
  let userMap = perUser.get(userId);
  if (!userMap) {
    userMap = new Y.Map<unknown>();
    perUser.set(userId, userMap);
  }
  const existing = userMap.get(OPEN_TAB_IDS_KEY) as
    | Y.Array<string>
    | undefined;
  if (existing) return existing;
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
  try {
    let missing = false;
    await conn.transact((doc: Y.Doc) => {
      const spaces = doc.getMap("spaces");
      if (!spaces.has(spaceId)) {
        missing = true;
        return;
      }
      const list = ensureOpenTabList(doc, caller.userId, spaces);
      // Already open: touch nothing. Re-adding would broadcast a change
      // that changes nothing to everyone on the account.
      if (!list.toArray().includes(spaceId)) list.push([spaceId]);
    });
    if (missing) {
      return err(req.id, "NOT_FOUND", `Space ${spaceId} does not exist`);
    }
    return ok(req.id);
  } finally {
    await conn.disconnect();
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
  try {
    await conn.transact((doc: Y.Doc) => {
      const spaces = doc.getMap("spaces");
      // Seeding first is what makes "close one" mean "keep the others"
      // for a user who has never opened anything: their bar is showing
      // every Space, and without the seed the result would be a list
      // holding nothing at all.
      const list = ensureOpenTabList(doc, caller.userId, spaces);
      for (let i = list.length - 1; i >= 0; i--) {
        if (list.get(i) === spaceId) list.delete(i, 1);
      }
    });
    return ok(req.id);
  } finally {
    await conn.disconnect();
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
    logger.error(
      { err: e, projectId, callerId: caller.userId, type: request.type },
      "space_rpc_internal_error",
    );
    return err(
      request.id,
      "INTERNAL",
      e instanceof Error ? e.message : "Unknown error",
    );
  }
}
