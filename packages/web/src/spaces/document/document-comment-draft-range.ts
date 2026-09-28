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
 * Two ways it is carried across a change, because changes arrive two ways:
 *
 * - The reader's own edits ride `tr.mapping`, which is how ProseMirror carries
 *   a position across a change. A line the reader moves is taken out and put
 *   back, which mapping reads as a deletion, so an end whose mapped position
 *   left its line is found again at the letter it named in the row with
 *   that line's id, carried across what changed in that line — the way
 *   BlockNote keeps a selection across a block move (`moveBlocks.ts`,
 *   `getBlockSelectionData`).
 * - Everything that comes in through Yjs — a peer's edit, an undo, a thread
 *   being settled — lands as ONE replacement of the whole body
 *   (`ySyncPluginKey` meta `isChangeOrigin`), and that mapping sends every
 *   position to the end. Those are resolved from Yjs relative positions, the
 *   way y-prosemirror's cursor plugin places a cursor (`cursor-plugin.js`).
 *   They are taken again only after the reader's own edits, once the binding
 *   has written them into Yjs; across Yjs changes the same positions are kept,
 *   so a letter a peer deletes and then brings back with undo is followed to
 *   where it came back (`followUndoneDeletions`).
 *
 * The start names the first letter covered and the end the last one, with its
 * association to the left (`assoc = -1`, which Yjs resolves to "after this
 * letter"). Text written against either edge stays outside, whichever way it
 * arrives. Whatever lies between the two ends is the range.
 *
 * A peer's editor writes a moved line, a line whose type changed, and every
 * line between as new letters, so the letter an end names being deleted says
 * nothing about the reader's words. Such an end is found again by its line,
 * the same way as a mapped one; an end whose letter was itself deleted stands
 * where that letter was.
 *
 * Both ends always sit against a letter: the first one covered and just past
 * the last. A range that reaches into the next line, or past non-text at an
 * edge, is drawn in to its letters wherever a range is written.
 *
 * It is GONE once it covers no letters, or its end comes before its start.
 * Posting then would put the reader's words in a thread pointing at nothing,
 * which is what A21 is about — the draft card keeps its place in the panel
 * and says so instead, keeping what the reader wrote.
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
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import {
  Plugin,
  PluginKey,
  type EditorState,
  type Transaction,
} from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import {
  absolutePositionToRelativePosition,
  relativePositionToAbsolutePosition,
  ySyncPluginKey,
} from 'y-prosemirror';
import { simpleDiffString } from 'lib0/diff';
import * as Y from 'yjs';

import {
  READING_CLASS,
  hoveredThreadIn,
  selectedThreadsIn,
} from '@web/spaces/document/document-comment-selection';
import {
  syncBindingOf,
  type TrackedLink,
} from '@web/spaces/document/document-link-tracking';
import { watchPluginState } from '@web/spaces/document/document-plugin-watch';
import {
  contentRangeOf,
  rowById,
} from '@web/spaces/document/document-row-by-id';

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

/** How many times a comment entry has been pressed in this page. */
let entries = 0;

/** The sync binding, as a position conversion takes it. */
type Binding = NonNullable<ReturnType<typeof syncBindingOf>>;

/** The open draft's range as Yjs names it, with the opening it names. */
interface TrackedDraft {
  readonly opening: DraftOpening;
  readonly link: TrackedLink;
}

/**
 * Draws a range in to the letters it covers.
 * @param doc - The body.
 * @param range - The range.
 * @returns From the first letter covered to just past the last, or null when
 *   it covers none.
 */
function letterBounds(
  doc: ProseMirrorNode,
  range: DraftRange,
): DraftRange | null {
  let from: number | null = null;
  let to = 0;
  doc.nodesBetween(range.from, range.to, (node, pos) => {
    if (!node.isText) return true;
    const start = Math.max(pos, range.from);
    const end = Math.min(pos + node.nodeSize, range.to);
    if (end > start) {
      from ??= start;
      to = end;
    }
    return false;
  });
  return from === null ? null : { from, to };
}

/** Stands in for a non-text node inside a line, one position wide. */
const LEAF = '\ufffc';

/** Which end of a range: the start names the letter after it, the end the one before. */
type Side = 'start' | 'end';

/** The line one end of a range sits in, as it stood, and the letter it names. */
interface EndLine {
  /** The id of the row the line belongs to. */
  readonly id: string;
  /** Its words, one character per position. */
  readonly words: string;
  /** The letter the end names: its index in the words. */
  readonly letter: number;
  readonly side: Side;
}

/**
 * The words between two positions, a non-text node counted as one character
 * so that an offset into them is an offset into the line.
 * @param doc - The body.
 * @param from - Where they start.
 * @param to - Where they end.
 * @returns The words.
 */
function wordsBetween(doc: ProseMirrorNode, from: number, to: number): string {
  return doc.textBetween(from, to, '', LEAF);
}

/**
 * The line an end of a range sits in.
 * @param doc - The body.
 * @param pos - The end.
 * @param side - Which end it is.
 * @returns The line and the letter the end names in it, or null when it
 *   names no letter of a row's line.
 */
function endLineAt(doc: ProseMirrorNode, pos: number, side: Side): EndLine | null {
  const at = doc.resolve(pos);
  if (!at.parent.isTextblock) return null;
  const id: unknown = at.node(at.depth - 1).attrs['id'];
  const words = wordsBetween(doc, at.start(), at.end());
  const letter = side === 'start' ? at.parentOffset : at.parentOffset - 1;
  return typeof id === 'string' && letter >= 0 && letter < words.length
    ? { id, words, letter, side }
    : null;
}

/**
 * Where an end is after a change, found again by its line: in the row with
 * the line's id, at the letter it named, carried across what changed in that
 * line's words the way the binding finds what changed in a line (the common
 * start and end of the two versions, `simpleDiffString`). The way BlockNote
 * keeps a selection across a block move (`moveBlocks.ts`,
 * `getBlockSelectionData`), each end on its own.
 * @param doc - The body after the change.
 * @param line - The line the end sat in before it.
 * @returns The position, or null when the row is gone or the letter is not
 *   in it any more.
 */
function lineNow(doc: ProseMirrorNode, line: EndLine): number | null {
  const row = rowById(doc, line.id);
  const words = row === undefined ? undefined : contentRangeOf(row);
  if (words === undefined) return null;
  const change = simpleDiffString(
    line.words,
    wordsBetween(doc, words.from, words.to),
  );
  let letter: number;
  if (line.letter < change.index) letter = line.letter;
  else if (line.letter >= change.index + change.remove) {
    letter = line.letter - change.remove + change.insert.length;
  } else return null;
  return words.from + letter + (line.side === 'end' ? 1 : 0);
}

/**
 * Whether a position still sits in the line an end sat in.
 * @param doc - The body after the change.
 * @param pos - The position.
 * @param line - The line.
 * @returns True when it is in a line of that row.
 */
function inLine(doc: ProseMirrorNode, pos: number, line: EndLine): boolean {
  const at = doc.resolve(pos);
  return at.parent.isTextblock && at.node(at.depth - 1).attrs['id'] === line.id;
}

/**
 * Carries one end of a range across a change: where its path puts it while
 * that is still in the line the end sat in, otherwise found again by that
 * line, otherwise where its path puts it after all. Neither path's own answer
 * says which line a position is in: mapping sends an end whose line was moved
 * into the gap it left, and a peer's editor that rewrites a line into another
 * line's words keeps the letters the two share.
 * @param tr - The change.
 * @param was - The end before it.
 * @param side - Which end it is.
 * @param trusted - Where its path puts it, or null when that answer is
 *   known to be stale.
 * @param fallback - Where its path puts it when neither holds.
 * @returns Where the end is now.
 */
function carryEnd<Fallback extends number | null>(
  tr: Transaction,
  was: number,
  side: Side,
  trusted: number | null,
  fallback: Fallback,
): number | Fallback {
  const line = endLineAt(tr.before, was, side);
  if (trusted !== null && (line === null || inLine(tr.doc, trusted, line))) {
    return trusted;
  }
  return (line === null ? null : lineNow(tr.doc, line)) ?? fallback;
}

/**
 * Names a range in the shared document: the start by the first letter it
 * covers, the end by the last one, associated to its left.
 * @param bound - The sync binding, in step with the range's state.
 * @param range - The range, against its letters.
 * @returns The two positions.
 */
function trackDraft(bound: Binding, range: DraftRange): TrackedLink {
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
  return {
    start,
    end: new Y.RelativePosition(last.type, last.tname, last.item, -1),
  };
}

/**
 * Whether the letter a position names is deleted and not brought back. An
 * undo brings a deleted letter back as a new one, which the deleted one
 * points to (`redone`); Yjs resolves the position to the new one.
 * @param store - The document's store.
 * @param id - The letter.
 * @returns True once it is gone for good.
 */
function letterGone(store: Y.Doc['store'], id: Y.ID): boolean {
  let item = Y.getItem(store, id) as Y.Item;
  while (item.redone !== null) item = Y.getItem(store, item.redone) as Y.Item;
  return item.deleted;
}

/**
 * Carries one end across a change that came in through Yjs. A peer's editor
 * writes a moved line, a line whose type changed, and every line between as
 * new letters, so a letter the end names being gone says nothing about the
 * reader's words: the end is found again by its line when the line is still
 * there, and stands where the letter was otherwise.
 * @param tr - The transaction the change arrived in.
 * @param bound - The sync binding, rebuilt to the body after the change.
 * @param end - The end as Yjs names it.
 * @param was - The end before the change.
 * @param side - Which end it is.
 * @returns Where the end is now, or null once it is lost.
 */
function endAcrossYjs(
  tr: Transaction,
  bound: Binding,
  end: Y.RelativePosition,
  was: number,
  side: Side,
): number | null {
  const at = relativePositionToAbsolutePosition(
    bound.doc,
    bound.type,
    end,
    bound.mapping,
  );
  const gone = end.item !== null && letterGone(bound.doc.store, end.item);
  return carryEnd(tr, was, side, gone ? null : at, at);
}

/**
 * Carries the range across a change that came in through Yjs.
 * @param tr - The transaction the change arrived in.
 * @param bound - The sync binding, rebuilt to the body after the change.
 * @param link - The range as Yjs names it.
 * @param range - The range before the change.
 * @returns Where the range is now, or null once an end is lost.
 */
function carryAcrossYjs(
  tr: Transaction,
  bound: Binding,
  link: TrackedLink,
  range: DraftRange,
): DraftRange | null {
  const from = endAcrossYjs(tr, bound, link.start, range.from, 'start');
  const to = endAcrossYjs(tr, bound, link.end, range.to, 'end');
  return from !== null && to !== null ? { from, to } : null;
}

/** The open draft: where it is now, and which opening it is. */
export interface DraftAim extends DraftRange {
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
 * What a caller dispatches under the plugin's key: a range opens a draft, or
 * moves the open one there — aimed or dropped — keeping its opening and so
 * its words; `null` closes it; `{ drop }` drops it for a reason the plugin
 * cannot see for itself.
 */
export type DraftCommand = DraftRange | null | { readonly drop: 'cannotWrite' };

/** The plugin's key, which is also the meta a {@link DraftCommand} goes under. */
export const DOCUMENT_COMMENT_DRAFT_RANGE = new PluginKey<Draft | null>(
  'documentCommentDraftRange',
);

/**
 * Carries a draft's range across one of the reader's own changes, each end on
 * its own: where ProseMirror maps it while that stays in the end's line,
 * otherwise found again by that line. A line moved is taken out and put back,
 * which mapping reads as a deletion; a line the reader deleted or changed is
 * gone, and the mapped position — the range drawn in, or nothing left —
 * stands.
 * @param range - Where the draft was going before this change.
 * @param tr - The change.
 * @returns Where it is going now, or null once the text it covered is gone.
 */
export function mapDraftRange(
  range: DraftRange,
  tr: Transaction,
): DraftRange | null {
  /**
   * Carries one end.
   * @param pos - The end before the change.
   * @param bias - Which side it keeps: the start stays right of text typed
   *   against it, the end left of it, so neither takes in what is typed there.
   * @returns The end after the change.
   */
  const carry = (pos: number, bias: 1 | -1): number => {
    const mapped = tr.mapping.map(pos, bias);
    return carryEnd(tr, pos, bias === 1 ? 'start' : 'end', mapped, mapped);
  };
  const from = carry(range.from, 1);
  const to = carry(range.to, -1);
  return to <= from ? null : { from, to };
}

/**
 * Whether a transaction is a change that came in through Yjs.
 * @param tr - The transaction.
 * @returns True for a peer's edit, an undo, or anything else the binding
 *   writes into the body.
 */
function fromYjs(tr: Transaction): boolean {
  const sync = tr.getMeta(ySyncPluginKey) as
    | { isChangeOrigin?: boolean }
    | undefined;
  return sync?.isChangeOrigin === true;
}

/**
 * Whether a transaction changes the body's text.
 * @param tr - The transaction.
 * @returns False for a selection change, and for the binding re-rendering the
 *   same content (a mount).
 */
function changesText(tr: Transaction): boolean {
  return tr.docChanged && !tr.doc.eq(tr.before);
}

/**
 * Carries the open draft across one transaction.
 * @param tr - The transaction.
 * @param current - The draft before it.
 * @param before - The state it applies to, whose sync binding is the live one.
 * @param tracked - The range as Yjs names it, or null when it is not named.
 * @returns The draft after it: the same object when nothing moved, dropped
 *   once the text it covered is gone.
 */
function carryDraft(
  tr: Transaction,
  current: Draft & { kind: 'aimed' },
  before: EditorState,
  tracked: TrackedDraft | null,
): Draft {
  const bound = syncBindingOf(before);
  // The binding has rebuilt its index to the new nodes before it dispatches
  // (`_typeChanged`), so the relative positions resolve against this change.
  const carried =
    fromYjs(tr) && tracked?.opening === current.opening && bound !== null
      ? carryAcrossYjs(tr, bound, tracked.link, current)
      : mapDraftRange(current, tr);
  const moved =
    carried === null || carried.to <= carried.from
      ? null
      : letterBounds(tr.doc, carried);
  if (moved === null) {
    return { kind: 'dropped', why: 'targetGone', opening: current.opening };
  }
  // The SAME object back when nothing moved, not an equal one.
  // `useSyncExternalStore` requires the snapshot to be identical while the
  // store has not changed, and a fresh object per transaction would make
  // every keystroke anywhere in the body read as a change to this range.
  return moved.from === current.from && moved.to === current.to
    ? current
    : { ...current, from: moved.from, to: moved.to };
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
 *   card being read or its card is under the pointer; nothing while no draft
 *   is open.
 */
function paintDraft(state: EditorState): DecorationSet {
  const range = draftRangeIn(state);
  if (range === null) return DecorationSet.empty;
  const reading =
    selectedThreadsIn(state).includes(DRAFT_THREAD_ID) ||
    hoveredThreadIn(state) === DRAFT_THREAD_ID;
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
  // The open draft's range as Yjs names it.
  let tracked: TrackedDraft | null = null;
  // Set when the range is placed afresh — an entry pressed, or one of the
  // reader's own edits — so the view's update names it again once the
  // binding has written the body into Yjs.
  let retrack = false;
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
              const aim = letterBounds(tr.doc, asked);
              if (aim === null) return current;
              // An open draft is moved, not replaced: it ends only on cancel
              // or save, and its words are kept against its opening.
              let opening = current?.opening;
              if (opening === undefined) {
                openings += 1;
                opening = { serial: openings };
              }
              entries += 1;
              retrack = true;
              return { kind: 'aimed', ...aim, opening, entry: entries };
            }
            // A selection change carries no steps and the range comes back
            // unchanged — which is what a reader clicking elsewhere before
            // typing their comment needs.
            if (current?.kind !== 'aimed' || !changesText(tr)) return current;
            if (!fromYjs(tr)) retrack = true;
            return carryDraft(tr, current, before, tracked);
          },
        },

        props: {
          decorations: paintDraft,
        },

        /**
         * Broadcasts the draft, and names its range in Yjs terms after it was
         * placed afresh. The sync plugin's view writes the reader's edit into
         * Yjs before this one runs, so the names are taken against the body
         * as it now stands — which is when y-prosemirror's cursor plugin takes
         * the reader's cursor.
         * @param view - The editor view.
         * @returns The view's update and teardown.
         */
        view: (view) => {
          const watching = watch.view(view);
          return {
            update: (next, prev): void => {
              const range = draftRangeIn(next.state);
              const bound = syncBindingOf(next.state);
              if (range === null) {
                tracked = null;
              } else if (
                bound !== null &&
                (retrack || tracked?.opening !== range.opening)
              ) {
                tracked = { opening: range.opening, link: trackDraft(bound, range) };
              }
              retrack = false;
              watching.update?.(next, prev);
            },
            destroy: (): void => {
              watching.destroy?.();
            },
          };
        },
      }),
    ],
  };
});
