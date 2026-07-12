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
 */
export function extractAtMentionedSourceIds(
  doc: JSONContent | undefined,
): string[] {
  const ordered: string[] = [];
  const seen = new Set<string>();
  /**
   * Recursively collects mention source ids into `ordered` (de-duped via `seen`).
   * @param node - The current TipTap JSON node (undefined at a leaf).
   */
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

/** A reference-mention chip's current display attrs located in the prompt doc. */
export interface ChipDisplaySnapshot {
  /** ProseMirror position of the chip node. */
  pos: number;
  /** The source node id the chip points at. */
  sourceNodeId: string;
  /** The chip's current `label` attr (frozen display name; null when none). */
  label: string | null;
  /** The chip's current `thumbnail` attr (frozen URL; null when none). */
  thumbnail: string | null;
}

/** A planned display-attr update for one chip — only CHANGED fields are present. */
export interface ChipDisplayUpdate {
  /** ProseMirror position of the chip node. */
  pos: number;
  /** New label, present only when it differs from the chip's current value. */
  label?: string | null;
  /** New thumbnail, present only when it differs from the chip's current value. */
  thumbnail?: string | null;
}

/** The live pool fields a chip projects (structural — avoids a derive-references dep). */
interface ChipProjectionSource {
  /** The upstream node id. */
  sourceNodeId: string;
  /** The upstream node's live display name. */
  sourceNodeName: string;
  /** The upstream node's live thumbnail, when it has a visual payload. */
  thumbnail?: string;
}

/**
 * Plans the display-attr writes that keep each reference-mention chip a live
 * projection of its source node's pool row (design 2026-07-12 invariant). For
 * every chip still backed by a pool row, it diffs the chip's frozen `label` /
 * `thumbnail` attrs against the source's LIVE name / thumbnail and reports only
 * the fields that changed. MODALITY-AGNOSTIC: a text source carries no
 * thumbnail (null on both sides → no thumbnail write) but its name syncs like
 * any other, so a rename tracks for text / audio / video, not just images. A
 * chip whose source left the pool is skipped — the cascade-clear pass removes
 * it (a chip must be in the reference pool). Pure — the caller reads the chips
 * from the editor and applies the updates in one history-excluded transaction.
 * @param chips - The reference-mention chips currently in the prompt document.
 * @param pool - The live reference pool (source of current name / thumbnail).
 * @returns Per-chip updates carrying only the changed display fields.
 */
export function planChipDisplayUpdates(
  chips: readonly ChipDisplaySnapshot[],
  pool: ReadonlyArray<ChipProjectionSource>,
): ChipDisplayUpdate[] {
  const byId = new Map(pool.map((r) => [r.sourceNodeId, r]));
  const updates: ChipDisplayUpdate[] = [];
  for (const chip of chips) {
    const row = byId.get(chip.sourceNodeId);
    if (!row) continue; // source left the pool → cascade-clear removes the chip
    const liveLabel = row.sourceNodeName || null;
    const liveThumbnail = row.thumbnail ?? null;
    const update: ChipDisplayUpdate = { pos: chip.pos };
    let changed = false;
    if (liveLabel !== chip.label) {
      update.label = liveLabel;
      changed = true;
    }
    if (liveThumbnail !== chip.thumbnail) {
      update.thumbnail = liveThumbnail;
      changed = true;
    }
    if (changed) updates.push(update);
  }
  return updates;
}
