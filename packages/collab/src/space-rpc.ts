/**
 * Collab-side handlers for client-initiated Space lifecycle RPCs.
 *
 * Per ADR 2026-05-23-yjs-collab-only-write-authz:
 *
 *   - create / delete / lock / unlock / rename — caller role ≥ edit
 *   - restore / messages:clear                  — caller role = owner
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
 *      (per `auth.ts` space-exists check — meta.spaces is the source of
 *      truth for "exists right now", `yjs_documents.deletedAt` is the
 *      defense-in-depth backstop).
 *   5. For restore: reverses both — sets the entry back and clears the
 *      `deletedAt` column on the canvas row.
 *
 * Returns a `SpaceRpcResponse` whose `id` echoes the request id so
 * the client can demultiplex concurrent in-flight RPCs.
 */
import type { Hocuspocus } from "@hocuspocus/server";
import type postgres from "postgres";
import * as Y from "yjs";

import {
  canvasSpaceDocName,
  projectMetaDocName,
  type ProjectRole,
  type SpaceRpcRequest,
  type SpaceRpcResponse,
  type ProjectMessageKind,
} from "@breatic/shared";

import { createLogger } from "./logger.js";

const logger = createLogger("space-rpc");

export interface SpaceRpcContext {
  hocuspocus: Hocuspocus;
  sql: ReturnType<typeof postgres>;
}

export interface SpaceRpcCaller {
  userId: string;
  role: ProjectRole;
}

const SYSTEM_USER_ID = "system";
const SYSTEM_SOURCE = "space-rpc";

/** Compact reply builder so handlers stay one-liner-y. */
function ok(
  id: string,
  result?: { spaceId: string; type: "canvas" | "document" | "timeline"; name: string },
): SpaceRpcResponse {
  return { id, ok: true, result };
}

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

/** Role rank — higher is more privileged. */
const ROLE_RANK: Record<ProjectRole, number> = { view: 1, edit: 2, owner: 3 };

function requireAtLeast(role: ProjectRole, min: ProjectRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[min];
}

/**
 * Push a `projectMessages` entry inside the given Yjs transaction. The
 * caller must already hold a transact() context — this helper does not
 * open its own. Snapshot fields exist so a `space-deleted` entry can
 * be reverse-engineered into a restore later without keeping the
 * deleted entry in `meta.spaces`.
 */
function pushProjectMessage(
  doc: Y.Doc,
  args: {
    kind: ProjectMessageKind;
    actor?: string;
    spaceId?: string;
    spaceName?: string;
    spaceSnapshot?: Record<string, unknown>;
    message?: string;
  },
): void {
  const entry = new Y.Map<unknown>();
  entry.set("id", `pm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  entry.set("kind", args.kind);
  if (args.actor !== undefined) entry.set("actor", args.actor);
  if (args.spaceId !== undefined) entry.set("spaceId", args.spaceId);
  if (args.spaceName !== undefined) entry.set("spaceName", args.spaceName);
  if (args.spaceSnapshot !== undefined) {
    entry.set("spaceSnapshot", args.spaceSnapshot);
  }
  if (args.message !== undefined) entry.set("message", args.message);
  entry.set("createdAt", Date.now());
  doc.getArray("projectMessages").push([entry]);
}

/**
 * Read a Y.Map's contents as a plain JS object suitable for stashing
 * inside a projectMessages snapshot field. Skips nested CRDTs — Space
 * entries are flat (id / type / name / order / locked / createdAt), so
 * `toJSON()` returns a plain object.
 */
function snapshotMap(m: Y.Map<unknown>): Record<string, unknown> {
  return m.toJSON() as Record<string, unknown>;
}

/** Soft-delete the `yjs_documents` row for a canvas-{spaceId} doc. */
async function softDeleteCanvasRow(
  sql: ReturnType<typeof postgres>,
  projectId: string,
  spaceId: string,
): Promise<void> {
  const docName = canvasSpaceDocName(projectId, spaceId);
  await sql`
    UPDATE yjs_documents
    SET deleted_at = now()
    WHERE name = ${docName} AND deleted_at IS NULL
  `;
}

/** Restore (clear deleted_at on) the canvas-{spaceId} row. */
async function restoreCanvasRow(
  sql: ReturnType<typeof postgres>,
  projectId: string,
  spaceId: string,
): Promise<void> {
  const docName = canvasSpaceDocName(projectId, spaceId);
  await sql`
    UPDATE yjs_documents
    SET deleted_at = NULL
    WHERE name = ${docName}
  `;
}

// ── Handlers ────────────────────────────────────────────────────────

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
  let spaceName: string | undefined;
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
      spaceName = entry.get("name") as string | undefined;
      spaces.delete(spaceId);
      pushProjectMessage(doc, {
        kind: "space-deleted",
        actor: caller.userId,
        spaceId,
        spaceName,
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
  await softDeleteCanvasRow(ctx.sql, projectId, spaceId);
  return ok(req.id);
}

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
 * with `FORBIDDEN` if the Space is currently locked — locked Spaces
 * must be unlocked before any metadata mutation.
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
      entry.set("name", name);
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
    return ok(req.id);
  } finally {
    await conn.disconnect();
  }
}

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
        // Already present — owner clicked restore on a Space that's
        // not deleted. Treat as conflict so the client surfaces a
        // distinct error UX.
        return;
      }
      // Find the most recent space-deleted entry for this spaceId so
      // we can read its snapshot and rebuild the entry. We walk the
      // array from the tail for the latest record.
      const messages = doc.getArray("projectMessages");
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages.get(i);
        if (
          m instanceof Y.Map &&
          m.get("kind") === "space-deleted" &&
          m.get("spaceId") === spaceId
        ) {
          const s = m.get("spaceSnapshot");
          if (s && typeof s === "object") {
            snapshot = s as Record<string, unknown>;
            break;
          }
        }
      }
      if (!snapshot) {
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
        spaceName: snapshot.name as string | undefined,
      });
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
  await restoreCanvasRow(ctx.sql, projectId, spaceId);
  return ok(req.id);
}

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
