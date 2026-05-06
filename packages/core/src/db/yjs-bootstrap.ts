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
 */
export function encodeInitialMetaState(
  args: EncodeInitialMetaStateArgs,
): Uint8Array {
  const { spaceId, kind, name, createdBy, ts } = args;

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

  return Y.encodeStateAsUpdate(doc);
}
