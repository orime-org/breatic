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
 * The range lives only in this editor: it is never written to the shared
 * document, and closing the page ends it. That is how the editors with a
 * pending comment keep one (CKEditor 5's draft marker "is not managed using
 * operations"; BlockNote and Liveblocks use the reader's selection).
 *
 * How it is carried across a change — the reader's own edits, edits that come
 * in through Yjs, undo — is the local range's (`document-local-range.ts`),
 * which the AI dialog's original range shares (inner#1860). A draft over
 * several selected table cells is one stretch per cell (inner#1126 A9): the
 * cells need not be next to each other in the document, so one range from the
 * first to the last would take in cells nobody selected.
 *
 * A draft is GONE with the last of its stretches. Posting then would put the
 * reader's words in a thread pointing at nothing, which is what A21 is about —
 * the draft card keeps its place in the panel and says so instead, keeping
 * what the reader wrote.
 *
 * ## One draft, one place
 *
 * Everything about the open draft that is not the reader's words lives here:
 * where it is aimed, which opening it is, and — once it can no longer be
 * written — why (A21, A22). The editor outlives the panel, which a Space tab
 * switch mounts again, so a draft whose words went while its card was not on
 * screen still says so when the card comes back (design §9.4.1). The words
 * themselves are kept against the opening in `document-comment-unsent.ts`.
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
 * read is kept (design §9.4.1) — and while the pointer rests on its card, the
 * way it does for a thread's card (A24).
 */

import { createExtension } from '@blocknote/core';
import {
  Plugin,
  PluginKey,
  type EditorState,
} from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

import {
  READING_CLASS,
  hoveredThreadIn,
  selectedThreadsIn,
} from '@web/spaces/document/document-comment-selection';
import { watchPluginState } from '@web/spaces/document/document-plugin-watch';
import {
  aimAt,
  changesText,
  localRangeTracker,
  localRangeView,
  type LocalRange,
} from '@web/spaces/document/document-local-range';

export { mapLocalRange as mapDraftRange } from '@web/spaces/document/document-local-range';

/**
 * The draft's name wherever a comment is named by id: the panel's column and
 * the selection plugin's `ids`. There is no thread yet to lend it one.
 */
export const DRAFT_THREAD_ID = 'doc-comment-draft';

/** The comment wash over the words a draft is aimed at. */
const DRAFT_MARK_CLASS = 'doc-comment-draft-mark';

/**
 * One stretch an unposted comment is going to land on. A draft has one per
 * selected table cell, and one where the words are a single stretch.
 */
export type DraftRange = LocalRange;

/**
 * One opening of a draft: made when it opens and carried unchanged until it
 * closes, so it is what names that draft — the words written in it are kept
 * against it (`document-comment-unsent.ts`).
 */
export interface DraftOpening {
  /** Counts openings in this page, for reading a draft in a debugger. */
  readonly serial: number;
}

/** How many drafts have opened in this page. */
let openings = 0;

/** How many times a comment entry has been pressed in this page. */
let entries = 0;

/** The open draft: where it is now, and which opening it is. */
export interface DraftAim {
  /** The stretches it is aimed at, in document order; never empty. */
  readonly segments: readonly DraftRange[];
  /**
   * The stretches as carried, null where one's words are gone: a stretch
   * keeps its place, so the names an undo hands back fit the stretch they
   * were taken for.
   */
  readonly slots: readonly (DraftRange | null)[];
  readonly opening: DraftOpening;
  /**
   * Counts the presses on a comment entry in this page; a new one is the
   * reader asking to write again, which the card answers by taking the focus.
   */
  readonly entry: number;
}

/** Why a draft can no longer be written (A21, A22). */
export type DraftDropReason = 'targetGone' | 'cannotWrite';

/**
 * The draft as the panel shows it: aimed at words, or dropped and saying why
 * until the reader dismisses the notice.
 */
export type Draft =
  | ({ readonly kind: 'aimed' } & DraftAim)
  | {
    readonly kind: 'dropped';
    readonly why: DraftDropReason;
    readonly opening: DraftOpening;
  };

/**
 * What a caller dispatches under the plugin's key: stretches open a draft, or
 * move the open one there — aimed or dropped — keeping its opening and so
 * its words; `null` closes it; `{ drop }` drops it for a reason the plugin
 * cannot see for itself.
 */
export type DraftCommand = readonly DraftRange[] | null | { readonly drop: 'cannotWrite' };

/** The plugin's key, which is also the meta a {@link DraftCommand} goes under. */
export const DOCUMENT_COMMENT_DRAFT_RANGE = new PluginKey<Draft | null>(
  'documentCommentDraftRange',
);

/**
 * The open draft, aimed or dropped.
 * @param state - The editor state to read.
 * @returns The draft, or null when there is none.
 */
export function draftIn(state: EditorState): Draft | null {
  return DOCUMENT_COMMENT_DRAFT_RANGE.getState(state) ?? null;
}

/**
 * The range the open draft is going to land on.
 * @param state - The editor state to read.
 * @returns That range and which opening it is, or null when no draft is
 *   aimed anywhere.
 */
export function draftRangeIn(state: EditorState): DraftAim | null {
  const draft = draftIn(state);
  return draft?.kind === 'aimed' ? draft : null;
}

/**
 * The paint over the words the open draft is aimed at.
 * @param state - The editor state.
 * @returns One inline decoration over each stretch, deep while the draft is the
 *   card being read or its card is under the pointer; nothing while no draft
 *   is open.
 */
function paintDraft(state: EditorState): DecorationSet {
  const range = draftRangeIn(state);
  if (range === null) return DecorationSet.empty;
  const reading =
    selectedThreadsIn(state).includes(DRAFT_THREAD_ID) ||
    hoveredThreadIn(state) === DRAFT_THREAD_ID;
  return DecorationSet.create(
    state.doc,
    range.segments.map(({ from, to }) =>
      Decoration.inline(from, to, {
        class: reading ? `${DRAFT_MARK_CLASS} ${READING_CLASS}` : DRAFT_MARK_CLASS,
      }),
    ),
  );
}

/**
 * The broadcast for the open draft. A draft card watching the editor's own
 * events would never learn it should be on screen: opening a draft dispatches
 * nothing but the meta.
 */
const watch = watchPluginState(draftIn);

/** Hear about every change to the open draft. */
export const onDraftChange: (listener: () => void) => () => void =
  watch.onChange;

/**
 * The extension that keeps an unposted comment's range on the text it was
 * aimed at.
 * @returns The extension, for the assembly to register.
 */
export const documentCommentDraftRange = createExtension(() => {
  const tracker = localRangeTracker(draftRangeIn);
  return {
    key: 'document-comment-draft-range',
    prosemirrorPlugins: [
      new Plugin<Draft | null>({
        key: DOCUMENT_COMMENT_DRAFT_RANGE,
        state: {
          /**
           * Starts with no draft open.
           * @returns Null.
           */
          init: (): Draft | null => null,

          /**
           * Opens, closes, drops, or carries the draft across this change.
           * @param tr - The transaction being applied.
           * @param current - The draft before it.
           * @param before - The state the transaction applies to.
           * @returns The draft after it.
           */
          apply: (tr, current, before): Draft | null => {
            const asked = tr.getMeta(DOCUMENT_COMMENT_DRAFT_RANGE) as
              | DraftCommand
              | undefined;
            if (asked !== undefined && asked !== null && 'drop' in asked) {
              return current?.kind === 'aimed'
                ? { kind: 'dropped', why: asked.drop, opening: current.opening }
                : current;
            }
            if (asked !== undefined) {
              if (asked === null) return null;
              // A range covering no letters is refused here rather than left
              // for the post to notice: the entries are unavailable over such
              // ranges already (`canCommentOver`), so one arriving means a
              // caller is wrong, and holding it would let a comment be written
              // with no words under it.
              const segments = aimAt(tr.doc, asked as readonly DraftRange[]);
              if (segments.length === 0) return current;
              // An open draft is moved, not replaced: it ends only on cancel
              // or save, and its words are kept against its opening.
              let opening = current?.opening;
              if (opening === undefined) {
                openings += 1;
                opening = { serial: openings };
              }
              entries += 1;
              return { kind: 'aimed', segments, slots: segments, opening, entry: entries };
            }
            // A selection change carries no steps and the range comes back
            // unchanged — which is what a reader clicking elsewhere before
            // typing their comment needs.
            if (current?.kind !== 'aimed' || !changesText(tr)) return current;
            // Stretch by stretch. A stretch whose words are gone leaves the
            // draft on the ones that are still there; the draft is gone with
            // the last of them.
            const moved = tracker.carry(tr, current, before);
            // The same object back when nothing moved: `useSyncExternalStore`
            // requires the snapshot to be identical while the store has not
            // changed.
            if (moved === current.slots) return current;
            const kept = moved.filter((segment): segment is DraftRange => segment !== null);
            if (kept.length === 0) {
              return { kind: 'dropped', why: 'targetGone', opening: current.opening };
            }
            return { ...current, segments: kept, slots: moved };
          },
        },

        props: {
          decorations: paintDraft,
        },

        /**
         * Broadcasts the draft, and names its range in Yjs terms again after
         * every change to the body or to the range.
         * @param view - The editor view.
         * @returns The view's update and teardown.
         */
        view: (view) => localRangeView(view, watch, tracker),
      }),
    ],
  };
});
