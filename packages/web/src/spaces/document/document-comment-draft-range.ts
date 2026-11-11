// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Where an unposted comment is going to land (#18, A21, design §9.4).
 *
 * Between pressing the entry and posting, that range carries no mark — the
 * mark is what posting writes — so nothing in the body moves it while the
 * body keeps being edited underneath: the user typing elsewhere, a peer
 * inserting a paragraph above, somebody pressing undo.
 *
 * The range lives only in this editor: it is never written to the shared
 * document, and closing the page ends it. That is how the editors with a
 * pending comment keep one (CKEditor 5's draft marker "is not managed using
 * operations"; BlockNote and Liveblocks use the user's selection).
 *
 * How it is carried across a change — the user's own edits, edits that come
 * in through Yjs, undo — is the local range's (`document-local-range.ts`),
 * which the AI dialog's original range shares (inner#1860). A draft over
 * several selected table cells is one stretch per cell (inner#1126 A9): the
 * cells need not be next to each other in the document, so one range from the
 * first to the last would take in cells nobody selected.
 *
 * A draft is GONE with the last of its stretches. Posting then would put the
 * user's words in a thread pointing at nothing, which is what A21 is about —
 * the draft card keeps its place in the panel and says so instead, keeping
 * what the user wrote.
 *
 * ## One draft, one place
 *
 * Everything about the open draft that is not the user's words lives here:
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
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
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
import { canCommentOnMedia, mediaRowById } from '@web/spaces/document/document-comment-media';

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
   * user asking to write again, which the card answers by taking the focus.
   */
  readonly entry: number;
}

/**
 * An open draft on a picture, a video or an audio block, aimed by the
 * block's id (inner#1316 §5.3). It has no words under it, so it carries no
 * stretches.
 */
export interface MediaDraftAim {
  readonly mediaBlockId: string;
  readonly opening: DraftOpening;
  /** As on {@link DraftAim}. */
  readonly entry: number;
}

/** Why a draft can no longer be written (A21, A22). */
export type DraftDropReason = 'targetGone' | 'cannotWrite';

/**
 * The draft as the panel shows it: aimed at words, or dropped and saying why
 * until the user dismisses the notice.
 */
export type Draft =
  | ({ readonly kind: 'aimed' } & DraftAim)
  | ({ readonly kind: 'aimed' } & MediaDraftAim)
  | {
    readonly kind: 'dropped';
    readonly why: DraftDropReason;
    readonly opening: DraftOpening;
    /**
     * The block a media draft was aimed at and the entry it was opened by,
     * kept only when the block went: the id is a reliable identity, so the
     * draft is aimed again when the block is back (an undo, a peer's undo, a
     * drag that moves it).
     */
    readonly media?: { readonly blockId: string; readonly entry: number };
  };

/**
 * What a caller dispatches under the plugin's key: stretches open a draft, or
 * move the open one there — aimed or dropped — keeping its opening and so
 * its words; `null` closes it; `{ drop }` drops it for a reason the plugin
 * cannot see for itself.
 */
export type DraftCommand =
  | readonly DraftRange[]
  | { readonly mediaBlockId: string }
  | null
  | { readonly drop: 'cannotWrite' };

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
  return aimedRange(draftIn(state));
}

/**
 * A draft aimed at words.
 * @param draft - The draft, if any.
 * @returns It when it is aimed at words, else null.
 */
export function aimedRange(draft: Draft | null): DraftAim | null {
  return draft?.kind === 'aimed' && !('mediaBlockId' in draft) ? draft : null;
}

/**
 * A draft aimed at a media block.
 * @param draft - The draft, if any.
 * @returns It when it is aimed at a block, else null.
 */
export function aimedMedia(draft: Draft | null): MediaDraftAim | null {
  return draft?.kind === 'aimed' && 'mediaBlockId' in draft ? draft : null;
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

/** The block a media draft stands on and the entry it was opened by. */
type DraftMedia = NonNullable<Extract<Draft, { kind: 'dropped' }>['media']>;

/**
 * The block a draft stands on, aimed at it or dropped when it went.
 * @param draft - The draft.
 * @returns The block and entry, or null for a draft on words or one dropped for another reason.
 */
function mediaOf(draft: Draft): DraftMedia | null {
  if (draft.kind === 'dropped') return draft.media ?? null;
  return 'mediaBlockId' in draft ? { blockId: draft.mediaBlockId, entry: draft.entry } : null;
}

/**
 * Carries a media draft across a change to the body: aimed while its block is
 * in the body, dropped while it is not.
 * @param current - The draft.
 * @param media - The block it stands on.
 * @param doc - The body after the change.
 * @returns The draft after it; `current` when nothing changed.
 */
function carryMedia(current: Draft, media: DraftMedia, doc: ProseMirrorNode): Draft {
  const there = mediaRowById(doc, media.blockId) !== undefined;
  if (current.kind === 'aimed') return there ? current : { kind: 'dropped', why: 'targetGone', opening: current.opening, media };
  return there ? { kind: 'aimed', mediaBlockId: media.blockId, opening: current.opening, entry: media.entry } : current;
}

/**
 * The opening a draft keeps its words against: the open one's, else a new one.
 * @param current - The draft before this press, if any.
 * @returns The opening.
 */
function openingOf(current: Draft | null): DraftOpening {
  if (current !== null) return current.opening;
  openings += 1;
  return { serial: openings };
}

/**
 * The block an open media draft is aimed at.
 * @param state - The editor state.
 * @returns The block id, or null when no draft is aimed at a block.
 */
export function mediaDraftIn(state: EditorState): string | null {
  return aimedMedia(draftIn(state))?.mediaBlockId ?? null;
}

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
              if ('mediaBlockId' in asked) {
                if (!canCommentOnMedia(tr.doc, asked.mediaBlockId)) return current;
                entries += 1;
                return { kind: 'aimed', mediaBlockId: asked.mediaBlockId, opening: openingOf(current), entry: entries };
              }
              // A range covering no letters is refused here rather than left
              // for the post to notice: the entries are unavailable over such
              // ranges already (`canCommentOver`), so one arriving means a
              // caller is wrong, and holding it would let a comment be written
              // with no words under it.
              const segments = aimAt(tr.doc, asked as readonly DraftRange[]);
              if (segments.length === 0) return current;
              // An open draft is moved, not replaced: it ends only on cancel
              // or save, and its words are kept against its opening.
              entries += 1;
              return { kind: 'aimed', segments, slots: segments, opening: openingOf(current), entry: entries };
            }
            if (current === null) return null;
            const media = mediaOf(current);
            if (media !== null) return tr.docChanged ? carryMedia(current, media, tr.doc) : current;
            // A selection change carries no steps and the range comes back
            // unchanged — which is what a user clicking elsewhere before
            // typing their comment needs.
            const aimed = aimedRange(current);
            if (aimed === null || !changesText(tr)) return current;
            // Stretch by stretch. A stretch whose words are gone leaves the
            // draft on the ones that are still there; the draft is gone with
            // the last of them.
            const moved = tracker.carry(tr, aimed, before);
            // The same object back when nothing moved: `useSyncExternalStore`
            // requires the snapshot to be identical while the store has not
            // changed.
            if (moved === aimed.slots) return current;
            const kept = moved.filter((segment): segment is DraftRange => segment !== null);
            if (kept.length === 0) {
              return { kind: 'dropped', why: 'targetGone', opening: aimed.opening };
            }
            return { ...aimed, kind: 'aimed', segments: kept, slots: moved };
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
