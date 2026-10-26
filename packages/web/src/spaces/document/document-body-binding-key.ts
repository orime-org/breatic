// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state';

import type {
  BodyBindingPluginState,
  BodyTransactionSource,
  DocumentBodyBindingAccess,
} from '@web/spaces/document/document-body-binding-types';

/** One project-owned key is used by the binding and its current consumers. */
export const documentBodyBindingKey = new PluginKey<BodyBindingPluginState>('documentBodyBinding');

/** Explicit source metadata survives the complete accepted append loop. */
export const BODY_TRANSACTION_SOURCE = 'breatic.body.transactionSource';

/**
 * Reads this state's actual handle without constructing another one.
 * @param state - The consumer's exact current ProseMirror state.
 * @returns Its records binding, or null for independent parsing.
 * @throws {never}
 */
export function bodyBindingOf(state: EditorState): DocumentBodyBindingAccess | null {
  return documentBodyBindingKey.getState(state)?.owner ?? null;
}

/**
 * Classifies an accepted transaction using its own root's explicit source.
 * @param transaction - A root or appended transaction.
 * @returns Its complete batch source or current metadata default.
 * @throws {never}
 */
export function transactionSource(transaction: Transaction): BodyTransactionSource {
  const explicit: unknown = transaction.getMeta(BODY_TRANSACTION_SOURCE);
  if (explicit === 'user' || explicit === 'machine' || explicit === 'projection' || explicit === 'metadata') return explicit;
  const root: unknown = transaction.getMeta('appendedTransaction');
  if (root !== undefined && root !== null && typeof root === 'object' && 'getMeta' in root && typeof root.getMeta === 'function') {
    const source: unknown = root.getMeta(BODY_TRANSACTION_SOURCE);
    if (source === 'user' || source === 'machine' || source === 'projection' || source === 'metadata') return source;
  }
  return transaction.docChanged ? transaction.getMeta('addToHistory') === false ? 'machine' : 'user' : 'metadata';
}
