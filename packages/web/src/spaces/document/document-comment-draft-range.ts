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
 * Two ways it is carried across a change, because changes arrive two ways:
 *
 * - The reader's own edits ride `tr.mapping`, which is how ProseMirror carries
 *   a position across a change.
 * - Everything that comes in through Yjs — a peer's edit, an undo, a thread
 *   being settled — lands as ONE replacement of the whole body
 *   (`ySyncPluginKey` meta `isChangeOrigin`), and that mapping sends every
 *   position to the end. Those are resolved from Yjs relative positions taken
 *   when the draft opened, which is how the sync plugin restores the selection
 *   across the same transaction (`restoreRelativeSelection`) and how the link
 *   panel holds its link (`document-link-tracking.ts`).
 *
 * It is GONE once both ends meet: every character it covered has been
 * deleted. Posting into a gone range would put the reader's words in a thread
 * pointing at nothing, which is what A21 is about — the draft card keeps its
 * place in the panel and says so instead.
 *
 * ## Why plugin state
 *
 * The mapping has to be applied once per transaction, in order, and a plugin's
 * `apply` is the only place that sees every one of them. A range kept in React
 * state would be mapped whenever a render happened to notice, which is neither
 * once nor in order.
 *
 * ## What it draws
 *
 * The words the draft is aimed at wear the comment colours from the moment
 * the entry is pressed (user 2026-09-24): they belong to a comment that is not
 * saved yet, not to a selection. The deep colour of a comment being read goes
 * on top while the draft is the card being read — which is its placeholder id
 * standing in the selection plugin's `ids`, where every card's turn at being
 * read is kept (design §9.4.1).
 */

import { createExtension } from '@blocknote/core';
import type { Mapping } from '@tiptap/pm/transform';
import {
  Plugin,
  PluginKey,
  type EditorState,
  type Transaction,
} from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { ySyncPluginKey } from 'y-prosemirror';

import {
  READING_CLASS,
  selectedThreadsIn,
} from '@web/spaces/document/document-comment-selection';
import {
  resolveTrackedSpan,
  trackLink,
  type TrackedLink,
} from '@web/spaces/document/document-link-tracking';
import { watchPluginState } from '@web/spaces/document/document-plugin-watch';

/**
 * The draft's name wherever a comment is named by id: the panel's column and
 * the selection plugin's `ids`. There is no thread yet to lend it one.
 */
export const DRAFT_THREAD_ID = 'doc-comment-draft';

/** The comment wash over the words a draft is aimed at. */
const DRAFT_MARK_CLASS = 'doc-comment-draft-mark';

/** Where an unposted comment is going. */
export interface DraftRange {
  readonly from: number;
  readonly to: number;
}

/**
 * One opening of a draft: made when it opens and carried unchanged until it
 * closes, so it is also what names that draft — the words written in it are
 * kept against it (`document-comment-unsent.ts`).
 */
export interface DraftOpening {
  /** The range as Yjs names it, or null while the editor has no binding. */
  readonly tracked: TrackedLink | null;
}

/** The open draft: where it is now, and which opening it is. */
export interface DraftAim extends DraftRange {
  readonly opening: DraftOpening;
}

/**
 * The plugin's key, which is also the meta a caller opens and closes a draft
 * with: dispatching a range opens one, dispatching `null` closes it.
 */
export const DOCUMENT_COMMENT_DRAFT_RANGE = new PluginKey<DraftAim | null>(
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
 * Carries the open draft across one transaction.
 * @param tr - The transaction.
 * @param current - The draft before it.
 * @param before - The state it applies to, whose sync binding is the live one.
 * @returns The draft after it, the same object when nothing moved, or null
 *   once the text it covered is gone.
 */
function carryDraft(
  tr: Transaction,
  current: DraftAim,
  before: EditorState,
): DraftAim | null {
  if (!tr.docChanged) return current;
  const sync = tr.getMeta(ySyncPluginKey) as
    | { isChangeOrigin?: boolean }
    | undefined;
  const { tracked } = current.opening;
  // The binding has rebuilt its index to the new nodes before it dispatches
  // (`_typeChanged`), so the relative positions resolve against this change.
  const moved =
    sync?.isChangeOrigin === true && tracked !== null
      ? resolveTrackedSpan(before, tracked)
      : mapDraftRange(current, tr.mapping);
  // The SAME object back when nothing moved, not an equal one.
  // `useSyncExternalStore` requires the snapshot to be identical while the
  // store has not changed, and a fresh object per transaction would make
  // every keystroke anywhere in the body read as a change to this range.
  if (moved === null) return null;
  return moved.from === current.from && moved.to === current.to
    ? current
    : { from: moved.from, to: moved.to, opening: current.opening };
}

/**
 * The range the open draft is going to land on.
 * @param state - The editor state to read.
 * @returns That range and which opening it is, or null when no draft is open.
 */
export function draftRangeIn(state: EditorState): DraftAim | null {
  return DOCUMENT_COMMENT_DRAFT_RANGE.getState(state) ?? null;
}

/**
 * The paint over the words the open draft is aimed at.
 * @param state - The editor state.
 * @returns One inline decoration over the range, deep while the draft is the
 *   card being read; nothing while no draft is open.
 */
function paintDraft(state: EditorState): DecorationSet {
  const range = draftRangeIn(state);
  if (range === null) return DecorationSet.empty;
  const reading = selectedThreadsIn(state).includes(DRAFT_THREAD_ID);
  return DecorationSet.create(state.doc, [
    Decoration.inline(range.from, range.to, {
      class: reading ? `${DRAFT_MARK_CLASS} ${READING_CLASS}` : DRAFT_MARK_CLASS,
    }),
  ]);
}

/**
 * The broadcast for the open draft's range. A draft card watching the editor's
 * own events would never learn it should be on screen: opening a draft
 * dispatches nothing but the meta.
 */
const watch = watchPluginState(
  (state) => DOCUMENT_COMMENT_DRAFT_RANGE.getState(state) ?? null,
);

/** Hear about every change that could have moved the open draft's range. */
export const onDraftRangeChange: (listener: () => void) => () => void =
  watch.onChange;

/**
 * The extension that keeps an unposted comment's range on the text it was
 * aimed at.
 * @returns The extension, for the assembly to register.
 */
export const documentCommentDraftRange = createExtension(() => ({
  key: 'document-comment-draft-range',
  prosemirrorPlugins: [
    new Plugin<DraftAim | null>({
      key: DOCUMENT_COMMENT_DRAFT_RANGE,
      state: {
        /**
         * Starts with no draft open.
         * @returns Null.
         */
        init: (): DraftAim | null => null,

        /**
         * Opens, closes, or carries the range across this change.
         * @param tr - The transaction being applied.
         * @param current - The range before it.
         * @param before - The state the transaction applies to.
         * @returns The range after it.
         */
        apply: (tr, current, before): DraftAim | null => {
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
            return {
              from: asked.from,
              to: asked.to,
              opening: { tracked: trackLink(before, asked) },
            };
          }
          if (current === null) return null;
          // A selection change carries no steps and the range comes back
          // unchanged — which is what a reader clicking elsewhere before
          // typing their comment needs.
          return carryDraft(tr, current, before);
        },
      },

      props: {
        decorations: paintDraft,
      },

      view: watch.view,
    }),
  ],
}));
