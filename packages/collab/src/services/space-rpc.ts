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
 * `finally` blocks throw here for real reasons — `disconnect()` runs the
 * disconnect hooks, and any of those can reject. A throw inside `finally`
 * REPLACES the function's return value, which turns an operation that
 * already broadcast successfully into an internal error carrying the
 * database's own words. So every cleanup in THIS file goes through here
 * (§6); the cross-instance lock guards its own release inside
 * space-delete-lock.ts, at the site where that failure happens.
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
  /**
   * The live meta doc. `DirectConnection` exposes it as a public field
   * and `Document extends Doc`, so a pre-check can read it with no
   * transact and therefore no store attempt. Null only after
   * `disconnect()`.
   */
  document: Y.Doc | null;
  transact: (fn: (doc: Y.Doc) => void) => Promise<unknown>;
}

/**
 * The live meta doc behind an open direct connection.
 *
 * **The checks an operation runs BEFORE it writes go through here, never
 * through `transact`.** (The checks a callback re-runs at the moment it
 * writes are a different thing and stay inside the write — see §4 on why
 * they have to be re-run at all.) Until hocuspocus 4, `transact` ran its
 * callback and then stored the document unconditionally — even for a
 * callback that only read — so a check routed through it came back with two
 * unrelated answers: what it saw, and whether the database was healthy.
 * Every caller then had to decide which one won, and that decision was
 * written three different ways across nine call sites, two of them
 * backwards. 4.5.0 removed the store from `transact` altogether, which
 * removes that particular hazard but not the reason for the split: a read
 * routed through `transact` still opens a Yjs transaction, still costs a
 * broadcast frame if the callback writes by accident, and still couples a
 * pure question to the write path. A Yjs read needs no transaction and
 * touches no storage, so there is only ever one answer and nothing to order.
 * @param conn - Direct connection opened for this operation.
 * @returns The live meta doc.
 * @throws {Error} When the connection has already been disconnected.
 */
function metaDocOf(conn: MetaDirectConnection): Y.Doc {
  if (conn.document === null) {
    throw new Error("meta direct connection is already closed");
  }
  return conn.document;
}

/**
 * How the one transact that publishes an operation's change ended.
 *
 * - `decided`: a guard inside the callback reached an answer by READING
 *   the world, and that answer is what the caller must send. It holds
 *   whether or not the store then failed — the guard did not cause that
 *   failure and its reading is unaffected by it. The answer can be a
 *   refusal (the entry vanished) or a success (nothing needed writing,
 *   §6.5's same-name rename). **This case exists so the precedence lives
 *   here instead of being re-derived by each handler.**
 *   `broadcast` says whether anything reached the clients before the
 *   guard settled. It is NOT always false: `ensureOpenTabList` seeds a
 *   missing tab list — a write — and the very next line can find nothing
 *   to remove and settle on an idempotent success. A caller that undoes
 *   earlier steps must key that undo on this flag, never on the kind.
 * - `published`: no guard reached an answer, so the callback ran to the
 *   end. In every operation today that means it wrote, and the change is
 *   out on every client — even when the store rejected afterwards (§3.2:
 *   the callback runs synchronously and the broadcast leaves inside it).
 *   A callback that neither wrote nor decided would land here too, but
 *   none can: each of the seven either returns a verdict or marks and
 *   writes, so there is no third path to name. The caller carries on to
 *   its success answer.
 * - `failed-before-broadcast`: the transact rejected, no guard had
 *   decided anything, and the callback had written nothing. Nothing went
 *   out; the caller undoes its earlier steps and answers a controlled
 *   error.
 */
type PublishOutcome =
  | { kind: "decided"; response: SpaceRpcResponse; broadcast: boolean }
  | { kind: "published" }
  | { kind: "failed-before-broadcast" };

/**
 * Publish an operation's meta-doc change — the commit boundary of §6, as
 * ONE implementation every operation goes through rather than a
 * convention each handler re-earns.
 *
 * Three invariants live here and nowhere else:
 *
 * 1. **Everything the callback writes leaves as one update.** Without a
 *    transaction around it, each Y.js mutation is its own transaction and
 *    its own broadcast frame, so "remove the entry and sweep every tab in
 *    the same broadcast" (§6.2 step 5) would silently be several. The
 *    library's own `transact` opens one since hocuspocus 4, which makes the
 *    `doc.transact` wrapper below redundant rather than wrong — Y.js keeps
 *    the outermost transaction and runs a nested call inside it. Kept
 *    anyway: this guarantee is ours to make, and inheriting it from a
 *    library that changed this exact behaviour once already is how it goes
 *    away without anything failing.
 * 2. **The boundary flag cannot be forgotten.** The callback receives
 *    `mark` and must call it immediately before its first write; a
 *    rejection is then classifiable as before or after the broadcast.
 *    Handlers that skip `mark` and write anyway would misreport — which
 *    is why the flag rides through this wrapper instead of being a local
 *    variable seven functions each remember to declare.
 * 3. **A guard's answer outranks a publish rejection it did not cause.** The
 *    callback returns its answer instead of setting a flag the caller
 *    then has to consult in the right order, so `decided` and
 *    `failed-before-broadcast` are mutually exclusive by construction.
 *    Spelled out per handler, this ordering was got wrong twice. The
 *    outcome also reports whether anything reached the clients, so
 *    "settling on a verdict" and "having written nothing" stay separate
 *    facts — a callback can do both, and a caller that undoes earlier
 *    steps must not infer one from the other.
 * @param conn - Direct connection to the project's meta doc.
 * @param logCtx - Fields for the line written when either side fails.
 * @param write - The publishing callback. Calls `mark()` right before its
 *   first write, then writes. A guard that decides the operation's answer
 *   without writing returns that answer — a refusal or an idempotent
 *   success — and it becomes the outcome.
 * @returns See {@link PublishOutcome}.
 */
async function publishMetaChange(
  conn: MetaDirectConnection,
  logCtx: Record<string, unknown>,
  write: (doc: Y.Doc, mark: () => void) => SpaceRpcResponse | void,
): Promise<PublishOutcome> {
  let wrote = false;
  let decided: SpaceRpcResponse | undefined;
  /**
   * Records that the very next statement writes — from here on, the
   * change must be treated as broadcast.
   */
  const mark = (): void => {
    wrote = true;
  };
  try {
    await conn.transact((doc: Y.Doc) => {
      doc.transact(() => {
        decided = write(doc, mark) ?? undefined;
      });
    });
  } catch (transactError) {
    // What can land here changed with hocuspocus 4, and the three keys below
    // are named for what could land here before it. Until 3.4.4 `transact`
    // awaited an immediate store and rethrew whatever it raised, so a failed
    // write to the database arrived exactly here. In 4.5.0 `transact` does
    // not store at all — the document's own update schedules a debounced one
    // — and a failed store is swallowed inside the library, so no database
    // problem reaches any caller anywhere. Measured both ways:
    // inner/engineering/demo/2026-08-06-v4-transact-store-semantics.mjs.
    //
    // What still arrives is the library refusing a closed connection before
    // running the callback, which is the last branch. The first two need the
    // callback itself to throw, which today means a Y.js write failing —
    // nothing a request can cause. The classification below is kept intact
    // because §6's rule does not depend on what raised: past the write the
    // answer is the truth and nothing is undone. Restoring a signal for a
    // failed store, and the naming that goes with it, is #40's subject.
    //
    // `wrote` decides which line gets logged, `decided` decides the answer.
    // They are independent: a callback can seed the tab list (a write, so
    // a broadcast) and still end on a verdict that needs no further write.
    if (wrote) {
      // Past the line: saying it failed would be a lie every client can
      // see through, and there is nothing left to undo. One complete line.
      logger.error(
        { err: transactError, ...logCtx },
        "space_rpc_not_persisted_after_broadcast",
      );
    } else if (decided !== undefined) {
      // The guard read the world and reached its answer; the publish was
      // never asked to carry anything for it.
      logger.error(
        { err: transactError, ...logCtx },
        "space_rpc_store_failed_after_guard_decided",
      );
    } else {
      logger.error(
        { err: transactError, ...logCtx },
        "space_rpc_failed_before_broadcast",
      );
      return { kind: "failed-before-broadcast" };
    }
  }
  return decided === undefined
    ? { kind: "published" }
    : { kind: "decided", response: decided, broadcast: wrote };
}

/**
 * What a publish outcome obliges the handler to do: which answer to send,
 * and whether anything it did earlier still has to be undone.
 *
 * Both come from what actually happened inside the callback, so no
 * handler decides either for itself. The undo flag matters because
 * "a guard settled this" and "nothing reached the clients" are separate
 * facts — `ensureOpenTabList` can seed a list (a write, so a broadcast)
 * and the next line can still settle on an idempotent success. A handler
 * that inferred "nothing went out" from "a guard settled it" would undo
 * work every client has already seen.
 * @param outcome - What {@link publishMetaChange} returned.
 * @param internal - Builds the controlled error for a failure that
 *   happened before anything went out. Called only in that case, so the
 *   message stays specific to the operation.
 * @returns `response` is what to send, or null to carry on to the
 *   handler's own success path; `undo` is true only when nothing reached
 *   any client.
 *
 * Exported for its own unit test. Only three of the seven operations own
 * content rows, and none of their callbacks can both write and settle, so
 * the write-then-settle row of this table is unreachable through any
 * handler — leaving the rule that guards it with nothing to fail against.
 * A test of the rule itself is what keeps someone from "simplifying" it
 * back to "a verdict means nothing went out", which the tab handlers
 * already disprove.
 */
export function settlePublish(
  outcome: PublishOutcome,
  internal: () => SpaceRpcResponse,
): { response: SpaceRpcResponse | null; undo: boolean } {
  if (outcome.kind === "decided") {
    return { response: outcome.response, undo: !outcome.broadcast };
  }
  if (outcome.kind === "failed-before-broadcast") {
    return { response: internal(), undo: true };
  }
  return { response: null, undo: false };
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
  //
  // The connection opens BEFORE the seed on purpose: an open failure then
  // happens with zero side effects anywhere. Seeding first would leave an
  // orphaned live content row when the open rejects — a ghost that
  // inflates the authoritative Space count the delete floor reads, letting
  // a project's last visible Space be deleted.
  const docName = projectMetaDocName(projectId);
  const conn = await ctx.hocuspocus.openDirectConnection(docName, {
    context: { user: { id: SYSTEM_USER_ID }, source: SYSTEM_SOURCE },
  });
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
    await safeCleanup(
      "disconnect",
      { projectId, spaceId, callerId: caller.userId, during: "create" },
      () => conn.disconnect(),
    );
    return err(req.id, "INTERNAL", "Could not prepare the new Space");
  }
  const seededKinds: TouchedKinds = seeded ? [type] : [];
  const logCtx = {
    projectId,
    spaceId,
    callerId: caller.userId,
    during: "create",
  };
  try {
    const outcome = await publishMetaChange(conn, logCtx, (doc, mark) => {
      const spaces = doc.getMap("spaces");
      // Unreachable by any input now that the id is minted here — it would
      // take a uuid v4 collision. Kept because it costs one line and the
      // alternative is silently overwriting somebody's Space.
      if (spaces.has(spaceId)) {
        return err(req.id, "CONFLICT", `Space ${spaceId} already exists`);
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
    const settled = settlePublish(outcome, () =>
      err(req.id, "INTERNAL", "Could not create the Space"),
    );
    if (settled.response) {
      if (settled.undo) {
        await undoContentRows("soft-delete", projectId, spaceId, seededKinds, logCtx);
      }
      return settled.response;
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
    // Read the doc directly (see `metaDocOf`): these checks touch no
    // storage, so nothing about the database's health can reach their
    // answers. A user whose Space a collaborator already deleted is told
    // exactly that, and is not sent off to retry something that can never
    // succeed.
    const spaces = metaDocOf(conn).getMap("spaces");
    if (!(spaces.get(spaceId) instanceof Y.Map)) {
      return err(req.id, "NOT_FOUND", `Space ${spaceId} not found`);
    }
    // Refuse to delete the last remaining Space. `liveCount` is the PG
    // authority (read under the lock above), so this holds even when two
    // instances delete near-simultaneously: the lock serializes them and
    // each reads the count left by the previous holder's soft-delete.
    // INVARIANT: any future RPC that can REDUCE a project's live Space
    // count must run under withSpaceDeleteLock + this PG-count guard too,
    // or the cross-instance protection is defeated.
    if (liveCount <= 1) {
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
    let snapshot: Record<string, unknown> | null = null;
    let deletedName: string | undefined;
    const outcome = await publishMetaChange(conn, logCtx, (doc, mark) => {
      const live = doc.getMap("spaces");
      const entry = live.get(spaceId);
      // Only "is the entry still there" is re-checked here. The count is
      // NOT: the soft-delete above just decremented it, so re-reading it
      // would refuse every delete in a two-Space project. The lock taken
      // in handleDelete is what makes skipping it safe — no concurrent
      // delete can change the count inside this window.
      if (!(entry instanceof Y.Map)) {
        return err(req.id, "NOT_FOUND", `Space ${spaceId} not found`);
      }
      snapshot = snapshotMap(entry);
      deletedName = entry.get("name") as string | undefined;
      mark();
      live.delete(spaceId);
      clearSpaceFromAllTabs(doc, spaceId);
    });
    const settled = settlePublish(outcome, () =>
      err(req.id, "INTERNAL", "Could not delete the Space"),
    );
    if (settled.response) {
      if (settled.undo) {
        await undoContentRows(
          "restore",
          projectId,
          spaceId,
          softDeleted.touched,
          logCtx,
        );
      }
      return settled.response;
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
    let spaceName: string | undefined;
    const outcome = await publishMetaChange(conn, logCtx, (doc, mark) => {
      const spaces = doc.getMap("spaces");
      const entry = spaces.get(spaceId);
      if (!(entry instanceof Y.Map)) {
        return err(req.id, "NOT_FOUND", `Space ${spaceId} not found`);
      }
      spaceName = entry.get("name") as string | undefined;
      mark();
      entry.set("locked", locked);
    });
    const settled = settlePublish(outcome, () =>
      err(req.id, "INTERNAL", "Could not update the Space"),
    );
    if (settled.response) return settled.response;
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
    let oldName = "";
    const outcome = await publishMetaChange(conn, logCtx, (doc, mark) => {
      const spaces = doc.getMap("spaces");
      const entry = spaces.get(spaceId);
      if (!(entry instanceof Y.Map)) {
        return err(req.id, "NOT_FOUND", `Space ${spaceId} not found`);
      }
      if (entry.get("locked") === true) {
        return err(
          req.id,
          "FORBIDDEN",
          `Space ${spaceId} is locked; unlock before renaming`,
        );
      }
      const previousName = entry.get("name");
      const oldSpaceName =
        typeof previousName === "string" ? previousName : "";
      if (oldSpaceName === name) {
        // Idempotent success per §6.5: the goal state already holds, so
        // nothing needed writing. Returning it here rather than through a
        // flag is what keeps it ahead of a store failure — the same rule
        // that governs the refusals above, in one place.
        return ok(req.id);
      }
      oldName = oldSpaceName;
      mark();
      entry.set("name", name);
    });
    const settled = settlePublish(outcome, () =>
      err(req.id, "INTERNAL", "Could not rename the Space"),
    );
    if (settled.response) return settled.response;
    await recordSpaceActivity(ctx, projectId, {
      actorUserId: caller.userId,
      type: "space:renamed",
      spaceId,
      payload: { spaceName: name, oldSpaceName: oldName },
    });
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
    // Direct read, no transact (see `metaDocOf`): a Space that is already
    // back is already back, whatever the database is doing.
    if (metaDocOf(conn).getMap("spaces").has(spaceId)) {
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
    const outcome = await publishMetaChange(conn, logCtx, (doc, mark) => {
      const spaces = doc.getMap("spaces");
      // Someone else restored it while the content rows were coming back.
      if (spaces.has(spaceId)) {
        return err(req.id, "CONFLICT", `Space ${spaceId} is not deleted`);
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
    const settled = settlePublish(outcome, () =>
      err(req.id, "INTERNAL", "Could not restore the Space"),
    );
    if (settled.response) {
      if (settled.undo) {
        await undoContentRows(
          "soft-delete",
          projectId,
          spaceId,
          restored.touched,
          logCtx,
        );
      }
      return settled.response;
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

/** Top-level meta key holding one record per user. */
const PER_USER_KEY = "perUser";

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
  const perUser = doc.getMap<Y.Map<unknown>>(PER_USER_KEY);
  perUser.forEach((userMap) => {
    const list = userMap.get(OPEN_TAB_IDS_KEY) as Y.Array<string> | undefined;
    if (!list) return;
    for (let i = list.length - 1; i >= 0; i -= 1) {
      if (list.get(i) === spaceId) list.delete(i, 1);
    }
  });
}

/**
 * The caller's open-tab list as it stands, without creating anything.
 *
 * Returns null for both states {@link ensureOpenTabList} has to seed — no
 * record at all, and a record carrying no list. Seeding is a write, so a
 * pre-check cannot settle those two; it can only settle the case where a
 * list already exists and says the tab is not open.
 * @param doc - The project meta doc.
 * @param userId - Caller's userId, taken from the authenticated connection.
 * @returns The existing list, or null when there is none yet.
 */
function existingOpenTabList(
  doc: Y.Doc,
  userId: string,
): Y.Array<string> | null {
  const userMap = doc.getMap<Y.Map<unknown>>(PER_USER_KEY).get(userId);
  const list = userMap?.get(OPEN_TAB_IDS_KEY);
  return list instanceof Y.Array ? (list as Y.Array<string>) : null;
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
  const perUser = doc.getMap<Y.Map<unknown>>(PER_USER_KEY);
  let userMap = perUser.get(userId);
  if (!userMap) {
    mark();
    userMap = new Y.Map<unknown>();
    perUser.set(userId, userMap);
  }
  // Same predicate as the pre-check, from the same function: "does this
  // caller have a list" gets one answer, not two that could drift.
  const existing = existingOpenTabList(doc, userId);
  if (existing !== null) return existing;
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
    const outcome = await publishMetaChange(conn, logCtx, (doc, mark) => {
      const spaces = doc.getMap("spaces");
      if (!spaces.has(spaceId)) {
        return err(req.id, "NOT_FOUND", `Space ${spaceId} does not exist`);
      }
      const list = ensureOpenTabList(doc, caller.userId, spaces, mark);
      // Already open: touch nothing. Re-adding would broadcast a change
      // that changes nothing to everyone on the account. §6.6 makes this
      // an idempotent success, so it is a verdict like any other.
      if (list.toArray().includes(spaceId)) {
        return ok(req.id);
      }
      mark();
      list.push([spaceId]);
    });
    const settled = settlePublish(outcome, () =>
      err(req.id, "INTERNAL", "Could not open the tab"),
    );
    if (settled.response) return settled.response;
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
    // Direct read (see `metaDocOf`): a tab that is not open needs nothing
    // written, so no database problem can turn that into an error. Only
    // the two states §6.6.1 seeds fall through, because seeding IS a
    // write and has to go through the publish path.
    const existing = existingOpenTabList(metaDocOf(conn), caller.userId);
    if (existing !== null && !existing.toArray().includes(spaceId)) {
      return ok(req.id);
    }
    const outcome = await publishMetaChange(conn, logCtx, (doc, mark) => {
      const spaces = doc.getMap("spaces");
      // Seeding first is what makes "close one" mean "keep the others"
      // for a user who has never opened anything: their bar is showing
      // every Space, and without the seed the result would be a list
      // holding nothing at all.
      const list = ensureOpenTabList(doc, caller.userId, spaces, mark);
      let removed = false;
      for (let i = list.length - 1; i >= 0; i--) {
        if (list.get(i) === spaceId) {
          mark();
          list.delete(i, 1);
          removed = true;
        }
      }
      // Nothing matched. NOT a race with the check above: there is no
      // await between it and this callback, so no remote update can land
      // in between. The reachable case is the seeding one — a caller with
      // no list closing a tab whose Space left the directory before the
      // request arrived, so the freshly seeded list never held that id.
      // Nothing left to write, so this is a success, the same shape §6.5
      // gives a rename to the name a Space already has. The seed itself
      // may well have written; `settlePublish` keeps those two apart.
      if (!removed) return ok(req.id);
    });
    const settled = settlePublish(outcome, () =>
      err(req.id, "INTERNAL", "Could not close the tab"),
    );
    if (settled.response) return settled.response;
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
