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
 *   position to the end. Those are resolved from Yjs relative positions, taken
 *   from the range as it stands right before each Yjs transaction begins — the
 *   moment y-prosemirror takes the selection for the same purpose
 *   (`beforeAllTransactions`, `y-prosemirror.cjs:409-419`). Taken then, they
 *   name the text the range covers now, whatever the reader typed or however
 *   the block was rebuilt since the draft opened.
 *
 * The start names the first letter covered and the end the last one, with its
 * association to the left (`assoc = -1`, which Yjs resolves to "after this
 * letter" and, once the letter is deleted, to where it was — `yjs.cjs:2566`).
 * Text written against either edge stays outside, whichever way it arrives.
 *
 * A peer changing a block's type rebuilds its text in the shared document, so
 * no Yjs position taken before survives it (y-tiptap recovers the selection
 * from the same case with `findAbsolutePositionAfterStructuralChange`, keyed
 * by block order). BlockNote gives every block a lasting id, so the draft is
 * also held by block id and offset; when the Yjs positions come back empty,
 * that finds the words again, and it is taken only where the words found are
 * exactly the words the draft covered.
 *
 * It is GONE once both ends meet: every character it covered has been
 * deleted. Posting into a gone range would put the reader's words in a thread
 * pointing at nothing, which is what A21 is about — the draft card keeps its
 * place in the panel and says so instead.
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
 * read is kept (design §9.4.1).
 */

import { createExtension } from '@blocknote/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { Mapping } from '@tiptap/pm/transform';
import {
  Plugin,
  PluginKey,
  type EditorState,
  type Transaction,
} from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import {
  absolutePositionToRelativePosition,
  ySyncPluginKey,
} from 'y-prosemirror';
import * as Y from 'yjs';

import {
  READING_CLASS,
  selectedThreadsIn,
} from '@web/spaces/document/document-comment-selection';
import {
  resolveTrackedSpan,
  syncBindingOf,
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
 * closes, so it is what names that draft — the words written in it are kept
 * against it (`document-comment-unsent.ts`).
 */
export interface DraftOpening {
  /** Counts openings in this page, for reading a draft in a debugger. */
  readonly serial: number;
}

/** How many drafts have opened in this page. */
let openings = 0;

/** A place in the body named by the block it is in and how far into it. */
interface BlockPoint {
  readonly blockId: string;
  readonly offset: number;
}

/**
 * The open draft's range as it stood right before a Yjs transaction, named
 * two ways, together with the opening it was taken for.
 */
interface HeldAcrossYjs {
  readonly opening: DraftOpening;
  readonly tracked: TrackedLink;
  /** The range by block id and offset, with the words it covered. */
  readonly byBlock: {
    readonly from: BlockPoint;
    readonly to: BlockPoint;
    readonly words: string;
  } | null;
}

/**
 * Names a position by the block around it and its offset into that block's
 * text.
 * @param doc - The body.
 * @param pos - The position, inside a block's text.
 * @returns The block's id and the offset, or null outside any block's text.
 */
function blockPointAt(doc: ProseMirrorNode, pos: number): BlockPoint | null {
  const $pos = doc.resolve(pos);
  if (!$pos.parent.isTextblock) return null;
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    const id: unknown = $pos.node(depth).attrs.id;
    if (typeof id === 'string') {
      return { blockId: id, offset: pos - $pos.start() };
    }
  }
  return null;
}

/**
 * Finds a block point again in a body that changed.
 * @param doc - The body now.
 * @param point - The point as it was taken.
 * @returns The position, or null when the block or the offset is gone.
 */
function positionOf(doc: ProseMirrorNode, point: BlockPoint): number | null {
  let found: number | null = null;
  doc.descendants((node, pos) => {
    if (found !== null) return false;
    if (node.attrs.id !== point.blockId) return true;
    node.descendants((inner, innerPos) => {
      if (found !== null || !inner.isTextblock) return found === null;
      if (point.offset <= inner.content.size) {
        found = pos + 1 + innerPos + 1 + point.offset;
      }
      return false;
    });
    return false;
  });
  return found;
}

/**
 * Names a range in the shared document: the start by the first letter it
 * covers, the end by the last one, associated to its left.
 * @param state - The state the range belongs to, in step with the Yjs doc.
 * @param range - The range.
 * @returns The two positions, or null while the editor has no binding.
 */
function trackDraft(state: EditorState, range: DraftRange): TrackedLink | null {
  const bound = syncBindingOf(state);
  if (bound === null) return null;
  const start = absolutePositionToRelativePosition(
    range.from,
    bound.type,
    bound.mapping,
  ) as Y.RelativePosition;
  const last = absolutePositionToRelativePosition(
    range.to - 1,
    bound.type,
    bound.mapping,
  ) as Y.RelativePosition;
  // A last letter with no item is a range ending past the end of a block's
  // text; the position right after the range names that end already.
  const end =
    last.item === null
      ? (absolutePositionToRelativePosition(
        range.to,
        bound.type,
        bound.mapping,
      ) as Y.RelativePosition)
      : new Y.RelativePosition(last.type, last.tname, last.item, -1);
  return { start, end };
}

/** The open draft: where it is now, and which opening it is. */
export interface DraftAim extends DraftRange {
  readonly opening: DraftOpening;
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
 * What a caller dispatches under the plugin's key: a range opens a draft,
 * `null` closes it, and `{ drop }` drops it for a reason the plugin cannot
 * see for itself.
 */
export type DraftCommand = DraftRange | null | { readonly drop: 'cannotWrite' };

/** The plugin's key, which is also the meta a {@link DraftCommand} goes under. */
export const DOCUMENT_COMMENT_DRAFT_RANGE = new PluginKey<Draft | null>(
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
 * Finds the draft's words again by block id, after a change that rebuilt the
 * text the Yjs positions named.
 * @param doc - The body after the change.
 * @param held - What was taken before it.
 * @returns The range, only where it covers exactly the same words.
 */
function findByBlock(
  doc: ProseMirrorNode,
  held: HeldAcrossYjs | null,
): DraftRange | null {
  const byBlock = held?.byBlock;
  if (byBlock == null) return null;
  const from = positionOf(doc, byBlock.from);
  const to = positionOf(doc, byBlock.to);
  if (from === null || to === null || to <= from) return null;
  return doc.textBetween(from, to) === byBlock.words ? { from, to } : null;
}

/**
 * Carries the open draft across one transaction.
 * @param tr - The transaction.
 * @param current - The draft before it.
 * @param before - The state it applies to, whose sync binding is the live one.
 * @param held - The range as Yjs named it right before the Yjs transaction
 *   this may come from, or null outside one.
 * @returns The draft after it: the same object when nothing moved, dropped
 *   once the text it covered is gone.
 */
function carryDraft(
  tr: Transaction,
  current: Draft & { kind: 'aimed' },
  before: EditorState,
  held: HeldAcrossYjs | null,
): Draft {
  // The binding re-rendering the same content (a mount) changes no text.
  if (!tr.docChanged || tr.doc.eq(tr.before)) return current;
  const sync = tr.getMeta(ySyncPluginKey) as
    | { isChangeOrigin?: boolean }
    | undefined;
  const tracked =
    sync?.isChangeOrigin === true && held?.opening === current.opening
      ? held.tracked
      : null;
  // The binding has rebuilt its index to the new nodes before it dispatches
  // (`_typeChanged`), so the relative positions resolve against this change.
  const moved =
    tracked !== null
      ? (resolveTrackedSpan(before, tracked) ?? findByBlock(tr.doc, held))
      : mapDraftRange(current, tr.mapping);
  // The SAME object back when nothing moved, not an equal one.
  // `useSyncExternalStore` requires the snapshot to be identical while the
  // store has not changed, and a fresh object per transaction would make
  // every keystroke anywhere in the body read as a change to this range.
  if (moved === null) {
    return { kind: 'dropped', why: 'targetGone', opening: current.opening };
  }
  return moved.from === current.from && moved.to === current.to
    ? current
    : {
      kind: 'aimed',
      from: moved.from,
      to: moved.to,
      opening: current.opening,
    };
}

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
  // What `beforeAllTransactions` took, cleared once the Yjs batch is over.
  let held: HeldAcrossYjs | null = null;
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
              // A range covering nothing is refused here rather than left for
              // the post to notice: the entries are unavailable over text-less
              // ranges already (`canCommentOver`), so one arriving means a
              // caller is wrong, and holding it would let a comment be written
              // with no words under it.
              if (asked === null || asked.to <= asked.from) return null;
              openings += 1;
              return {
                kind: 'aimed',
                from: asked.from,
                to: asked.to,
                opening: { serial: openings },
              };
            }
            if (current?.kind !== 'aimed') return current;
            // A selection change carries no steps and the range comes back
            // unchanged — which is what a reader clicking elsewhere before
            // typing their comment needs.
            return carryDraft(tr, current, before, held);
          },
        },

        props: {
          decorations: paintDraft,
        },

        /**
         * Broadcasts the draft, and takes its range in Yjs terms right before
         * every Yjs transaction, the way y-prosemirror takes the selection.
         * @param view - The editor view.
         * @returns The view's update and teardown.
         */
        view: (view) => {
          const watching = watch.view(view);
          const doc = (
            ySyncPluginKey.getState(view.state) as { doc?: Y.Doc } | undefined
          )?.doc;
          /** Takes the open draft's range as Yjs names it now. */
          const beforeAll = (): void => {
            if (held !== null) return;
            const range = draftRangeIn(view.state);
            const tracked = range === null ? null : trackDraft(view.state, range);
            if (range === null || tracked === null) return;
            const { doc: body } = view.state;
            const from = blockPointAt(body, range.from);
            const to = blockPointAt(body, range.to);
            held = {
              opening: range.opening,
              tracked,
              byBlock:
                from === null || to === null
                  ? null
                  : { from, to, words: body.textBetween(range.from, range.to) },
            };
          };
          /** Forgets it once the Yjs batch is over. */
          const afterAll = (): void => {
            held = null;
          };
          doc?.on('beforeAllTransactions', beforeAll);
          doc?.on('afterAllTransactions', afterAll);
          return {
            update: watching.update,
            destroy: (): void => {
              doc?.off('beforeAllTransactions', beforeAll);
              doc?.off('afterAllTransactions', afterAll);
              watching.destroy?.();
            },
          };
        },
      }),
    ],
  };
});
