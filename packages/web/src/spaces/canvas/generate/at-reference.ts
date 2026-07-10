// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * `@`-reference model — the second layer on top of the connection reference
 * pool. A connection (incoming edge) makes an image AVAILABLE (the pool); an
 * `@`-mention in the prompt PICKS which of those images this generation
 * actually uses (design 2026-07-10 §2.1). Only `@`-picked sources feed the i2i
 * execute payload — no `@` = no source image (design B).
 *
 * This module holds the mention node identity + the pure extraction of picked
 * source ids from the prompt document; the TipTap extension + UI live in the
 * editor/component layer.
 */

import type { JSONContent } from '@tiptap/core';

/** ProseMirror / TipTap node name for an `@`-picked reference-image mention. */
export const REFERENCE_MENTION_NODE = 'referenceMention';

/** Attr key on a reference-mention node carrying its source image node id. */
export const MENTION_SOURCE_ID_ATTR = 'sourceNodeId';

/**
 * Extracts the source node ids of all `@`-mentioned reference images in a
 * prompt document, in first-appearance order and de-duplicated. Walks the
 * TipTap JSON tree for reference-mention nodes; the returned ids drive the i2i
 * execute payload (only `@`-picked sources are sent — design B). A mention
 * whose `sourceNodeId` is missing or not a non-empty string is skipped
 * (collaborative Yjs content is untrusted).
 * @param doc - The prompt editor content as TipTap JSON (`editor.getJSON()`).
 * @returns The `@`-mentioned source node ids, de-duplicated, in document order.
 * @throws Never.
 */
export function extractAtMentionedSourceIds(
  doc: JSONContent | undefined,
): string[] {
  const ordered: string[] = [];
  const seen = new Set<string>();
  const visit = (node: JSONContent | undefined): void => {
    if (!node) return;
    if (node.type === REFERENCE_MENTION_NODE) {
      const id = node.attrs?.[MENTION_SOURCE_ID_ATTR];
      if (typeof id === 'string' && id.length > 0 && !seen.has(id)) {
        seen.add(id);
        ordered.push(id);
      }
    }
    node.content?.forEach(visit);
  };
  visit(doc);
  return ordered;
}

/** A reference-mention occurrence located in the prompt document. */
export interface MentionOccurrence {
  /** The source image node id the mention points at. */
  sourceNodeId: string;
  /** ProseMirror start position of the mention node (inclusive). */
  from: number;
  /** ProseMirror end position of the mention node (exclusive). */
  to: number;
}

/**
 * Plans which `@`-mention chips to delete when their referenced source has left
 * the connection pool (its edge was removed). A mention is stale when its
 * `sourceNodeId` is no longer in `poolSourceIds`; the returned ranges are sorted
 * DESCENDING by `from` so a caller can delete them sequentially without earlier
 * deletions shifting the positions of later ones. Pure — the caller collects the
 * occurrences from the editor and applies the deletions in one transaction.
 * @param mentions - The mention occurrences currently in the prompt document.
 * @param poolSourceIds - Source node ids still connected (the live reference pool).
 * @returns Ranges of stale mentions to delete, highest position first.
 * @throws Never.
 */
export function planMentionDeletions(
  mentions: readonly MentionOccurrence[],
  poolSourceIds: ReadonlySet<string>,
): Array<{ from: number; to: number }> {
  return mentions
    .filter((m) => !poolSourceIds.has(m.sourceNodeId))
    .map((m) => ({ from: m.from, to: m.to }))
    .sort((a, b) => b.from - a.from);
}
