// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Reading a formula's source in tests (inner#1423): a formula is a leaf that
 * holds its LaTeX in a `source` prop, as BlockNote hands a block or an inline
 * piece over and as the ProseMirror node carries it.
 */

import type { Node as PMNode } from '@tiptap/pm/model';

/**
 * A formula's source as BlockNote hands it over.
 * @param formula - A `mathBlock` block or a `math` inline piece.
 * @returns The source.
 */
export function sourceOf(formula: unknown): string {
  return String((formula as { props?: { source?: unknown } }).props?.source ?? '');
}

/**
 * A formula node's source.
 * @param node - A `mathBlock` or `math` node.
 * @returns The source.
 */
export function nodeSource(node: PMNode): string {
  return String(node.attrs['source'] ?? '');
}
