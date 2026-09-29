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
 *   way y-prosemirror's cursor plugin places a cursor (`cursor-plugin.js`):
 *   taken again after every change to the body, so each one names the body
 *   as the change before it left it. On an undo or redo of the reader's own,
 *   each end is resolved from the name taken before the edit it takes back
 *   (y-prosemirror's `restoreRelativeSelection`), kept on that edit's undo
 *   stack item the way y-prosemirror's undo plugin keeps the selection, so
 *   letters the undo writes back are followed — while the letter that name
 *   holds is there; otherwise the end is carried like any change through Yjs.
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
 * where that letter was. One whose whole row went with its letters follows
 * them into the row before when the reader's own undo joined the row onto it,
 * and otherwise goes to the nearest row still there, as a mapped position
 * inside deleted content goes to the edge of the deletion. Where a peer's edit
 * leaves only the text to guess from, nothing is guessed: a peer editing the
 * same lines at the same time is outside the promise (A21), and a draft whose
 * ends cross says so and keeps what was written.
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
  yUndoPluginKey,
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
  keepOnUndoStack,
  type UndoManagerLike,
} from '@web/spaces/document/document-undo-selection';
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

/**
 * The draft's range as Yjs named it before one of the reader's edits, kept on
 * that edit's undo stack item, with the press on the entry it belongs to.
 */
interface NamedBeforeEdit {
  readonly entry: number;
  readonly link: TrackedLink;
}

/** The sync binding, as a position conversion takes it. */
type Binding = NonNullable<ReturnType<typeof syncBindingOf>>;


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
 * @param line - The line the end sat in before it, or null when it sat in none.
 * @param at - Where its path puts it, or null when the path cannot say.
 * @returns Where the end is now, or null once it is lost.
 */
function carryEnd(
  tr: Transaction,
  line: EndLine | null,
  at: number | null,
): number | null {
  if (line === null || (at !== null && inLine(tr.doc, at, line))) return at;
  return lineNow(tr.doc, line) ?? at;
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
 * Whether the letter a name holds is in the body, following it to the copy an
 * undo wrote back when it was deleted — the way Yjs itself resolves a name
 * (`followRedone`). A name whose letter is gone resolves to the gap it left,
 * and one whose line element was deleted to a struct that is not an item.
 * @param store - The document's struct store.
 * @param end - The end as Yjs names it.
 * @returns True when the letter, or the copy an undo wrote back, is there.
 */
function letterAlive(store: Y.Doc['store'], end: Y.RelativePosition): boolean {
  if (end.item === null) return true;
  let id = end.item;
  for (;;) {
    const item = Y.getItem(store, id);
    if (!(item instanceof Y.Item)) return false;
    if (!item.deleted) return true;
    if (item.redone === null) return false;
    id = Y.createID(item.redone.client, item.redone.clock + id.clock - item.id.clock);
  }
}

/**
 * Every row's id, in document order.
 * @param doc - The body.
 * @returns The ids.
 */
function rowIdsIn(doc: ProseMirrorNode): string[] {
  const ids: string[] = [];
  doc.descendants((node) => {
    const rowId: unknown = node.attrs['id'];
    if (typeof rowId === 'string') ids.push(rowId);
    return true;
  });
  return ids;
}

/**
 * Where an end goes when the reader's own undo or redo joined its row onto
 * the row before it: that row held its old words followed by the gone row's
 * words, less what else the same undo step takes back — Yjs folds edits made
 * within its capture timeout into one step, so typing right after a split
 * goes with it. The end is found there the way `lineNow` finds an end in a
 * line whose words changed, the result ProseMirror maps when the reader joins
 * the two rows themselves. A peer's join is not followed: a peer editing the
 * same lines at the same time is outside the promise (A21).
 * @param tr - The change.
 * @param line - The line the end sat in before it.
 * @returns Where the end is now, or null when its letter is not there.
 */
function joinedInto(tr: Transaction, line: EndLine): number | null {
  const ids = rowIdsIn(tr.before);
  const previous = ids[ids.indexOf(line.id) - 1];
  if (previous === undefined) return null;
  const was = rowById(tr.before, previous);
  const wasWords = was === undefined ? undefined : contentRangeOf(was);
  if (wasWords === undefined) return null;
  const before = wordsBetween(tr.before, wasWords.from, wasWords.to);
  return lineNow(tr.doc, {
    id: previous,
    words: before + line.words,
    letter: before.length + line.letter,
    side: line.side,
  });
}

/**
 * Where an end goes once the whole row it sat in is gone with its letters: to the start of the
 * first row after it that is still there, or the end of the last row before
 * it, the way ProseMirror maps a position inside deleted content to the edge
 * of the deletion. Its letters were deleted with the row, and Yjs resolves a
 * name whose line element is deleted to a place it cannot vouch for.
 * @param tr - The change.
 * @param id - The row the end sat in.
 * @param side - Which end it is.
 * @returns Where the end is now, or null when no row on that side is left.
 */
function besideGoneRow(tr: Transaction, id: string, side: Side): number | null {
  const ids = rowIdsIn(tr.before);
  const at = ids.indexOf(id);
  const beside = side === 'start' ? ids.slice(at + 1) : ids.slice(0, at).reverse();
  for (const other of beside) {
    const row = rowById(tr.doc, other);
    const words = row === undefined ? undefined : contentRangeOf(row);
    if (words !== undefined) return side === 'start' ? words.from : words.to;
  }
  return null;
}

/**
 * Carries one end across a change that came in through Yjs. On the reader's
 * own undo or redo, the name from before the edit being taken back is used
 * first, the way y-prosemirror puts the selection back
 * (`restoreRelativeSelection`) — while the letter it holds is there: a range,
 * unlike a caret, collapses or lands on other words in the gap a gone letter
 * leaves. Otherwise a peer's editor writes a moved line, a line whose type
 * changed, and every line between as new letters, so a letter the end names
 * being gone says nothing about the reader's words: the end is found again by
 * its line when the line is still there. When the line is gone and the letter
 * with it, the end follows its words into the line the reader's own undo
 * joined it onto, or else goes to the edge of the nearest surviving line;
 * otherwise it stands where the letter is.
 * @param tr - The transaction the change arrived in.
 * @param bound - The sync binding, rebuilt to the body after the change.
 * @param end - The end as Yjs names it before this change.
 * @param handed - On the reader's undo or redo, the end as named before the
 *   edit it takes back; null otherwise.
 * @param undo - Whether the change is the reader's own undo or redo.
 * @param was - The end before the change.
 * @param side - Which end it is.
 * @returns Where the end is now, or null once it is lost.
 */
function endAcrossYjs(
  tr: Transaction,
  bound: Binding,
  end: Y.RelativePosition,
  handed: Y.RelativePosition | null,
  undo: boolean,
  was: number,
  side: Side,
): number | null {
  if (handed !== null && letterAlive(bound.doc.store, handed)) {
    const back = relativePositionToAbsolutePosition(
      bound.doc,
      bound.type,
      handed,
      bound.mapping,
    );
    if (back !== null) return back;
  }
  const at = relativePositionToAbsolutePosition(
    bound.doc,
    bound.type,
    end,
    bound.mapping,
  );
  const line = endLineAt(tr.before, was, side);
  if (
    line !== null &&
    rowById(tr.doc, line.id) === undefined &&
    !letterAlive(bound.doc.store, end)
  ) {
    return (undo ? joinedInto(tr, line) : null) ?? besideGoneRow(tr, line.id, side);
  }
  return carryEnd(tr, line, at);
}

/**
 * Carries the range across a change that came in through Yjs.
 * @param tr - The transaction the change arrived in.
 * @param bound - The sync binding, rebuilt to the body after the change.
 * @param link - The range as Yjs names it.
 * @param undo - Whether the change is the reader's own undo or redo.
 * @param handed - On the reader's undo or redo, the range as named before the
 *   edit it takes back, when that edit kept one; null otherwise.
 * @param range - The range before the change.
 * @returns Where the range is now, or null once an end is lost.
 */
function carryAcrossYjs(
  tr: Transaction,
  bound: Binding,
  link: TrackedLink,
  undo: boolean,
  handed: TrackedLink | null,
  range: DraftRange,
): DraftRange | null {
  const from = endAcrossYjs(
    tr, bound, link.start, handed?.start ?? null, undo, range.from, 'start',
  );
  const to = endAcrossYjs(
    tr, bound, link.end, handed?.end ?? null, undo, range.to, 'end',
  );
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
    const line = endLineAt(tr.before, pos, bias === 1 ? 'start' : 'end');
    return carryEnd(tr, line, mapped) ?? mapped;
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
 * Whether a change is the reader's own undo or redo, as the sync plugin marks
 * the change it builds from one.
 * @param tr - The transaction.
 * @returns True for the reader's undo or redo.
 */
function undoRedo(tr: Transaction): boolean {
  const sync = tr.getMeta(ySyncPluginKey) as
    | { isUndoRedoOperation?: boolean }
    | undefined;
  return sync?.isUndoRedoOperation === true;
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
 * @param handed - The range as named before the edit an undo or redo takes
 *   back, or null when that edit kept none for this draft; read only on the
 *   reader's own undo or redo.
 * @returns The draft after it: the same object when nothing moved, dropped
 *   once the text it covered is gone.
 */
function carryDraft(
  tr: Transaction,
  current: Draft & { kind: 'aimed' },
  before: EditorState,
  tracked: TrackedLink | null,
  handed: TrackedLink | null,
): Draft {
  const bound = syncBindingOf(before);
  // The binding has rebuilt its index to the new nodes before it dispatches
  // (`_typeChanged`), so the relative positions resolve against this change.
  const carried =
    fromYjs(tr) && tracked !== null && bound !== null
      ? carryAcrossYjs(
        tr,
        bound,
        tracked,
        undoRedo(tr),
        undoRedo(tr) ? handed : null,
        current,
      )
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
  let tracked: TrackedLink | null = null;
  // The names as they stood when the current Yjs transaction began.
  let beforeYjs: TrackedLink | null = null;
  // The names the last undo or redo handed back for this draft, if any.
  let handed: TrackedLink | null = null;
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
              return { kind: 'aimed', ...aim, opening, entry: entries };
            }
            // A selection change carries no steps and the range comes back
            // unchanged — which is what a reader clicking elsewhere before
            // typing their comment needs.
            if (current?.kind !== 'aimed' || !changesText(tr)) return current;
            return carryDraft(tr, current, before, tracked, handed);
          },
        },

        props: {
          decorations: paintDraft,
        },

        /**
         * Broadcasts the draft, and names its range in Yjs terms again after
         * every change to the body or to the range. The sync plugin's view
         * writes the reader's edit into Yjs before this one runs, so the names
         * are taken against the body as it now stands — which is when
         * y-prosemirror's cursor plugin takes the reader's cursor.
         * @param view - The editor view.
         * @returns The view's update and teardown.
         */
        view: (view) => {
          const watching = watch.view(view);
          const doc = syncBindingOf(view.state)?.doc;
          const undo = (
            yUndoPluginKey.getState(view.state) as
              | { undoManager?: UndoManagerLike }
              | undefined
          )?.undoManager;
          /**
           * Keeps the range as named before the reader's edit on the stack
           * item the edit made, and hands an undo or redo back the range as
           * named before the edit it takes back — the way y-prosemirror's undo
           * plugin keeps and restores the selection (`undo-plugin.js`), with
           * the handover moved ahead of the observer for the reason
           * `document-undo-selection.ts` gives.
           */
          const stopKeeping =
            doc === undefined || undo === undefined
              ? undefined
              : keepOnUndoStack(
                doc,
                undo,
                {},
                (): NamedBeforeEdit | null => {
                  const range = draftRangeIn(view.state);
                  return beforeYjs === null || range === null
                    ? null
                    : { entry: range.entry, link: beforeYjs };
                },
                (stored) => {
                  const named = stored as NamedBeforeEdit | undefined;
                  handed =
                    named !== undefined && named.entry === draftRangeIn(view.state)?.entry
                      ? named.link
                      : null;
                },
              );
          /**
           * Takes the names as they stand before a Yjs transaction, which is
           * what the stack item it may push has to keep — y-prosemirror takes
           * the selection it restores at the same moment
           * (`beforeAllTransactions`). An undo or redo retakes the names in
           * this view before Yjs pushes the item it makes.
           */
          const onBeforeAll = (): void => {
            beforeYjs = tracked;
          };
          doc?.on('beforeAllTransactions', onBeforeAll);
          return {
            update: (next, prev): void => {
              const range = draftRangeIn(next.state);
              const bound = syncBindingOf(next.state);
              if (range === null) {
                tracked = null;
              } else if (
                bound !== null &&
                (next.state.doc !== prev.doc || draftRangeIn(prev) !== range)
              ) {
                tracked = trackDraft(bound, range);
              }
              watching.update?.(next, prev);
            },
            destroy: (): void => {
              stopKeeping?.();
              doc?.off('beforeAllTransactions', onBeforeAll);
              watching.destroy?.();
            },
          };
        },
      }),
    ],
  };
});
