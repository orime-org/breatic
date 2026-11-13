// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import type { DocumentVersion } from '@breatic/shared';

import { apiDelete, apiGet, apiPatch, apiPost } from '@web/data/api/request';
import { bodyOrTransfer } from '@web/data/upload/transfer-body';

/** Which document a snapshot request is for. */
export interface DocumentScope {
  projectId: string;
  spaceId: string;
}

/**
 * The query naming a document.
 * @param scope - The document.
 * @returns The query parameters.
 */
function scopeParams(scope: DocumentScope): { project_id: string; space_id: string } {
  return { project_id: scope.projectId, space_id: scope.spaceId };
}

/** Document snapshots (inner#1129). */
export const documentsApi = {
  /**
   * Keep a snapshot of a document's body.
   * @param scope - The document.
   * @param input - The snapshot.
   * @param input.name - Its name, or undefined for none.
   * @param input.content - The body's ProseMirror JSON.
   * @param input.schemaVersion - The document schema it is written in.
   * @returns The new snapshot.
   * @throws {import('@web/data/api/types').ApiException} On a refused request; `reason` is `document_versions_full` at the ceiling.
   * @throws {Error} When a body over the request limit could not be moved through storage.
   */
  async save(
    scope: DocumentScope,
    input: { name: string | undefined; content: Record<string, unknown>; schemaVersion: string },
  ): Promise<DocumentVersion> {
    const body = { ...scopeParams(scope), name: input.name, content: input.content, schema_version: input.schemaVersion };
    const { version } = await apiPost<{ version: DocumentVersion }>('/documents/versions', await bodyOrTransfer(scope.projectId, body));
    return version;
  },

  /**
   * One page of a document's snapshots, newest first.
   * @param scope - The document.
   * @param cursor - Where the previous page ended.
   * @param signal - Stops the request.
   * @returns The page and where the next one starts.
   * @throws {import('@web/data/api/types').ApiException} On a refused request.
   */
  list(scope: DocumentScope, cursor?: string, signal?: AbortSignal): Promise<{ versions: DocumentVersion[]; nextCursor: string | null }> {
    return apiGet('/documents/versions', { params: { ...scopeParams(scope), ...(cursor ? { cursor } : {}) }, signal });
  },

  /**
   * One snapshot's body.
   * @param scope - The document.
   * @param id - The snapshot.
   * @param signal - Stops the request.
   * @returns It and its body.
   * @throws {import('@web/data/api/types').ApiException} On a refused request; 404 once it is gone.
   */
  get(scope: DocumentScope, id: string, signal?: AbortSignal): Promise<{ version: DocumentVersion; content: Record<string, unknown> }> {
    return apiGet(`/documents/versions/${id}`, { params: scopeParams(scope), signal });
  },

  /**
   * Rename a snapshot.
   * @param scope - The document.
   * @param id - The snapshot.
   * @param name - The new name, or null to clear it.
   * @throws {import('@web/data/api/types').ApiException} On a refused request; 404 once it is gone.
   */
  async rename(scope: DocumentScope, id: string, name: string | null): Promise<void> {
    await apiPatch(`/documents/versions/${id}`, { ...scopeParams(scope), name });
  },

  /**
   * Delete a snapshot.
   * @param scope - The document.
   * @param id - The snapshot.
   * @throws {import('@web/data/api/types').ApiException} On a refused request; 404 once it is gone.
   */
  async remove(scope: DocumentScope, id: string): Promise<void> {
    await apiDelete(`/documents/versions/${id}`, { params: scopeParams(scope) });
  },
};
