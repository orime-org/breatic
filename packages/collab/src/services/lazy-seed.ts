// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Lazy-seed for a project's meta document.
 *
 * After the yjs two-DB cutover, project creation writes only the
 * business rows — it no longer eager-seeds any Yjs doc (the yjs store is
 * a separate database). Instead, on the FIRST load of a meta doc that
 * has no row yet, this seeds — together — the first Space's CONTENT doc
 * AND the meta doc, using the `initial_space_type` chosen at create time
 * (read from the project row). The content doc is seeded FIRST so a
 * Space never becomes visible in meta before its content doc exists (the
 * same invariant `duplicateByProjectPrefix` upholds). This preserves
 * "project exists ⇒ meta + its first Space content doc exist" at read
 * time rather than write time.
 *
 * Convergence: the default Space id is a deterministic id derived from
 * the project id (shared `deriveId`), so two collab instances that both
 * load a fresh meta doc before either persists encode the SAME Space key
 * — the Yjs CRDT merge of their in-memory docs converges to ONE Space
 * rather than two. The DB insert is `ON CONFLICT DO NOTHING`, and the
 * loser of the race re-reads the winner's bytes.
 *
 * Fidelity (accepted degradation, per design): collab has no user repo,
 * so the seeded Space is attributed to a `system` placeholder; the
 * awareness hook backfills the real creator's name/avatar into
 * `meta.users` when they first connect. The Space is named by its type
 * (`defaultSpaceName` — "Canvas" / "Document" / "Timeline"); the user
 * renames it afterwards.
 */

import {
  defaultSpaceName,
  encodeInitialMetaState,
  encodeInitialSpaceContentState,
  loadInitialSpaceType,
} from "@breatic/core";
import { deriveId, parseDocName, spaceContentDocName } from "@breatic/shared";
import * as yjsDocumentsRepo from "@collab/services/yjs-documents.repo.js";

/** Placeholder creator/actor — backfilled to the real user via awareness. */
const SYSTEM_ACTOR = "system";

/**
 * If `documentName` is a meta doc with no row yet, seed the project's
 * first Space — its content doc AND the meta doc, using the Space type
 * chosen at create time — and return the meta bytes; otherwise return
 * null (the caller's fetch result stands).
 * @param documentName - Full Yjs doc name being loaded
 * @returns The seeded meta bytes, or null when no seed applies
 */
export async function lazySeedMeta(
  documentName: string,
): Promise<Uint8Array | null> {
  const parsed = parseDocName(documentName);
  if (!parsed || parsed.kind !== "meta") return null;

  const { projectId } = parsed;
  // The Space type chosen at create time (stored on the project row);
  // defaults to canvas for a missing/legacy row.
  const kind = await loadInitialSpaceType(projectId);
  // Deterministic Space id (shared `deriveId`) so concurrent first-loads
  // across collab instances converge to one Space (see header).
  const spaceId = deriveId(projectId);

  // Content doc FIRST, then meta — a Space must never be visible in meta
  // before its content doc exists. Both are `ON CONFLICT DO NOTHING` +
  // deterministically named, so concurrent first-loads converge.
  await yjsDocumentsRepo.seedInitialState(
    spaceContentDocName(projectId, spaceId, kind),
    encodeInitialSpaceContentState(),
  );

  const bytes = encodeInitialMetaState({
    spaceId,
    kind,
    name: defaultSpaceName(kind),
    createdBy: SYSTEM_ACTOR,
    actor: SYSTEM_ACTOR,
    creatorName: SYSTEM_ACTOR,
    creatorAvatarUrl: null,
    ts: Date.now(),
  });

  const inserted = await yjsDocumentsRepo.seedInitialState(documentName, bytes);
  if (inserted) return bytes;
  // Lost the insert race (another connection/instance seeded first):
  // return the persisted winner so every loader converges on one doc.
  return (await yjsDocumentsRepo.fetchDocData(documentName)) ?? bytes;
}
