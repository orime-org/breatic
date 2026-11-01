// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A range that lives only in this editor and follows the words it was put on
 * while the body is edited underneath (inner#1860 design §5.4): the unposted
 * comment's range (`document-comment-draft-range.ts`) and the AI dialog's
 * original range (`document-ai-range.ts`) are each one instance of it.
 *
 * It is never written to the shared document. Changes arrive two ways, and
 * each is carried its own way:
 *
 * - The reader's own edits ride `tr.mapping`, which is how ProseMirror carries
 *   a position across a change. A line the reader moves is taken out and put
 *   back, which mapping reads as a deletion, so an end whose mapped position
 *   left its line is found again at the letter it named in the row with
 *   that line's id, while that line's words are the same — the way
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
 * The binding writes a moved line, a line whose type changed, every line
 * between, and a line an undo splits or joins as new letters, so the letter an
 * end names being deleted says nothing about the reader's words. Such an end
 * is found again by its line while that line's words are the same, the same
 * way as a mapped one; an end whose letter was itself deleted stands where
 * that letter was. One whose whole row went with its letters goes to the
 * nearest row still there, as a mapped position inside deleted content goes
 * to the edge of the deletion. Where only the text is left to find the words
 * by, nothing is guessed.
 *
 * Both ends always sit against a letter: the first one covered and just past
 * the last. A range over several selected table cells is one stretch per cell
 * (inner#1126 A9), each carried on its own. A stretch is gone once it covers
 * no letters, or its end comes before its start; the range is gone with the
 * last of its stretches.
 *
 * The carrying runs in a plugin's `apply`, the only place that sees every
 * transaction once and in order; the naming in Yjs terms runs in the plugin's
 * view, after the sync plugin's view has written the reader's edit into Yjs.
 */

import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { EditorState, PluginView, Transaction } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import {
  absolutePositionToRelativePosition,
  relativePositionToAbsolutePosition,
} from 'y-prosemirror';
import * as Y from 'yjs';

import {
  syncBindingOf,
  type SyncBound,
  type TrackedLink,
} from '@web/spaces/document/document-link-tracking';
import { namesOnUndoStack } from '@web/spaces/document/document-undo-selection';
import {
  contentRangeOf,
  rowById,
} from '@web/spaces/document/document-row-by-id';
import { fromYjs } from '@web/spaces/document/document-yjs-origin';

/** One stretch of a local range. */
export interface LocalRange {
  readonly from: number;
  readonly to: number;
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
  range: LocalRange,
): LocalRange | null {
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
 * the line's id, at the letter it named, while that line's words are the
 * same. The way BlockNote keeps a selection across a block move
 * (`moveBlocks.ts`, `getBlockSelectionData`), each end on its own. A line
 * whose words changed leaves only the text to say where the letter went, and
 * nothing is guessed from the text (the comment draft's A21).
 * @param doc - The body after the change.
 * @param line - The line the end sat in before it.
 * @returns The position, or null when the row is gone or its words changed.
 */
function lineNow(doc: ProseMirrorNode, line: EndLine): number | null {
  const row = rowById(doc, line.id);
  const words = row === undefined ? undefined : contentRangeOf(row);
  if (words === undefined || wordsBetween(doc, words.from, words.to) !== line.words) {
    return null;
  }
  return words.from + line.letter + (line.side === 'end' ? 1 : 0);
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
function trackRange(bound: SyncBound, range: LocalRange): TrackedLink {
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
 * its line when the line is still there with the same words. When the line is
 * gone and the letter with it, the end goes to the edge of the nearest
 * surviving line; otherwise it stands where the letter is.
 * @param tr - The transaction the change arrived in.
 * @param bound - The sync binding, rebuilt to the body after the change.
 * @param end - The end as Yjs names it before this change.
 * @param handed - On the reader's undo or redo, the end as named before the
 *   edit it takes back; null otherwise.
 * @param was - The end before the change.
 * @param side - Which end it is.
 * @returns Where the end is now, or null once it is lost.
 */
function endAcrossYjs(
  tr: Transaction,
  bound: SyncBound,
  end: Y.RelativePosition,
  handed: Y.RelativePosition | null,
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
    return besideGoneRow(tr, line.id, side);
  }
  return carryEnd(tr, line, at);
}

/**
 * Carries the range across a change that came in through Yjs.
 * @param tr - The transaction the change arrived in.
 * @param bound - The sync binding, rebuilt to the body after the change.
 * @param link - The range as Yjs names it.
 * @param handed - On the reader's undo or redo, the range as named before the
 *   edit it takes back, when that edit kept one; null otherwise.
 * @param range - The range before the change.
 * @returns Where the range is now, or null once an end is lost.
 */
function carryAcrossYjs(
  tr: Transaction,
  bound: SyncBound,
  link: TrackedLink,
  handed: TrackedLink | null,
  range: LocalRange,
): LocalRange | null {
  const from = endAcrossYjs(
    tr, bound, link.start, handed?.start ?? null, range.from, 'start',
  );
  const to = endAcrossYjs(
    tr, bound, link.end, handed?.end ?? null, range.to, 'end',
  );
  return from !== null && to !== null ? { from, to } : null;
}

/**
 * Carries a local range across one of the reader's own changes, each end on
 * its own: where ProseMirror maps it while that stays in the end's line,
 * otherwise found again by that line. A line moved is taken out and put back,
 * which mapping reads as a deletion; a line the reader deleted or changed is
 * gone, and the mapped position — the range drawn in, or nothing left —
 * stands.
 * @param range - Where the range was before this change.
 * @param tr - The change.
 * @returns Where it is now, or null once the text it covered is gone.
 */
export function mapLocalRange(
  range: LocalRange,
  tr: Transaction,
): LocalRange | null {
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
 * Whether a transaction changes the body's text.
 * @param tr - The transaction.
 * @returns False for a selection change, and for the binding re-rendering the
 *   same content (a mount).
 */
export function changesText(tr: Transaction): boolean {
  return tr.docChanged && !tr.doc.eq(tr.before);
}

/**
 * Whether two lists of stretches are the same stretches.
 * @param a - One list.
 * @param b - The other.
 * @returns True when they match one for one.
 */
function sameSegments(a: readonly LocalRange[], b: readonly LocalRange[]): boolean {
  return a.length === b.length && a.every((one, i) => one.from === b[i]!.from && one.to === b[i]!.to);
}

/**
 * Draws stretches in to their letters and puts them in document order.
 * @param doc - The body.
 * @param ranges - The stretches.
 * @returns Those that cover letters, in order.
 */
export function aimAt(doc: ProseMirrorNode, ranges: readonly LocalRange[]): LocalRange[] {
  return ranges
    .map((range) => letterBounds(doc, range))
    .filter((range): range is LocalRange => range !== null)
    .sort((a, b) => a.from - b.from);
}

/** A local range as one instance holds it: its stretches, and which press put them there. */
export interface HeldLocalRange {
  /** The stretches, in document order; never empty. */
  readonly segments: readonly LocalRange[];
  /**
   * Counts the presses that aimed the range, so the Yjs names an undo hands
   * back are only ever read for the press they were taken for.
   */
  readonly entry: number;
}

/** The names of one press, kept on an undo stack item. */
interface NamedBeforeEdit {
  readonly entry: number;
  readonly links: readonly TrackedLink[];
}

/** One instance's carrying, for its plugin's state and view. */
export interface LocalRangeTracker {
  /**
   * Carries the range across one transaction that changes the body's text.
   * @param tr - The transaction.
   * @param held - The range before it.
   * @param before - The state it applies to, whose sync binding is the live one.
   * @returns The stretches after it: the same array when nothing moved, empty
   *   once the text the range covered is gone.
   */
  readonly carry: (tr: Transaction, held: HeldLocalRange, before: EditorState) => readonly LocalRange[];
  /**
   * The plugin view that names the range in Yjs terms after every change to
   * the body or to the range, and keeps those names on the undo stack.
   * @param view - The editor view.
   * @returns The view's update and teardown.
   */
  readonly view: (view: EditorView) => Required<Pick<PluginView, 'update' | 'destroy'>>;
}

/**
 * One instance of local-range carrying.
 * @param read - The range the instance's plugin holds in a state, or null
 *   while it holds none; the same object while the range has not changed.
 * @returns The carrying, for the instance's plugin.
 */
export function localRangeTracker(read: (state: EditorState) => HeldLocalRange | null): LocalRangeTracker {
  // The open range's stretches as Yjs names them.
  let tracked: readonly TrackedLink[] | null = null;
  // The open range's names, kept on each undo stack item with the press
  // they belong to.
  const onUndoStack = namesOnUndoStack<NamedBeforeEdit>((state) => {
    const held = read(state);
    return tracked === null || held === null ? null : { entry: held.entry, links: tracked };
  });
  return {
    carry: (tr, held, before) => {
      const kept = onUndoStack.handedFor(tr);
      const handed = kept?.entry === held.entry ? kept.links : null;
      const bound = syncBindingOf(before);
      const moved: LocalRange[] = [];
      held.segments.forEach((segment, index) => {
        const link = tracked?.[index] ?? null;
        // The binding has rebuilt its index to the new nodes before it
        // dispatches (`_typeChanged`), so the relative positions resolve
        // against this change.
        const carried =
          fromYjs(tr) && link !== null && bound !== null
            ? carryAcrossYjs(tr, bound, link, handed?.[index] ?? null, segment)
            : mapLocalRange(segment, tr);
        const drawn =
          carried === null || carried.to <= carried.from ? null : letterBounds(tr.doc, carried);
        if (drawn !== null) moved.push(drawn);
      });
      // The SAME array back when nothing moved, not an equal one: a snapshot
      // read through `useSyncExternalStore` must stay identical while the
      // store has not changed.
      return sameSegments(moved, held.segments) ? held.segments : moved;
    },
    view: (view) => {
      // Keeps the range as named before the reader's edit on the stack item
      // the edit made, as y-prosemirror's undo plugin keeps the selection
      // (`undo-plugin.js`).
      const stopKeeping = onUndoStack.attach(view);
      return {
        update: (next, prev): void => {
          const held = read(next.state);
          const bound = syncBindingOf(next.state);
          if (held === null) {
            tracked = null;
          } else if (bound !== null && (next.state.doc !== prev.doc || read(prev) !== held)) {
            tracked = held.segments.map((segment) => trackRange(bound, segment));
          }
        },
        destroy: (): void => {
          stopKeeping();
        },
      };
    },
  };
}
