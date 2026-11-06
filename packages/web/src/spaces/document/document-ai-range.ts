// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The AI output dialog's original range (inner#1860, design §5.4, §6.3): the
 * words the reader selected when the dialog opened, followed while it stays
 * open, through the same local-range carrying the unposted comment uses
 * (`document-local-range.ts`), in an instance of its own.
 *
 * The range is one stretch per text unit (`document-ai-units.ts`), each
 * carried on its own, so a unit follows its own words when lines are split,
 * joined or moved. Words the reader types among a unit's words are not its
 * words: the stretch is cut where they go in, the pieces staying the unit's.
 * A unit whose pieces are all gone has no words left; the range is gone with
 * the last of them, by the reader's own edit or one that comes in through
 * Yjs. Gone stays gone, even when undo writes the words back: the comment
 * draft's rule, and replace is then not offered again for words the reader
 * may since have moved on from.
 *
 * While the dialog is open the words keep the body's selected look (design
 * §5.3): the reader's own selection moves on, so the range wears the
 * `[data-show-selection]` stand-in the link panel's words wear (`index.css`).
 *
 * Escape typed in the body closes the open dialog and leaves the keyboard in
 * the body (design §5.3): BlockNote's own Escape would blur the editor and
 * mark the key handled, so the dialog would never hear it. The suggestion
 * menu and the link toolbar answer Escape in the body too, and while one of
 * them is up the key is theirs.
 */

import { createExtension } from '@blocknote/core';
import { SuggestionMenu } from '@blocknote/core/extensions';
import { Plugin, PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

import {
  aimAt,
  changesText,
  localRangeTracker,
  type HeldLocalRange,
  type IsLetter,
  type LocalRange,
} from '@web/spaces/document/document-local-range';
import { documentBarsOf } from '@web/spaces/document/document-bars';
import { bodyHolds } from '@web/spaces/document/document-body-focus';
import { fromYjs } from '@web/spaces/document/document-yjs-origin';

/** The original range: on its words, or gone. */
export type AiRange =
  | {
      readonly kind: 'present';
      /** Each unit's words, in document order: its pieces, those that overlap or touch joined. */
      readonly segments: readonly LocalRange[];
      /**
       * The pieces as carried, null where one is gone: a piece keeps its
       * place, and a piece cut off goes at the end, so the names an undo
       * hands back still fit the pieces they were taken for.
       */
      readonly pieces: readonly (LocalRange | null)[];
      /** Which unit each piece is of: its index in the stretches the range opened on. */
      readonly owners: readonly number[];
      /** How many units the range opened on. */
      readonly units: number;
      readonly entry: number;
    }
  | { readonly kind: 'gone' };

/** The range while it is on its words. */
type PresentRange = AiRange & { kind: 'present' };

/** What a caller dispatches under the key: one stretch per unit opens the range, `null` closes it. */
export type AiRangeCommand = readonly LocalRange[] | null;

/** The plugin's key, which is also the meta an {@link AiRangeCommand} goes under. */
export const DOCUMENT_AI_RANGE = new PluginKey<AiRange | null>('documentAiRange');

/** How many times the range has been opened in this page. */
let entries = 0;

/**
 * The AI dialog's original range.
 * @param state - The editor state.
 * @returns The range, or null while no dialog holds one.
 */
export function aiRangeIn(state: EditorState): AiRange | null {
  return DOCUMENT_AI_RANGE.getState(state) ?? null;
}

/**
 * Each unit's words, by its index in the stretches the range opened on: its
 * pieces in document order, those that overlap or touch joined.
 * @param pieces - The pieces, null where one is gone.
 * @param owners - Which unit each piece is of.
 * @param units - How many units there are.
 * @returns Every unit's words; none for a unit whose pieces are all gone.
 */
function byUnit(pieces: readonly (LocalRange | null)[], owners: readonly number[], units: number): LocalRange[][] {
  const out: LocalRange[][] = Array.from({ length: units }, () => []);
  pieces.forEach((piece, i) => {
    if (piece !== null) out[owners[i]!]!.push(piece);
  });
  return out.map((list) => list.sort((a, b) => a.from - b.from).reduce<LocalRange[]>((joined, piece) => {
    const last = joined[joined.length - 1];
    if (last !== undefined && piece.from <= last.to) joined[joined.length - 1] = { from: last.from, to: Math.max(last.to, piece.to) };
    else joined.push(piece);
    return joined;
  }, []));
}

/**
 * The range over some pieces, or gone once none is left.
 * @param pieces - The pieces, null where one is gone.
 * @param owners - Which unit each piece is of.
 * @param units - How many units there are.
 * @param entry - The press that aimed it.
 * @returns The range.
 */
function rangeOver(pieces: readonly (LocalRange | null)[], owners: readonly number[], units: number, entry: number): AiRange {
  if (pieces.every((piece) => piece === null)) return { kind: 'gone' };
  const segments = byUnit(pieces, owners, units).flat().sort((a, b) => a.from - b.from);
  return { kind: 'present', segments, pieces, owners, units, entry };
}

/**
 * Each unit's words where they are now, by its index in the stretches the
 * range opened on.
 * @param state - The editor state.
 * @returns Every unit's words, none for a unit whose words are gone; none at
 *   all while the range is gone or not open.
 */
export function aiUnitRangesIn(state: EditorState): readonly (readonly LocalRange[])[] {
  const range = presentIn(state);
  return range === null ? [] : byUnit(range.pieces, range.owners, range.units);
}

/**
 * Where the reader's own change put content in, in the body before it.
 * @param tr - The change.
 * @returns The positions.
 */
function insertionsIn(tr: Transaction): number[] {
  const at: number[] = [];
  tr.mapping.maps.forEach((map, index) => {
    const back = tr.mapping.slice(0, index).invert();
    map.forEach((oldStart, _oldEnd, newStart, newEnd) => {
      if (newEnd > newStart) at.push(back.map(oldStart));
    });
  });
  return at;
}

/**
 * The pieces cut where the reader's change puts content in among their
 * words, so what goes in there is no unit's word: a piece keeps its place
 * up to the first cut, and each part after a cut goes at the end.
 * @param range - The range before the change.
 * @param tr - The change.
 * @returns The pieces and their units; the range's own when nothing goes in among its words.
 */
function cutAtInsertions(range: PresentRange, tr: Transaction): Pick<PresentRange, 'pieces' | 'owners'> {
  const at = insertionsIn(tr);
  const pieces = [...range.pieces];
  const owners = [...range.owners];
  range.pieces.forEach((piece, i) => {
    if (piece === null) return;
    const cuts = [...new Set(at.filter((pos) => pos > piece.from && pos < piece.to))].sort((a, b) => a - b);
    if (cuts.length === 0) return;
    pieces[i] = { from: piece.from, to: cuts[0]! };
    cuts.forEach((from, k) => {
      pieces.push({ from, to: cuts[k + 1] ?? piece.to });
      owners.push(range.owners[i]!);
    });
  });
  return pieces.length === range.pieces.length ? range : { pieces, owners };
}

/**
 * The range while it is on its words.
 * @param state - The editor state.
 * @returns It, or null when gone or not open.
 */
function presentIn(state: EditorState): PresentRange | null {
  const range = aiRangeIn(state);
  return range?.kind === 'present' ? range : null;
}

/**
 * The selected look over the range's words, where the reader's own selection
 * does not already draw it: while the body holds the focus its selection is
 * painted too, and the two translucent bands over the same words would draw
 * them darker than either.
 * @param state - The editor state.
 * @returns The stand-in decorations.
 */
function paintRange(state: EditorState): DecorationSet {
  const range = presentIn(state);
  if (range === null) return DecorationSet.empty;
  const { selection } = state;
  const drawn = bodyHolds(state) && !selection.empty ? selection : null;
  // A unit's words in one line are painted as one stretch: replace writes
  // over the words typed among them too.
  const stretches = byUnit(range.pieces, range.owners, range.units).flatMap((words) => words.reduce<LocalRange[]>((joined, piece) => {
    const last = joined[joined.length - 1];
    if (last !== undefined && state.doc.resolve(last.from).sameParent(state.doc.resolve(piece.from))) joined[joined.length - 1] = { from: last.from, to: piece.to };
    else joined.push(piece);
    return joined;
  }, []));
  const parts = stretches.flatMap(({ from, to }) => (drawn === null
    ? [{ from, to }]
    : [{ from, to: Math.min(to, drawn.from) }, { from: Math.max(from, drawn.to), to }]));
  return DecorationSet.create(
    state.doc,
    parts
      .filter(({ from, to }) => to > from)
      .map(({ from, to }) => Decoration.inline(from, to, { 'data-show-selection': 'true' })),
  );
}

/**
 * A unit's letter: text, or an inline node such as a hard break, which is
 * as much the unit's as its words are.
 * @param node - A node.
 * @returns True for one.
 */
const inlineLetter: IsLetter = (node) => node.isText || (node.isInline && node.isLeaf);

/** The range as the tracker carries it, one object per range. */
const helds = new WeakMap<object, HeldLocalRange>();

/**
 * The range as the tracker carries it: its pieces, gone ones included.
 * @param range - The range.
 * @returns The same object for the same range.
 */
function heldOf(range: Pick<PresentRange, 'pieces' | 'entry'>): HeldLocalRange {
  let held = helds.get(range);
  if (held === undefined) {
    held = { segments: range.pieces, entry: range.entry };
    helds.set(range, held);
  }
  return held;
}

/** Who closes the open dialog when Escape is typed in a given editor's body. */
const escapeListeners = new WeakMap<object, Set<() => void>>();

/**
 * Hear Escape typed in this editor's body while its AI dialog is open.
 * @param editor - The document editor.
 * @param listener - Called once per such Escape.
 * @returns Stops hearing.
 */
export function onAiEscape(editor: object, listener: () => void): () => void {
  const listeners = escapeListeners.get(editor) ?? new Set<() => void>();
  escapeListeners.set(editor, listeners);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The extension that keeps the AI dialog's original range on its words.
 * @returns The extension, for the assembly to register.
 */
export const documentAiRange = createExtension(() => {
  const tracker = localRangeTracker((state) => {
    const range = presentIn(state);
    return range === null ? null : heldOf(range);
  }, inlineLetter);
  return {
    key: 'document-ai-range',
    keyboardShortcuts: {
      /**
       * Closes the open dialog; a suggestion menu or the link toolbar that
       * is up keeps the key, one press taking away one thing.
       * @param ctx - The shortcut's context.
       * @param ctx.editor - The editor the key was typed in.
       * @returns True when the key closed a dialog.
       */
      Escape: ({ editor }): boolean => {
        if (aiRangeIn(editor.prosemirrorState) === null) return false;
        if (editor.getExtension(SuggestionMenu)?.shown() === true) return false;
        if (documentBarsOf(editor).linkToolbarUp) return false;
        const listeners = escapeListeners.get(editor);
        if (listeners === undefined || listeners.size === 0) return false;
        listeners.forEach((listener) => {
          listener();
        });
        return true;
      },
    },
    prosemirrorPlugins: [
      new Plugin<AiRange | null>({
        key: DOCUMENT_AI_RANGE,
        state: {
          /**
           * Starts with no range.
           * @returns Null.
           */
          init: (): AiRange | null => null,

          /**
           * Opens, closes, or carries the range across this change.
           * @param tr - The transaction being applied.
           * @param current - The range before it.
           * @param before - The state the transaction applies to.
           * @returns The range after it.
           */
          apply: (tr, current, before): AiRange | null => {
            const asked = tr.getMeta(DOCUMENT_AI_RANGE) as AiRangeCommand | undefined;
            if (asked === null) return null;
            if (asked !== undefined) {
              entries += 1;
              const pieces = asked.map((stretch) => aimAt(tr.doc, [stretch], inlineLetter)[0] ?? null);
              return rangeOver(pieces, asked.map((_, unit) => unit), asked.length, entries);
            }
            if (current?.kind !== 'present' || !changesText(tr)) return current;
            const { pieces, owners } = fromYjs(tr) ? current : cutAtInsertions(current, tr);
            const moved = tracker.carry(tr, heldOf({ ...current, pieces }), before);
            if (moved === pieces && pieces === current.pieces) return current;
            return rangeOver(moved, owners, current.units, current.entry);
          },
        },

        props: {
          decorations: paintRange,
        },

        /**
         * Names the range in Yjs terms after every change.
         * @param view - The editor view.
         * @returns The view's update and teardown.
         */
        view: (view) => tracker.view(view),
      }),
    ],
  };
});
