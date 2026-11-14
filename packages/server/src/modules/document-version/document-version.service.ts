// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { db, NotFoundError } from "@breatic/core";
import { t, type DocumentVersion } from "@breatic/shared";
import { getDocumentVersionLimits } from "@server/config/limits.js";
import * as repo from "@server/modules/document-version/document-version.repo.js";
import type { VersionKey } from "@server/modules/document-version/document-version.repo.js";

/** A save the document's ceiling turned away. */
export interface SaveRefused {
  ok: false;
  reason: "document_versions_full";
  limit: number;
}

/**
 * Keep a snapshot of a document's body, within the per-document ceiling.
 * @param input - What to keep and where.
 * @param input.projectId - The project.
 * @param input.spaceId - The document Space.
 * @param input.userId - Who saves it.
 * @param input.name - Its name, if any.
 * @param input.content - The body's ProseMirror JSON.
 * @param input.schemaVersion - The document schema it was written in.
 * @returns The new snapshot, or the refusal when the document is full.
 */
export async function saveVersion(input: {
  projectId: string;
  spaceId: string;
  userId: string;
  name: string | undefined;
  content: Record<string, unknown>;
  schemaVersion: string;
}): Promise<{ ok: true; version: DocumentVersion } | SaveRefused> {
  const { maxPerSpace } = getDocumentVersionLimits();
  return db.transaction(async (tx) => {
    await repo.lockSpace(input.projectId, input.spaceId, tx);
    if ((await repo.countLive(input.projectId, input.spaceId, tx)) >= maxPerSpace) {
      return { ok: false, reason: "document_versions_full", limit: maxPerSpace } satisfies SaveRefused;
    }
    const version = await repo.insert(
      {
        projectId: input.projectId,
        spaceId: input.spaceId,
        userId: input.userId,
        name: input.name ?? null,
        content: input.content,
        schemaVersion: input.schemaVersion,
        contentBytes: Buffer.byteLength(JSON.stringify(input.content)),
      },
      tx,
    );
    return { ok: true, version };
  });
}

/**
 * One page of a document's snapshots, newest first.
 * @param projectId - The project.
 * @param spaceId - The document Space.
 * @param cursor - Where the previous page ended.
 * @returns The page and the next cursor.
 */
export async function listVersions(
  projectId: string,
  spaceId: string,
  cursor: string | undefined,
): Promise<{ versions: DocumentVersion[]; nextCursor: string | null }> {
  return repo.listPage(projectId, spaceId, cursor, getDocumentVersionLimits().pageSize);
}

/**
 * One snapshot with its body.
 * @param key - The snapshot and its document.
 * @returns It and its body.
 * @throws {NotFoundError} When it is not a live snapshot of that document.
 */
export async function getVersion(key: VersionKey): Promise<{ version: DocumentVersion; content: Record<string, unknown> }> {
  const found = await repo.findWithContent(key);
  if (!found) throw new NotFoundError(t("server.error.not_found"));
  return found;
}

/**
 * Rename a snapshot.
 * @param key - The snapshot and its document.
 * @param name - The new name, or null to clear it.
 * @throws {NotFoundError} When it is not a live snapshot of that document.
 */
export async function renameVersion(key: VersionKey, name: string | null): Promise<void> {
  if (!(await repo.rename(key, name))) throw new NotFoundError(t("server.error.not_found"));
}

/**
 * Delete a snapshot; the row stays, marked deleted.
 * @param key - The snapshot and its document.
 * @param userId - Who deletes it.
 * @throws {NotFoundError} When it is not a live snapshot of that document.
 */
export async function deleteVersion(key: VersionKey, userId: string): Promise<void> {
  if (!(await repo.softDelete(key, userId))) throw new NotFoundError(t("server.error.not_found"));
}
