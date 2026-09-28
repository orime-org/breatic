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
 * A peer's editor writes some changes by deleting text and writing it again:
 * splitting a line, joining two, changing a block's type, moving a block. A
 * Yjs position on a deleted letter resolves to where that letter was, so an
 * end whose letter was rewritten no longer names the words. When an end's
 * letter was deleted, the words are found again the way web annotations are
 * re-anchored (`document-comment-quote.ts`): by the words, what stood around
 * them and how far into the body they were, scored the way the Hypothesis
 * client scores them. A run is taken only where the letter at each deleted
 * end was written by this very change and each end that stands is met. When
 * no run qualifies, each end stays where Yjs puts it, and a deleted end is
 * brought in past the letters this change wrote: what lies between is what
 * was there before, and letters written against the edge are not the
 * reader's, whichever way they arrive.
 *
 * Both ends always sit against a letter: the first one covered and just past
 * the last. A range that reaches into the next line, or past non-text at an
 * edge, is drawn in to its letters wherever a range is written.
 *
 * It is GONE once it covers no letters: every character it covered has been
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
  QUOTE_CONTEXT_LENGTH,
  rankQuoteCandidates,
  type Quote,
} from '@web/spaces/document/document-comment-quote';

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

/** The sync binding, as a position conversion takes it. */
type Binding = NonNullable<ReturnType<typeof syncBindingOf>>;

/**
 * The open draft's range as it stood right before a Yjs transaction, with the
 * opening it was taken for.
 */
interface HeldAcrossYjs {
  readonly opening: DraftOpening;
  readonly tracked: TrackedLink;
  /** The words it covered and where they stood. */
  readonly quote: Quote;
  /** How far each client's writes reached; anything past is this change's. */
  readonly written: ReadonlyMap<number, number>;
}

/** The body's letters run together across lines, with where each one sits. */
interface BodyLetters {
  readonly text: string;
  /** The body position right before each letter. */
  readonly at: readonly number[];
}

/**
 * Reads the body's letters.
 * @param doc - The body.
 * @returns Its letters and where each one sits.
 */
function bodyLetters(doc: ProseMirrorNode): BodyLetters {
  let text = '';
  const at: number[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText) return true;
    text += node.text ?? '';
    for (let i = 0; i < node.nodeSize; i += 1) at.push(pos + i);
    return false;
  });
  return { text, at };
}

/**
 * The words a range covers and what stood around them.
 * @param letters - The body's letters.
 * @param range - The range, against its letters.
 * @returns The quote.
 */
function quoteOf(letters: BodyLetters, range: DraftRange): Quote {
  const start = letters.at.indexOf(range.from);
  const end = letters.at.indexOf(range.to - 1) + 1;
  return {
    exact: letters.text.slice(start, end),
    prefix: letters.text.slice(Math.max(0, start - QUOTE_CONTEXT_LENGTH), start),
    suffix: letters.text.slice(end, end + QUOTE_CONTEXT_LENGTH),
    start,
  };
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
 * Whether the letter at a body position was written by the change in hand.
 * @param bound - The sync binding, rebuilt to the body after the change.
 * @param pos - The position right before the letter.
 * @param written - How far each client's writes reached before the change.
 * @returns True for a letter this change wrote.
 */
function writtenNow(
  bound: Binding,
  pos: number,
  written: ReadonlyMap<number, number>,
): boolean {
  const { item } = absolutePositionToRelativePosition(
    pos,
    bound.type,
    bound.mapping,
  ) as Y.RelativePosition;
  return item !== null && item.clock >= (written.get(item.client) ?? 0);
}

/**
 * Finds the words again after a change that deleted the letter an end named:
 * the best-scoring run of the body that this change wrote at every such end,
 * and that still meets every end that stands.
 * @param doc - The body after the change.
 * @param bound - The sync binding, rebuilt to that body.
 * @param held - What was taken before the change.
 * @param start - The start after the change.
 * @param end - The end after the change.
 * @returns The words where they are now, or null when there is no such run.
 */
function reanchor(
  doc: ProseMirrorNode,
  bound: Binding,
  held: HeldAcrossYjs,
  start: EndAfterYjs,
  end: EndAfterYjs,
): DraftRange | null {
  const letters = bodyLetters(doc);
  for (const candidate of rankQuoteCandidates(letters.text, held.quote)) {
    const from = letters.at[candidate.start]!;
    const to = letters.at[candidate.end - 1]! + 1;
    const fits =
      (start.deleted ? writtenNow(bound, from, held.written) : from === start.at) &&
      (end.deleted ? writtenNow(bound, to - 1, held.written) : to === end.at);
    if (fits) return { from, to };
  }
  return null;
}

/**
 * Where the range is when its words were not found again: each end where Yjs
 * puts it, and an end whose letter was deleted brought in past the letters
 * this change wrote. Yjs puts a deleted letter where it was, so what lies
 * between is what was there before; letters written against that edge by the
 * same change — a peer's retyped copy of a line, or words typed at the edge —
 * are not the reader's (§9.4).
 * @param doc - The body after the change.
 * @param bound - The sync binding, rebuilt to that body.
 * @param held - What was taken before the change.
 * @param start - The start after the change.
 * @param end - The end after the change.
 * @returns The range, or null once nothing of it is left.
 */
function whatStayed(
  doc: ProseMirrorNode,
  bound: Binding,
  held: HeldAcrossYjs,
  start: EndAfterYjs,
  end: EndAfterYjs,
): DraftRange | null {
  if (start.at === null || end.at === null) return null;
  const { at } = bodyLetters(doc);
  const inside = at.filter((pos) => pos >= start.at! && pos < end.at!);
  let first = 0;
  let last = inside.length - 1;
  while (
    start.deleted &&
    first <= last &&
    writtenNow(bound, inside[first]!, held.written)
  ) {
    first += 1;
  }
  while (
    end.deleted &&
    last >= first &&
    writtenNow(bound, inside[last]!, held.written)
  ) {
    last -= 1;
  }
  return first > last ? null : { from: inside[first]!, to: inside[last]! + 1 };
}

/**
 * Carries the range across a change that came in through Yjs.
 * @param doc - The body after the change.
 * @param bound - The sync binding, rebuilt to that body.
 * @param held - What was taken before the change.
 * @returns Where the range is now, or null once its letters are gone.
 */
function carryAcrossYjs(
  doc: ProseMirrorNode,
  bound: Binding,
  held: HeldAcrossYjs,
): DraftRange | null {
  const start = endAfterYjs(bound, held.tracked.start);
  const end = endAfterYjs(bound, held.tracked.end);
  const found =
    start.deleted || end.deleted
      ? reanchor(doc, bound, held, start, end)
      : null;
  return found ?? whatStayed(doc, bound, held, start, end);
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
      ? carryAcrossYjs(tr.doc, bound, held)
      : mapDraftRange(current, tr.mapping);
  const moved = carried === null ? null : letterBounds(tr.doc, carried);
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
              return { kind: 'aimed', ...aim, opening };
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
              quote: quoteOf(bodyLetters(view.state.doc), range),
              written: Y.decodeStateVector(Y.encodeStateVector(doc)),
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
