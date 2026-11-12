// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The `VersionStorage` BlockNote's versioning controller reads, over our
 * snapshot routes (inner#1129 design §7.1, §7.4, §7.6).
 *
 * Saving does not go through the controller: the menu saves the live body
 * with the panel closed too, so it calls `documentsApi.save` itself.
 */

import type { VersionError, VersionResult, VersionSnapshot, VersionStorage } from '@blocknote/core/extensions';
import type { DocumentVersion } from '@breatic/shared';

import { documentsApi, type DocumentScope } from '@web/data/api/documents';
import { ApiException } from '@web/data/api/types';

type Json = Record<string, unknown>;

/** What the preview shows now; the adapter writes it on every show. */
export interface ShownVersion {
  /** The snapshot shown, or null for the current content. */
  readonly id: string | null;
  readonly content: Json;
}

/** Holds what the preview shows now, or null before the first show. */
export interface ShownRef {
  current: ShownVersion | null;
}

/** What a snapshot row carries for the panel beyond the controller's fields. */
export interface SnapshotMetadata {
  /** The saver's display name, when they have one. */
  readonly savedBy: string | null;
}

/**
 * A refusal as the controller's failure kinds.
 * @param err - What the request threw.
 * @returns The failure.
 * @throws {unknown} `err` itself when it is not a refusal: an unexpected bug rejects.
 */
function failure(err: unknown): { ok: false; error: VersionError } {
  if (!(err instanceof ApiException)) throw err;
  if (err.network) return { ok: false, error: { type: 'network' } };
  if (err.status === 404) return { ok: false, error: { type: 'not-found' } };
  if (err.status === 403) return { ok: false, error: { type: 'forbidden' } };
  if (err.status === 409) return { ok: false, error: { type: 'conflict' } };
  return { ok: false, error: { type: 'server', status: err.status } };
}

/**
 * A request's answer, or its refusal, as a result.
 * @param run - The request.
 * @returns The result.
 * @throws {unknown} What `run` throws when it is not a refusal.
 */
async function result<T>(run: () => Promise<T>): Promise<VersionResult<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (err) {
    return failure(err);
  }
}

/**
 * A server row as the controller lists it.
 * @param row - The row.
 * @returns The snapshot.
 */
function toSnapshot(row: DocumentVersion): VersionSnapshot {
  const metadata: SnapshotMetadata = { savedBy: row.createdBy.name };
  return { id: row.id, createdAt: Date.parse(row.createdAt), name: row.name ?? undefined, by: row.createdBy.id, metadata };
}

/**
 * The storage for one document.
 * @param options - The document and the restore's two hooks.
 * @param options.scope - The document.
 * @param options.shown - What the preview shows now.
 * @param options.apply - Writes a snapshot into the live body, or says the Space refused it (having told the user why); it throws when it cannot.
 * @param options.report - Reports a write that threw.
 * @returns The storage.
 */
export function createDocumentVersionStorage(options: {
  scope: DocumentScope;
  shown: ShownRef;
  apply: (content: Json) => 'written' | 'refused';
  report: (err: unknown) => void;
}): VersionStorage<Json> {
  const { scope } = options;
  return {
    list: (signal, cursor) => result(async () => {
      const page = await documentsApi.list(scope, cursor, signal);
      return { snapshots: page.versions.map(toSnapshot), ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
    }),
    getContent: (id, signal) => result(async () => (await documentsApi.get(scope, id, signal)).content),
    rename: (id, name) => result(() => documentsApi.rename(scope, id, name ?? null)),
    remove: (id) => result(() => documentsApi.remove(scope, id)),
    // Applies only what the user is looking at, so what they confirmed is what lands.
    restore: async (id) => {
      const shown = options.shown.current;
      if (shown?.id !== id) return { ok: false, error: { type: 'not-found' } };
      try {
        // Refused is a failure to the controller, which then keeps the panel's
        // session; success would close it.
        if (options.apply(shown.content) === 'refused') return { ok: false, error: { type: 'conflict' } };
        return { ok: true, value: undefined };
      } catch (err) {
        options.report(err);
        return { ok: false, error: { type: 'server', status: 0 } };
      }
    },
  };
}
