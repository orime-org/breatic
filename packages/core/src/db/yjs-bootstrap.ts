// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Yjs initial-state encoders for project bootstrap.
 *
 * `core/project.service.create` calls {@link encodeInitialMetaState}
 * inside the project-creation transaction to seed
 * `yjs_documents` with a single Space already present in the meta
 * doc. This makes "project exists ⇔ at least one Space exists" an
 * invariant established at creation time, eliminating the pre-v10
 * frontend bootstrap effect that POSTed `/spaces` after the fact.
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
  /**
   * Creator's display name (their personal studio `name`, falling back
   * to the email local-part). Seeded into `meta.users[actor]` so other
   * members reading the project before the creator first connects
   * — e.g. a share link opened by a peer immediately after project
   * creation — still see the creator's name in
   * `space-created` audit lookups instead of falling back to UUID.
   */
  creatorName: string;
  /** Creator's avatar URL (nullable — Google OAuth path, null otherwise today). */
  creatorAvatarUrl: string | null;
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
 * Determinism note: this constructs a fresh `Y.Doc()` each call. Yjs
 * assigns a random `clientID`, so two calls with identical args
 * produce different binary outputs by default. We pin clientID to a
 * fixed sentinel (0x100000000n masked into the legal 32-bit range) so
 * inserts are reproducible — important for migration replay and for
 * the single-row UPSERT semantics in
 * {@link insertInitialState}.
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
    creatorName,
    creatorAvatarUrl,
    ts,
  } = args;

  const doc = new Y.Doc();
  // Stable clientID makes the encoded update deterministic across
  // calls with the same args. Picked outside the auto-assigned random
  // range so collisions with live editors are vanishingly unlikely
  // even before the first observe.
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

  // 2026-05-27 awareness rewrite — seed `meta.users[creator]` so
  // ProjectMessagesButton's actor lookup hits on the
  // `space-created` entry above even when a remote peer opens
  // the project before the creator first connects (their awareness
  // hasn't fired yet, so the runtime onAwarenessUpdate path
  // wouldn't have written this entry). `lastSeenAt = ts` treats
  // the creation moment as the most recent activity — the runtime
  // hook refreshes it on every subsequent awareness change.
  const users = doc.getMap("users");
  const creatorEntry = new Y.Map<unknown>();
  creatorEntry.set("id", createdBy);
  creatorEntry.set("name", creatorName);
  creatorEntry.set("avatarUrl", creatorAvatarUrl);
  creatorEntry.set("lastSeenAt", ts);
  users.set(createdBy, creatorEntry);

  // Seed `meta.perUser[creator]` with the first space opened +
  // active. The frontend `readMetaState` fallback used to derive
  // this from `spaces.map(s => s.id)` for first-time visitors,
  // but the fallback only fires when the userMap is missing
  // entirely — once any tab is opened the entry is created and
  // the fallback no longer applies. Seeding makes the behavior
  // explicit and consistent: creator joins, sees the first space
  // already in their tab bar + active.
  const perUser = doc.getMap("perUser");
  const creatorPerUser = new Y.Map<unknown>();
  const openTabIds = new Y.Array<string>();
  openTabIds.push([spaceId]);
  creatorPerUser.set("openTabIds", openTabIds);
  creatorPerUser.set("activeSpaceId", spaceId);
  perUser.set(createdBy, creatorPerUser);

  return Y.encodeStateAsUpdate(doc);
}

/**
 * Encode the initial state for a fresh Space's CONTENT doc (e.g.
 * `project-{pid}/canvas-{sid}`, `…/document-{sid}`, `…/timeline-{sid}`).
 *
 * A new Space starts EMPTY — a blank canvas / document / timeline — so
 * the initial content is an empty `Y.Doc`. Seeding it makes the
 * content-doc ROW exist the moment the Space becomes visible in `meta`
 * (the invariant `lazySeedMeta` + the `space:create` RPC uphold), while
 * each type's editor builds its own structure (canvas `nodes`/`edges`,
 * document XmlFragment, …) on first bind. The state is independent of
 * the Space TYPE — only the doc NAME carries the type (shared
 * `spaceContentDocName`), so one encoder serves every kind.
 *
 * `seedInitialState` converges concurrent first-seeds by doc NAME (`ON
 * CONFLICT DO NOTHING`), so the bytes need not be deterministic; an
 * empty doc is trivially identical across calls regardless.
 * @returns The encoded empty-content Yjs update, ready to persist as a
 *   Space content doc's initial state.
 */
export function encodeInitialSpaceContentState(): Uint8Array {
  return Y.encodeStateAsUpdate(new Y.Doc());
}

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
