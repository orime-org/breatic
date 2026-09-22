// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Where an unposted comment is going to land (#18, A21, design §9.4).
 *
 * Between pressing the entry and posting, that range carries no mark — the
 * mark is what posting writes — so nothing in the body moves it while the
 * body keeps being edited underneath: the reader typing elsewhere, a peer
 * inserting a paragraph above, somebody pressing undo.
 *
 * It rides `tr.mapping`, which is how ProseMirror carries a position across a
 * change, and it is GONE once both ends map to the same point: every
 * character it covered has been deleted. Posting into a gone range would put
 * the reader's words in a thread pointing at nothing, which is what A21 is
 * about — the box closes and says so instead.
 *
 * ## Why plugin state
 *
 * The mapping has to be applied once per transaction, in order, and a plugin's
 * `apply` is the only place that sees every one of them. A range kept in React
 * state would be mapped whenever a render happened to notice, which is neither
 * once nor in order.
 *
 * Nothing renders from this: the composer's own position comes from the range
 * too, but through a read at render time, and the highlight a reader sees
 * while typing is the browser's own selection.
 */

import { createExtension } from '@blocknote/core';
import type { Mapping } from '@tiptap/pm/transform';
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state';

/** Where an unposted comment is going. */
export interface DraftRange {
  readonly from: number;
  readonly to: number;
}

/**
 * The plugin's key, which is also the meta a caller opens and closes a draft
 * with: dispatching a range opens one, dispatching `null` closes it.
 */
export const DOCUMENT_COMMENT_DRAFT_RANGE = new PluginKey<DraftRange | null>(
  'documentCommentDraftRange',
);

/**
 * Carries a draft's range across one change.
 * @param range - Where the draft was going before this change.
 * @param mapping - The change, as ProseMirror maps positions across it.
 * @returns Where it is going now, or null once the text it covered is gone.
 */
export function mapDraftRange(
  range: DraftRange,
  mapping: Mapping,
): DraftRange | null {
  const from = mapping.map(range.from, 1);
  const to = mapping.map(range.to, -1);
  // Equal ends mean every character between them was deleted. The bias pair
  // is what makes that test true only for a real deletion: mapping `from`
  // forward and `to` back keeps an insertion at either edge outside the
  // range, so text typed against its boundary does not widen it.
  return to <= from ? null : { from, to };
}

/**
 * The range the open draft is going to land on.
 * @param state - The editor state to read.
 * @returns That range, or null when no draft is open.
 */
export function draftRangeIn(state: EditorState): DraftRange | null {
  return DOCUMENT_COMMENT_DRAFT_RANGE.getState(state) ?? null;
}

/**
 * The extension that keeps an unposted comment's range on the text it was
 * aimed at.
 * @returns The extension, for the assembly to register.
 */
export const documentCommentDraftRange = createExtension(() => ({
  key: 'document-comment-draft-range',
  prosemirrorPlugins: [
    new Plugin<DraftRange | null>({
      key: DOCUMENT_COMMENT_DRAFT_RANGE,
      state: {
        /**
         * Starts with no draft open.
         * @returns Null.
         */
        init: (): DraftRange | null => null,

        /**
         * Opens, closes, or carries the range across this change.
         * @param tr - The transaction being applied.
         * @param current - The range before it.
         * @returns The range after it.
         */
        apply: (tr, current): DraftRange | null => {
          const asked = tr.getMeta(DOCUMENT_COMMENT_DRAFT_RANGE) as
            | DraftRange
            | null
            | undefined;
          if (asked !== undefined) {
            // A range covering nothing is refused here rather than left for
            // the post to notice: the entries are unavailable over text-less
            // ranges already (`canCommentOver`), so one arriving means a
            // caller is wrong, and holding it would let a comment be written
            // with no words under it.
            if (asked === null || asked.to <= asked.from) return null;
            return asked;
          }
          if (current === null) return null;
          // A selection change carries no steps, so the mapping is empty and
          // the range comes back unchanged — which is what a reader clicking
          // elsewhere before typing their comment needs.
          return mapDraftRange(current, tr.mapping);
        },
      },
    }),
  ],
}));
