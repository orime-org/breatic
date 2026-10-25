// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { ProjectMediaBackfillCandidate, ProjectMediaBackfillSource } from "@breatic/core";
import { parseDocName } from "@breatic/shared";
import { readSpaceMediaReferences } from "@breatic/shared/space-content";
import * as Y from "yjs";
import { z } from "zod";
import { scanMediaBackfillDocuments, type MediaBackfillDocument } from "@collab/services/yjs-documents.repo.js";

const uuid = z.uuid();

/**
 * Expose live Space snapshots through the existing semantic media reader.
 * @returns A bounded source that preserves the stored document bytes.
 * @throws {Error} When the Yjs source scan fails.
 */
export function createSpaceProjectMediaBackfillSource(): ProjectMediaBackfillSource {
  return { name: "space_documents", readPage: readSpacePage };
}

/**
 * Read bounded snapshots through the existing Yjs repository owner.
 * @param cursor - The last emitted immutable document name.
 * @param limit - The configured batch bound.
 * @returns Media candidates retaining each original document identity.
 * @throws {Error} When reading the persisted snapshots fails.
 */
async function readSpacePage(cursor: string | null, limit: number): Promise<ProjectMediaBackfillCandidate[]> {
  const rows = await scanMediaBackfillDocuments(cursor, limit);
  return rows.map(readSnapshot);
}

/**
 * Decode one temporary snapshot using the runtime's semantic media reader.
 * @param row - The actual stored document name and bytes.
 * @returns Explicit media or a classified document failure, preserving bytes.
 * @throws {never} Never.
 */
function readSnapshot(row: MediaBackfillDocument): ProjectMediaBackfillCandidate {
  const parsed = parseDocName(row.name);
  const identity = { id: row.name, cursor: row.name, projectId: parsed?.projectId ?? null };
  if (parsed === null || parsed.kind === "meta" || !uuid.safeParse(parsed.projectId).success || !uuid.safeParse(parsed.spaceId).success) return { ...identity, reason: "invalid_document" };
  const snapshot = new Y.Doc();
  try {
    Y.applyUpdate(snapshot, row.data);
    return { ...identity, ...readSpaceMediaReferences(parsed.kind, snapshot) };
  } catch {
    return { ...identity, reason: "invalid_document" };
  } finally {
    snapshot.destroy();
  }
}
