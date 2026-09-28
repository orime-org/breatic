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
 * letter"). Text written against either edge stays outside, whichever way it
 * arrives.
 *
 * Each end is carried on its own, the way BlockNote keeps a selection across
 * a block move (`moveBlocks.ts`, `getBlockSelectionData`): where its path puts
 * it while that position can be trusted, otherwise found again as the same
 * offset in its line, while the row with that line's id is still there word
 * for word ({@link lineStill}). A move takes a line out and puts the same line
 * back, and both paths read that as a deletion: ProseMirror mapping sends the
 * end into the gap, and a peer's editor deletes and rewrites the letters of
 * every line between where a line left and where it lands (undo and redo of a
 * move, and a change of a line's type, do the same). The line's id survives
 * all of it. Whatever lies between the two ends is the range.
 *
 * Both ends always sit against a letter: the first one covered and just past
 * the last. A range that reaches into the next line, or past non-text at an
 * edge, is drawn in to its letters wherever a range is written.
 *
 * It is GONE once it covers no letters, its last line is before its first, or
 * a Yjs change deleted the letter an end names and that end's line is no
 * longer there word for word. Nothing is guessed about where changed words
 * went.
 * Posting then would put the reader's words in a thread pointing at nothing,
 * or at other words, which is what A21 is about — the draft card keeps its
 * place in the panel and says so instead, keeping what the reader wrote.
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
import * as Y from 'yjs';

import {
  READING_CLASS,
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

/**
 * The open draft's range as it stood right before a Yjs transaction, with the
 * opening it was taken for.
 */
interface HeldAcrossYjs {
  readonly opening: DraftOpening;
  readonly tracked: TrackedLink;
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

/** The line one end of a range sits in, as it stood, and where in it. */
interface EndLine {
  /** The id of the row the line belongs to. */
  readonly id: string;
  /** Its words, one character per position. */
  readonly words: string;
  /** Where the end sits in the line. */
  readonly offset: number;
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
 * The line a position sits in.
 * @param doc - The body.
 * @param pos - The position.
 * @returns The line and where the position is in it, or null outside a
 *   row's line.
 */
function endLineAt(doc: ProseMirrorNode, pos: number): EndLine | null {
  if (pos < 0 || pos > doc.content.size) return null;
  const at = doc.resolve(pos);
  if (!at.parent.isTextblock || at.depth < 1) return null;
  const id: unknown = at.node(at.depth - 1).attrs['id'];
  return typeof id === 'string'
    ? { id, words: wordsBetween(doc, at.start(), at.end()), offset: at.parentOffset }
    : null;
}

/**
 * Where an end is after a change, found again by its line: the row with the
 * line's id, still word for word the same, at the same offset in it. The way
 * BlockNote keeps a selection across a block move (`moveBlocks.ts`,
 * `getBlockSelectionData`), each end on its own.
 * @param doc - The body after the change.
 * @param line - The line the end sat in before it.
 * @returns The position, or null when the line is gone or changed.
 */
function lineStill(doc: ProseMirrorNode, line: EndLine | null): number | null {
  if (line === null) return null;
  const row = rowById(doc, line.id);
  const words = row === undefined ? undefined : contentRangeOf(row);
  return words !== undefined &&
    wordsBetween(doc, words.from, words.to) === line.words
    ? words.from + line.offset
    : null;
}

/**
 * Whether a position still sits in the line an end sat in.
 * @param doc - The body after the change.
 * @param pos - The position.
 * @param line - The line.
 * @returns True when it is in a line of that row.
 */
function inLine(doc: ProseMirrorNode, pos: number, line: EndLine): boolean {
  return endLineAt(doc, pos)?.id === line.id;
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

/** One end of a range after a Yjs change. */
interface EndAfterYjs {
  /** Where Yjs resolves it, or null outside the body. */
  readonly at: number | null;
  /** Whether the letter it named was deleted. */
  readonly deleted: boolean;
}

/**
 * Reads one end of the range after a Yjs change.
 * @param bound - The sync binding, rebuilt to the body after the change.
 * @param end - The end as it was named before the change.
 * @returns Where it is and what became of its letter.
 */
function endAfterYjs(bound: Binding, end: Y.RelativePosition): EndAfterYjs {
  const at = relativePositionToAbsolutePosition(
    bound.doc,
    bound.type,
    end,
    bound.mapping,
  );
  const deleted =
    end.item !== null && Y.getItem(bound.doc.store, end.item).deleted;
  return { at, deleted };
}

/**
 * Carries the range across a change that came in through Yjs, each end on its
 * own: where Yjs puts it while the letter it names stands, otherwise found
 * again by its line.
 * @param tr - The transaction the change arrived in.
 * @param bound - The sync binding, rebuilt to the body after the change.
 * @param held - What was taken before the change.
 * @param range - The range before the change.
 * @returns Where the range is now, or null once an end is lost.
 */
function carryAcrossYjs(
  tr: Transaction,
  bound: Binding,
  held: HeldAcrossYjs,
  range: DraftRange,
): DraftRange | null {
  const start = endAfterYjs(bound, held.tracked.start);
  const end = endAfterYjs(bound, held.tracked.end);
  const from = start.deleted
    ? lineStill(tr.doc, endLineAt(tr.before, range.from))
    : start.at;
  const to = end.deleted
    ? lineStill(tr.doc, endLineAt(tr.before, range.to))
    : end.at;
  return from !== null && to !== null && to > from ? { from, to } : null;
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
 * its own: where ProseMirror maps it while it stays in its line, otherwise
 * found again by its line. A line moved is taken out and put back, which
 * mapping reads as a deletion; a line the reader deleted or changed is gone,
 * and the mapped position — the range drawn in, or nothing left — stands.
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
    const line = endLineAt(tr.before, pos);
    // An end still in its line is where mapping puts it; asking the line
    // would give the same answer after walking the body for its row.
    return line === null || inLine(tr.doc, mapped, line)
      ? mapped
      : lineStill(tr.doc, line) ?? mapped;
  };
  const from = carry(range.from, 1);
  const to = carry(range.to, -1);
  return to <= from ? null : { from, to };
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
  const bound = syncBindingOf(before);
  // The binding has rebuilt its index to the new nodes before it dispatches
  // (`_typeChanged`), so the relative positions resolve against this change.
  const carried =
    sync?.isChangeOrigin === true &&
    held?.opening === current.opening &&
    bound !== null
      ? carryAcrossYjs(tr, bound, held, current)
      : mapDraftRange(current, tr);
  const moved = carried === null ? null : letterBounds(tr.doc, carried);
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
            if (held !== null || doc === undefined) return;
            const range = draftRangeIn(view.state);
            const bound = syncBindingOf(view.state);
            if (range === null || bound === null) return;
            held = {
              opening: range.opening,
              tracked: trackDraft(bound, range),
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
