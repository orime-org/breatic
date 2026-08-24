// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Yjs initial-state encoders for project bootstrap.
 *
 * `collab/lazy-seed` calls {@link encodeInitialMetaState} the first time a
 * project's meta doc is opened (lazy seed) to write `yjs_documents` with a
 * single Space already present in the meta doc, so a first-time visitor sees
 * one Space without the pre-v10 frontend bootstrap effect that POSTed
 * `/spaces` after the fact.
 *
 * Why a separate module:
 *   - Keeps the Yjs binary format out of `project.repo.ts` and
 *     `project.service.ts` — they receive a `Uint8Array` and don't
 *     know its layout.
 *   - Pure function (no IO), unit-testable without a database.
 *   - Single canonical place to grow when document/timeline space
 *     kinds become writable.
 *
 * Edge case (v10 §collab-runtime-ownership):
 *   This is the ONE write path that bypasses Hocuspocus and writes
 *   `yjs_documents.data` directly from outside the collab process.
 *   It is safe ONLY because the project is being created in this same
 *   transaction — no client can possibly be connected to the meta doc
 *   yet, so there is no in-memory Hocuspocus copy that could overwrite
 *   our bytes on the next debounce flush. Do NOT reuse this pattern
 *   for "edit a Space on a live project" scenarios — those must go
 *   through `Hocuspocus.openDirectConnection` (see
 *   `collab/members-sync.ts`).
 */

import * as Y from "yjs";

/** The kinds of Space the meta doc tracks. Mirrors `@breatic/shared` SpaceType. */
export type SpaceKind = "canvas" | "document" | "timeline";

export interface EncodeInitialMetaStateArgs {
  spaceId: string;
  kind: SpaceKind;
  name: string;
  createdBy: string;
  /** Milliseconds since epoch. Caller passes `Date.now()` in production. */
  ts: number;
}

/** Fields needed to construct one Space entry in a meta doc's `spaces` map. */
export interface SpaceEntryInit {
  spaceId: string;
  type: SpaceKind;
  name: string;
  /**
   * Position in the tab bar — `0` for the bootstrap first Space,
   * `spaces.size` for a later one.
   */
  order: number;
  /** Milliseconds since epoch. */
  createdAt: number;
  /** Creator's userId (UUID). */
  createdBy: string;
  /**
   * The token the requesting client sent with `space:create`, echoed back
   * on the entry so that client — and only that client — recognises the
   * Space it asked for when the entry is broadcast.
   *
   * Absent for the first Space of a project: the server seeds that one on
   * its own and nobody is waiting on it. Absent means the key is not
   * written at all, not written as `undefined` — this entry lives in a
   * permanently shared document and travels into the delete snapshot.
   *
   * Stored and echoed verbatim; never parsed, never used for a decision.
   */
  claimToken?: string;
}

/**
 * Insert one Space entry into a meta doc's `spaces` Y.Map.
 *
 * This is the SINGLE source of truth for a Space's field shape: both the
 * bootstrap seed ({@link encodeInitialMetaState}, the first Space) and
 * collab's live `space:create` RPC handler (`space-rpc.handleCreate`,
 * every later Space) call it, so the first Space and every subsequent
 * Space are built identically — one construction logic, not two
 * divergent ones. The caller owns the surrounding `Y.Doc` / transaction
 * context; this helper only mutates the passed `spaces` map.
 * @param spaces - The meta doc's `spaces` Y.Map (keyed by spaceId).
 * @param init - The Space's id / type / name / order / timestamp / creator.
 */
export function writeSpaceEntry(
  spaces: Y.Map<unknown>,
  init: SpaceEntryInit,
): void {
  const entry = new Y.Map<unknown>();
  entry.set("id", init.spaceId);
  entry.set("type", init.type);
  entry.set("name", init.name);
  entry.set("order", init.order);
  entry.set("locked", false);
  entry.set("createdAt", init.createdAt);
  entry.set("createdBy", init.createdBy);
  if (init.claimToken !== undefined) {
    entry.set("claimToken", init.claimToken);
  }
  spaces.set(init.spaceId, entry);
}

/**
 * Encode an initial Yjs update for `project-{pid}/meta` containing
 * exactly one Space entry.
 *
 * The returned bytes are suitable for `INSERT INTO yjs_documents
 * (name, data) VALUES (..., $bytes)`. The first Hocuspocus client
 * that loads the meta doc will see `spaces[spaceId] = { ...entry }`
 * and nothing else.
 *
 * Determinism note: this constructs a fresh `Y.Doc()` each call, and yjs
 * assigns it a random `clientID`, so two calls with identical args would
 * otherwise produce different bytes. Pinning the id to 1 makes them
 * reproducible, which is what migration replay wants.
 *
 * It is not what persistence wants, though — `seedInitialState` writes with
 * `onConflictDoNothing`, so a second seed of the same document name never
 * reaches the row and the bytes are never compared. Reproducibility here is
 * for the replay case alone.
 * @param args - the single Space entry plus actor / creator / timestamp fields to seed the meta doc
 * @returns the encoded Yjs update bytes, ready to persist as the doc's initial state
 */
export function encodeInitialMetaState(
  args: EncodeInitialMetaStateArgs,
): Uint8Array {
  const {
    spaceId,
    kind,
    name,
    createdBy,
    ts,
  } = args;

  const doc = new Y.Doc();
  // Stable clientID makes the encoded update deterministic across calls with
  // the same args. It is NOT outside the range yjs draws from — that range is
  // the whole of `random.uint32()`, which includes 1. Collisions with a live
  // editor stay vanishingly unlikely for the ordinary reason: a client would
  // have to draw 1 out of 2^32.
  doc.clientID = 1;

  const spaces = doc.getMap("spaces");
  writeSpaceEntry(spaces, {
    spaceId,
    type: kind,
    name,
    order: 0,
    createdAt: ts,
    createdBy,
  });

  // The initial space:created audit entry lives in the PG
  // project_activities table (ADR 2026-07-04 project-activity-feed -
  // the meta-doc projectMessages Y.Array is retired); the caller that
  // seeds this doc (server project creation / collab lazy-seed) writes
  // that activity row itself, since only it knows the actor + can
  // reach the business DB at the right transactional moment.

  // No identity is seeded here. This used to write `meta.users[creator]`
  // (name + avatar + lastSeenAt) so a peer opening the project before the
  // creator first connected would still see a name on the space-created
  // audit entry. #1882 retired that: the activity feed renders `actorName`
  // from the PG activity row and never read it, and a display name is now
  // resolved from the project roster at render time — server data that
  // cannot go stale, unlike a copy frozen at creation.
  //
  // `meta.users` itself came back in #1886, in a different shape and for a
  // different job: a presence record per user, `{ id, online, lastSeenAt }`
  // and nothing else, written ONLY by the collab server as people connect and
  // leave. It is still not seeded here, and that is load-bearing rather than
  // incidental — `markOnline` reads an absent entry as "this person has never
  // been here", so a row invented at project creation would be a person the
  // presence rules believe is already known.

  // Seed a `meta.perUser` entry with the first space opened + active.
  //
  // This does not reach anybody today, and the comment here used to claim it
  // did. The only caller is collab's lazy seed, which passes `createdBy:
  // "system"` — a placeholder, not the creator's user id. So the entry lands
  // under a user nobody signs in as, and a real first-time visitor still has
  // no entry of their own, which is exactly the case the frontend's
  // `readMetaState` fallback handles by opening every Space.
  //
  // `activeSpaceId` has no reader either: which tab is active is local window
  // state (2026-07-11), and the frontend projection deliberately ignores the
  // key. Removing both is its own task; leaving the description wrong was
  // not an option.
  const perUser = doc.getMap("perUser");
  const creatorPerUser = new Y.Map<unknown>();
  const openTabIds = new Y.Array<string>();
  openTabIds.push([spaceId]);
  creatorPerUser.set("openTabIds", openTabIds);
  creatorPerUser.set("activeSpaceId", spaceId);
  perUser.set(createdBy, creatorPerUser);

  return Y.encodeStateAsUpdate(doc);
}

// A Space's CONTENT doc is seeded from `@breatic/shared`'s
// `encodeInitialSpaceContent`, which callers reach directly — the editor in
// the browser consumes that same function, and one shared definition is the
// point. core briefly wrapped it under a second name; the wrapper only
// renamed, and a rename is not worth a hop.

/**
 * Default display name for a freshly-seeded Space of a given kind.
 *
 * The seed runs in collab with no i18n context, so it uses the kind's
 * English label; the creating user renames the Space afterwards.
 * @param kind - The Space type being seeded
 * @returns The default Space name (`"Canvas"` / `"Document"` / `"Timeline"`)
 */
export function defaultSpaceName(kind: SpaceKind): string {
  switch (kind) {
    case "canvas":
      return "Canvas";
    case "document":
      return "Document";
    case "timeline":
      return "Timeline";
  }
}
