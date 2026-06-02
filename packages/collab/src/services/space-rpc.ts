/**
 * Collab-side handlers for client-initiated Space lifecycle RPCs.
 *
 * Per ADR 2026-05-23-yjs-collab-only-write-authz:
 *
 *   - create / delete / lock / unlock / rename - caller role ≥ edit
 *   - restore / messages:clear                  - caller role = owner
 *
 * Each handler:
 *
 *   1. Validates the caller's role.
 *   2. Opens a privileged DirectConnection to the project's meta doc
 *      with `context.user.id = 'system'` so `beforeHandleMessage`
 *      lets the write through (the client-facing gate refuses
 *      anything coming from a real user id).
 *   3. Performs the meta-doc mutation (set / delete a `spaces` entry,
 *      push a `projectMessages` entry, etc.) in a single Y transaction.
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
import type { Hocuspocus } from "@hocuspocus/server";
import * as Y from "yjs";

import { yjsDocumentsRepo } from "@breatic/core";
import {
  canvasSpaceDocName,
  projectMetaDocName,
  type ProjectRole,
  type SpaceRpcRequest,
  type SpaceRpcResponse,
  type ProjectMessageKind,
} from "@breatic/shared";

import { createLogger } from "@collab/infra/logger.js";

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
const ROLE_RANK: Record<ProjectRole, number> = { view: 1, edit: 2, owner: 3 };

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
 * Push a `projectMessages` entry inside the given Yjs transaction. The
 * caller must already hold a transact() context - this helper does not
 * open its own. Snapshot fields exist so a `space-deleted` entry can
 * be reverse-engineered into a restore later without keeping the
 * deleted entry in `meta.spaces`.
 */
/**
 * Q11 v2 - projectMessages stores pointers, not snapshot strings.
 *
 * `actor` is the caller's userId (UUID); the frontend looks up
 * `meta.users[actor].name` at render time so a username rename
 * propagates retroactively. Likewise `spaceId` is enough on its own
 * - `meta.spaces[spaceId].name` gives the live name, so a Space
 * rename is reflected in every historical message that references
 * it. `spaceSnapshot` is preserved for `space-deleted` because the
 * id leaves `meta.spaces` at delete time and Restore needs the
 * original name + type to re-create the entry.
 *
 * The `id` field is the full Yjs entry identifier (`pm-${ts}-${full
 * uuid}`); no slice truncation per the design discussion ("never slice any ID from now on"). `Math.random()` was avoided because it would break
 * `encodeInitialMetaState`'s determinism contract - and consistency
 * across collab + bootstrap paths is easier when both use the same
 * id-generation shape.
 * @param doc - The meta Y.Doc whose `projectMessages` array receives the new entry; caller already holds the transact context.
 * @param args - Fields describing the audit entry to append.
 * @param args.kind - Message kind (e.g. `space-created` / `space-deleted` / `space-renamed`).
 * @param args.actor - Caller's userId (UUID); the name is resolved at render time via `meta.users[actor]`.
 * @param args.spaceId - Pointer into `meta.spaces` for the referenced Space, when applicable.
 * @param args.spaceName - Space name snapshot at event time, rendered verbatim by the frontend.
 * @param args.oldSpaceName - Previous name for `space-renamed` entries, paired with the new `spaceName`.
 * @param args.spaceSnapshot - Full Space entry preserved for `space-deleted` so Restore can re-create it.
 * @param args.message - i18n key supplying extra context for kinds that need it (e.g. `missing-node`).
 */
function pushProjectMessage(
  doc: Y.Doc,
  args: {
    kind: ProjectMessageKind;
    /** userId (UUID) - render-time lookup via meta.users for name. */
    actor: string;
    /** Pointer into `meta.spaces` for non-name metadata (e.g. type). */
    spaceId?: string;
    /**
     * Space name at event time. Frozen snapshot - rename will push
     * its own `space-renamed` audit entry, leaving every prior entry
     * carrying the historical name. The frontend renders this
     * verbatim and does NOT look up the live name (Q11 v2.1).
     */
    spaceName?: string;
    /**
     * `space-renamed` only - pre-rename name snapshot. Paired with
     * `spaceName` (the new name) the frontend renders the transition.
     */
    oldSpaceName?: string;
    /** Only for `space-deleted`: full Space entry for Restore re-hydration. */
    spaceSnapshot?: Record<string, unknown>;
    message?: string; // i18n key for kinds that need extra context (e.g. `missing-node`)
  },
): void {
  const entry = new Y.Map<unknown>();
  const ts = Date.now();
  entry.set("id", args.spaceId ? `pm-${ts}-${args.spaceId}` : `pm-${ts}`);
  entry.set("kind", args.kind);
  entry.set("actor", args.actor);
  if (args.spaceId !== undefined) entry.set("spaceId", args.spaceId);
  if (args.spaceName !== undefined) entry.set("spaceName", args.spaceName);
  if (args.oldSpaceName !== undefined) {
    entry.set("oldSpaceName", args.oldSpaceName);
  }
  if (args.spaceSnapshot !== undefined) {
    entry.set("spaceSnapshot", args.spaceSnapshot);
  }
  if (args.message !== undefined) entry.set("message", args.message);
  entry.set("createdAt", ts);
  doc.getArray("projectMessages").push([entry]);
}

/**
 * Read a Y.Map's contents as a plain JS object suitable for stashing
 * inside a projectMessages snapshot field. Skips nested CRDTs - Space
 * entries are flat (id / type / name / order / locked / createdAt), so
 * `toJSON()` returns a plain object.
 * @param m - A flat Space entry Y.Map (id / type / name / order / locked / createdAt).
 * @returns The Y.Map's contents as a plain JS object suitable for a snapshot field.
 */
function snapshotMap(m: Y.Map<unknown>): Record<string, unknown> {
  return m.toJSON() as Record<string, unknown>;
}

/**
 * Soft-delete the `yjs_documents` row for a canvas-{spaceId} doc, via
 * the shared core repo (the single home for that table's SQL).
 * @param projectId - Project the canvas doc belongs to.
 * @param spaceId - Space whose canvas doc row is marked deleted.
 */
async function softDeleteCanvasRow(
  projectId: string,
  spaceId: string,
): Promise<void> {
  await yjsDocumentsRepo.softDeleteByName(
    canvasSpaceDocName(projectId, spaceId),
  );
}

/**
 * Restore (clear deleted_at on) the canvas-{spaceId} row, via the
 * shared core repo.
 * @param projectId - Project the canvas doc belongs to.
 * @param spaceId - Space whose canvas doc row has its `deleted_at` cleared.
 */
async function restoreCanvasRow(
  projectId: string,
  spaceId: string,
): Promise<void> {
  await yjsDocumentsRepo.restoreByName(canvasSpaceDocName(projectId, spaceId));
}

// ── Handlers ────────────────────────────────────────────────────────

/**
 * Create a new Space entry in `meta.spaces`. Caller role ≥ edit.
 * Returns `CONFLICT` if the spaceId already exists.
 * @param ctx - Collab context providing the Hocuspocus server.
 * @param projectId - Project whose meta doc the Space is added to.
 * @param caller - Authenticated caller's userId + role, gating the operation.
 * @param req - The `space:create` request carrying the new spaceId, type, and name.
 * @returns A success response echoing the created Space, or a `FORBIDDEN` / `CONFLICT` error.
 */
async function handleCreate(
  ctx: SpaceRpcContext,
  projectId: string,
  caller: SpaceRpcCaller,
  req: Extract<SpaceRpcRequest, { type: "space:create" }>,
): Promise<SpaceRpcResponse> {
  if (!requireAtLeast(caller.role, "edit")) {
    return err(req.id, "FORBIDDEN", `Role ${caller.role} cannot create Space`);
  }
  const { spaceId, type, name } = req.payload;
  const docName = projectMetaDocName(projectId);
  const conn = await ctx.hocuspocus.openDirectConnection(docName, {
    context: { user: { id: SYSTEM_USER_ID }, source: SYSTEM_SOURCE },
  });
  try {
    let conflict = false;
    await conn.transact((doc: Y.Doc) => {
      const spaces = doc.getMap("spaces");
      if (spaces.has(spaceId)) {
        conflict = true;
        return;
      }
      const entry = new Y.Map<unknown>();
      entry.set("id", spaceId);
      entry.set("type", type);
      entry.set("name", name);
      entry.set("order", spaces.size);
      entry.set("locked", false);
      entry.set("createdAt", Date.now());
      entry.set("createdBy", caller.userId);
      spaces.set(spaceId, entry);
      pushProjectMessage(doc, {
        kind: "space-created",
        actor: caller.userId,
        spaceId,
        spaceName: name,
      });
    });
    if (conflict) {
      return err(req.id, "CONFLICT", `Space ${spaceId} already exists`);
    }
    return ok(req.id, { spaceId, type, name });
  } finally {
    await conn.disconnect();
  }
}

/**
 * Delete a Space: remove its `meta.spaces` entry, push a
 * `space-deleted` audit message (with snapshot for Restore), then
 * soft-delete its canvas PG row. Caller role ≥ edit.
 * @param ctx - Collab context providing the Hocuspocus server.
 * @param projectId - Project whose meta doc the Space is removed from.
 * @param caller - Authenticated caller's userId + role, gating the operation.
 * @param req - The `space:delete` request carrying the target spaceId.
 * @returns A success response, or a `FORBIDDEN` / `NOT_FOUND` error.
 */
async function handleDelete(
  ctx: SpaceRpcContext,
  projectId: string,
  caller: SpaceRpcCaller,
  req: Extract<SpaceRpcRequest, { type: "space:delete" }>,
): Promise<SpaceRpcResponse> {
  if (!requireAtLeast(caller.role, "edit")) {
    return err(req.id, "FORBIDDEN", `Role ${caller.role} cannot delete Space`);
  }
  const { spaceId } = req.payload;
  const docName = projectMetaDocName(projectId);
  const conn = await ctx.hocuspocus.openDirectConnection(docName, {
    context: { user: { id: SYSTEM_USER_ID }, source: SYSTEM_SOURCE },
  });
  let snapshot: Record<string, unknown> | null = null;
  try {
    let notFound = false;
    await conn.transact((doc: Y.Doc) => {
      const spaces = doc.getMap("spaces");
      const entry = spaces.get(spaceId);
      if (!(entry instanceof Y.Map)) {
        notFound = true;
        return;
      }
      snapshot = snapshotMap(entry);
      const deletedName = entry.get("name") as string | undefined;
      spaces.delete(spaceId);
      pushProjectMessage(doc, {
        kind: "space-deleted",
        actor: caller.userId,
        spaceId,
        spaceName: deletedName,
        spaceSnapshot: snapshot ?? undefined,
      });
    });
    if (notFound) {
      return err(req.id, "NOT_FOUND", `Space ${spaceId} not found`);
    }
  } finally {
    await conn.disconnect();
  }
  // Soft-delete the canvas-{spaceId} PG row AFTER the meta mutation so
  // a freshly reconnecting client cannot race in between (the
  // auth-hook space-exists check refuses the connection regardless,
  // belt-and-suspenders).
  await softDeleteCanvasRow(projectId, spaceId);
  return ok(req.id);
}

/**
 * Lock or unlock a Space (set its `locked` flag) and push the matching
 * `space-locked` / `space-unlocked` audit message. Caller role ≥ edit.
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
  if (!requireAtLeast(caller.role, "edit")) {
    return err(req.id, "FORBIDDEN", `Role ${caller.role} cannot lock Space`);
  }
  const { spaceId, locked } = req.payload;
  const docName = projectMetaDocName(projectId);
  const conn = await ctx.hocuspocus.openDirectConnection(docName, {
    context: { user: { id: SYSTEM_USER_ID }, source: SYSTEM_SOURCE },
  });
  try {
    let notFound = false;
    await conn.transact((doc: Y.Doc) => {
      const spaces = doc.getMap("spaces");
      const entry = spaces.get(spaceId);
      if (!(entry instanceof Y.Map)) {
        notFound = true;
        return;
      }
      entry.set("locked", locked);
      pushProjectMessage(doc, {
        kind: locked ? "space-locked" : "space-unlocked",
        actor: caller.userId,
        spaceId,
        spaceName: entry.get("name") as string | undefined,
      });
    });
    if (notFound) {
      return err(req.id, "NOT_FOUND", `Space ${spaceId} not found`);
    }
    return ok(req.id);
  } finally {
    await conn.disconnect();
  }
}

/**
 * Rename an existing Space's `name`. Caller role ≥ edit. Refuses
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
  if (!requireAtLeast(caller.role, "edit")) {
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
        // same name doesn't pollute projectMessages with a phantom
        // "X renamed Foo to Foo".
        noop = true;
        return;
      }
      entry.set("name", name);
      pushProjectMessage(doc, {
        kind: "space-renamed",
        actor: caller.userId,
        spaceId,
        spaceName: name,
        oldSpaceName,
      });
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
    void noop; // explicit: no-op rename still returns ok (no error to surface)
    return ok(req.id);
  } finally {
    await conn.disconnect();
  }
}

/**
 * Restore a previously deleted Space: rebuild its `meta.spaces` entry
 * from the latest unrestored `space-deleted` snapshot, mark that audit
 * entry `restored`, then clear `deleted_at` on its canvas PG row.
 * Caller role = owner.
 * @param ctx - Collab context providing the Hocuspocus server.
 * @param projectId - Project whose meta doc the Space is restored into.
 * @param caller - Authenticated caller's userId + role; only `owner` may restore.
 * @param req - The `space:restore` request carrying the target spaceId.
 * @returns A success response, or a `FORBIDDEN` / `NOT_FOUND` (no restorable deletion record) error.
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
  const docName = projectMetaDocName(projectId);
  const conn = await ctx.hocuspocus.openDirectConnection(docName, {
    context: { user: { id: SYSTEM_USER_ID }, source: SYSTEM_SOURCE },
  });
  try {
    let snapshot: Record<string, unknown> | null = null;
    await conn.transact((doc: Y.Doc) => {
      const spaces = doc.getMap("spaces");
      if (spaces.has(spaceId)) {
        // Already present - owner clicked restore on a Space that's
        // not deleted. Treat as conflict so the client surfaces a
        // distinct error UX.
        return;
      }
      // Find the most recent UNRESTORED `space-deleted` entry for
      // this spaceId - we read its snapshot to rebuild the Space
      // AND mutate `restored = true` on the same entry so the bell
      // sheet's restore button can render a disabled "restored" badge
      // without round-tripping a second time. The `restored !==
      // true` filter is what keeps a delete → restore → delete →
      // restore loop honest: each cycle finds its own unrestored
      // deleted entry instead of accidentally re-marking an
      // already-handled one. Walk from the tail for the latest
      // matching record.
      const messages = doc.getArray("projectMessages");
      let deletedEntry: Y.Map<unknown> | null = null;
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages.get(i);
        if (
          m instanceof Y.Map &&
          m.get("kind") === "space-deleted" &&
          m.get("spaceId") === spaceId &&
          m.get("restored") !== true
        ) {
          const s = m.get("spaceSnapshot");
          if (s && typeof s === "object") {
            snapshot = s as Record<string, unknown>;
            deletedEntry = m;
            break;
          }
        }
      }
      if (!snapshot || !deletedEntry) {
        return;
      }
      const entry = new Y.Map<unknown>();
      for (const [k, v] of Object.entries(snapshot)) {
        entry.set(k, v);
      }
      spaces.set(spaceId, entry);
      pushProjectMessage(doc, {
        kind: "space-restored",
        actor: caller.userId,
        spaceId,
        spaceName: snapshot && typeof (snapshot).name === "string"
          ? ((snapshot).name)
          : undefined,
      });
      // Mark the original deleted entry as restored so any client
      // looking at the audit log knows the row was brought back.
      // Same transact as the spaces.set + pushProjectMessage above,
      // so peers receive the rebuild + new audit entry + restored
      // flag atomically (a partial state - restored entry pushed
      // but the deleted row still flagged unrestored - never
      // appears on the wire).
      deletedEntry.set("restored", true);
    });
    if (!snapshot) {
      return err(
        req.id,
        "NOT_FOUND",
        `No deletion record found for Space ${spaceId} (or already restored)`,
      );
    }
  } finally {
    await conn.disconnect();
  }
  await restoreCanvasRow(projectId, spaceId);
  return ok(req.id);
}

/**
 * Clear `projectMessages` entries — all of them, a specific id set, or
 * those older than a cutoff timestamp, depending on the payload.
 * Caller role = owner.
 * @param ctx - Collab context providing the Hocuspocus server.
 * @param projectId - Project whose meta doc holds the `projectMessages` array.
 * @param caller - Authenticated caller's userId + role; only `owner` may clear messages.
 * @param req - The `messages:clear` request selecting all / specific ids / older-than entries.
 * @returns A success response, or a `FORBIDDEN` error when the caller is not the owner.
 */
async function handleMessagesClear(
  ctx: SpaceRpcContext,
  projectId: string,
  caller: SpaceRpcCaller,
  req: Extract<SpaceRpcRequest, { type: "messages:clear" }>,
): Promise<SpaceRpcResponse> {
  if (caller.role !== "owner") {
    return err(
      req.id,
      "FORBIDDEN",
      `Only owner can clear projectMessages (role: ${caller.role})`,
    );
  }
  const docName = projectMetaDocName(projectId);
  const conn = await ctx.hocuspocus.openDirectConnection(docName, {
    context: { user: { id: SYSTEM_USER_ID }, source: SYSTEM_SOURCE },
  });
  try {
    await conn.transact((doc: Y.Doc) => {
      const arr = doc.getArray("projectMessages");
      if (req.payload.all === true) {
        if (arr.length > 0) arr.delete(0, arr.length);
        return;
      }
      if (req.payload.ids && req.payload.ids.length > 0) {
        const idSet = new Set(req.payload.ids);
        // Walk from tail to head so index shifts on delete don't move
        // entries we haven't visited yet.
        for (let i = arr.length - 1; i >= 0; i--) {
          const m = arr.get(i);
          if (m instanceof Y.Map && idSet.has(m.get("id") as string)) {
            arr.delete(i, 1);
          }
        }
        return;
      }
      if (typeof req.payload.olderThanMs === "number") {
        const cutoff = req.payload.olderThanMs;
        for (let i = arr.length - 1; i >= 0; i--) {
          const m = arr.get(i);
          if (m instanceof Y.Map && (m.get("createdAt") as number) < cutoff) {
            arr.delete(i, 1);
          }
        }
      }
    });
  } finally {
    await conn.disconnect();
  }
  return ok(req.id);
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
      case "messages:clear":
        return await handleMessagesClear(ctx, projectId, caller, request);
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
