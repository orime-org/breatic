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
   * Q11 v2 — the creating user's userId (UUID). Stored as the
   * `actor` field of the seeded `space-created` projectMessages
   * entry; the frontend looks up `meta.users[actor].name` at render
   * time so a username rename retroactively propagates. Required
   * (not nullable) so a regression that drops the lookup trips the
   * TypeScript build.
   */
  actor: string;
  /**
   * Creator's display name (`users.username ?? users.email` from
   * the auth flow). Seeded into `meta.users[actor]` so other
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
    actor,
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
  const entry = new Y.Map<unknown>();
  entry.set("id", spaceId);
  entry.set("type", kind);
  entry.set("name", name);
  entry.set("order", 0);
  entry.set("locked", false);
  entry.set("createdAt", ts);
  entry.set("createdBy", createdBy);
  spaces.set(spaceId, entry);

  // Q11 v2.1 — bootstrap path seeds the first `projectMessages` entry
  // consistent with `collab/space-rpc.handleCreate`. Field convention:
  //   - `actor`     = userId (UUID) — frontend renders display name
  //                   via live lookup against `meta.users[actor].name`
  //                   so a username rename retroactively reflects.
  //   - `spaceName` = SNAPSHOT of name at event time. Rename is a
  //                   separate audit event (future `space-renamed`
  //                   kind), every prior entry stays frozen as
  //                   historical truth. Frontend renders verbatim,
  //                   does NOT look up the live Space name.
  //   - `id`        = full `pm-${ts}-${spaceId}` (no slice truncation)
  //                   — deterministic because every input is too.
  const projectMessages = doc.getArray("projectMessages");
  const msg = new Y.Map<unknown>();
  msg.set("id", `pm-${ts}-${spaceId}`);
  msg.set("kind", "space-created");
  msg.set("actor", actor);
  msg.set("spaceId", spaceId);
  msg.set("spaceName", name);
  msg.set("createdAt", ts);
  projectMessages.push([msg]);

  // 2026-05-27 awareness rewrite — seed `meta.users[creator]` so
  // ProjectMessagesButton's actor lookup hits on the
  // `space-created` entry above even when a share-link peer opens
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
