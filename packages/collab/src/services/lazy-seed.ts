// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Lazy-seed for a project's meta document.
 *
 * After the yjs two-DB cutover, project creation writes only the
 * business rows — it no longer eager-seeds the `project-{id}/meta` Yjs
 * doc (the yjs store is a separate database). Instead this seeds one
 * default canvas Space on the FIRST load of a meta doc that has no row
 * yet, preserving the "project exists ⇒ ≥1 Space" invariant the
 * frontend relies on, at read time rather than write time.
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
 * `meta.users` when they first connect. The default Space is named
 * generically ("Canvas") — the create path used to name it after the
 * project, which collab can't see here without a business read.
 */

import { encodeInitialMetaState } from "@breatic/core";
import { deriveId, parseDocName } from "@breatic/shared";
import * as yjsDocumentsRepo from "@collab/services/yjs-documents.repo.js";

/** Generic name for the lazily-seeded first canvas Space. */
const DEFAULT_SPACE_NAME = "Canvas";
/** Placeholder creator/actor — backfilled to the real user via awareness. */
const SYSTEM_ACTOR = "system";

/**
 * If `documentName` is a meta doc with no row yet, seed one default
 * canvas Space and return its bytes; otherwise return null (the caller's
 * fetch result stands).
 * @param documentName - Full Yjs doc name being loaded
 * @returns The seeded meta bytes, or null when no seed applies
 */
export async function lazySeedMeta(
  documentName: string,
): Promise<Uint8Array | null> {
  const parsed = parseDocName(documentName);
  if (!parsed || parsed.kind !== "meta") return null;

  // Deterministic Space id (shared `deriveId`) so concurrent first-loads
  // across collab instances converge to one Space (see header).
  const spaceId = deriveId(parsed.projectId);
  const bytes = encodeInitialMetaState({
    spaceId,
    kind: "canvas",
    name: DEFAULT_SPACE_NAME,
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
