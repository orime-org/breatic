// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Range-selection highlight for reference-mention chips (I2, user 2026-07-12,
 * decision A). A chip is a `select-none` inline atom, so a text range selection
 * paints the surrounding text with the browser's native highlight but SKIPS the
 * chip — a selection covering a chip left it looking un-selected. This local
 * ProseMirror decoration (not synced to Yjs — it is view-only, per-client
 * selection state) adds a class to every chip fully inside the selection so it
 * reads as part of the selection like the text around it. Recomputed on every
 * state change from the current selection; the prompt is tiny so the walk is
 * cheap.
 */

import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

import { REFERENCE_MENTION_NODE } from '@web/spaces/canvas/generate/at-reference';

/** Class added to a chip caught inside a text range selection (see index.css). */
export const RANGE_SELECTED_CLASS = 'reference-mention--range-selected';

/**
 * Builds the node decorations that highlight reference-mention chips fully
 * inside a text selection range. A chip (an inline atom, `nodeSize` 1) is
 * highlighted only when the selection COVERS it entirely (`from <= pos` and
 * `pos + nodeSize <= to`) — a selection whose edge merely touches the chip
 * boundary does not select it, matching how the browser selects text. An empty
 * (collapsed) selection highlights nothing. Pure — the plugin wraps the result
 * in a DecorationSet.
 * @param doc - The prompt document.
 * @param selection - The current selection range.
 * @param selection.from - Range start (inclusive).
 * @param selection.to - Range end (exclusive).
 * @returns One node decoration per fully-covered chip.
 */
export function selectionChipDecorations(
  doc: PMNode,
  selection: { from: number; to: number },
): Decoration[] {
  const { from, to } = selection;
  if (from === to) return [];
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== REFERENCE_MENTION_NODE) return;
    if (from <= pos && pos + node.nodeSize <= to) {
      decorations.push(
        Decoration.node(pos, pos + node.nodeSize, {
          class: RANGE_SELECTED_CLASS,
        }),
      );
    }
  });
  return decorations;
}

/**
 * ProseMirror plugin that highlights reference-mention chips inside the current
 * text selection (I2). The decorations are derived from `state.selection` on
 * every render, so the highlight tracks the selection live and needs no plugin
 * state of its own. Local / view-only — never synced to collaborators.
 * @returns The range-highlight plugin.
 */
export function createReferenceMentionRangeHighlight(): Plugin {
  return new Plugin({
    props: {
      decorations(state): DecorationSet {
        return DecorationSet.create(
          state.doc,
          selectionChipDecorations(state.doc, state.selection),
        );
      },
    },
  });
}
