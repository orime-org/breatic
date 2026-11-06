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
 * joined or moved. Words the reader types among or over a unit's words are
 * not its words: the stretch they go in or write over is taken out of it,
 * the pieces left staying the unit's. A unit whose pieces are all gone has
 * no words left; the range is gone with
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
import { Mapping } from '@tiptap/pm/transform';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

import {
  changesText,
  letterBounds,
  localRangeTracker,
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
      /**
       * The units' pieces as carried, null where one is gone: a piece keeps
       * its place, and a piece cut off goes at the end, so the names an undo
       * hands back still fit the pieces they were taken for.
       */
      readonly slots: readonly (LocalRange | null)[];
      /** Which unit each piece is of: its index in the stretches the range opened on. */
      readonly owners: readonly number[];
      /** How many units the range opened on. */
      readonly units: number;
      readonly entry: number;
    }
  | { readonly kind: 'gone' };

/** The range while it is on its words. */
type PresentRange = AiRange & { kind: 'present' };

/** Each unit's words where they are now, by its index in the stretches the range opened on; none for a unit whose words are gone. */
export type AiUnitRanges = readonly (readonly LocalRange[])[];

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
 * @param slots - The pieces, null where one is gone.
 * @param owners - Which unit each piece is of.
 * @param units - How many units there are.
 * @param entry - The press that aimed it.
 * @returns The range.
 */
function rangeOver(slots: readonly (LocalRange | null)[], owners: readonly number[], units: number, entry: number): AiRange {
  return slots.every((piece) => piece === null) ? { kind: 'gone' } : { kind: 'present', slots, owners, units, entry };
}

/**
 * Each unit's words where they are now.
 * @param state - The editor state.
 * @returns Every unit's words; none at all while the range is gone or not open.
 */
export function aiUnitRangesIn(state: EditorState): AiUnitRanges {
  const range = presentIn(state);
  return range === null ? [] : byUnit(range.slots, range.owners, range.units);
}

/** Stands in for a leaf node when the words of two stretches are compared. */
const LEAF = '\ufffc';

/**
 * The stretches of the body before the reader's own change that it put
 * content in at, or wrote other words over. A stretch written over with the
 * same words, as BlockNote rebuilds a line with marks or links when it turns
 * into code, is no change to them.
 * @param tr - The change.
 * @returns The stretches, in the body before it.
 */
function changedIn(tr: Transaction): LocalRange[] {
  const out: LocalRange[] = [];
  tr.mapping.maps.forEach((map, index) => {
    const input = tr.docs[index]!;
    const output = tr.docs[index + 1] ?? tr.doc;
    const back = new Mapping(tr.mapping.maps.slice(0, index)).invert();
    map.forEach((oldStart, oldEnd, newStart, newEnd) => {
      if (newEnd <= newStart) return;
      if (input.textBetween(oldStart, oldEnd, '\n', LEAF) === output.textBetween(newStart, newEnd, '\n', LEAF)) return;
      out.push({ from: back.map(oldStart, -1), to: back.map(oldEnd, 1) });
    });
  });
  return out;
}

/**
 * The pieces with the stretches the reader's change rewrites taken out, so
 * what it puts in is no unit's word: a piece keeps its place with its first
 * part, or null when nothing of it is left, and each further part goes at
 * the end.
 * @param range - The range before the change.
 * @param tr - The change.
 * @returns The pieces and their units; the range's own when the change rewrites none of its words.
 */
function withoutRewritten(range: PresentRange, tr: Transaction): Pick<PresentRange, 'slots' | 'owners'> {
  let slots = [...range.slots];
  let owners = [...range.owners];
  let changed = false;
  for (const change of changedIn(tr)) {
    const nextSlots: (LocalRange | null)[] = [];
    const nextOwners: number[] = [];
    const after: Array<[LocalRange, number]> = [];
    slots.forEach((piece, i) => {
      const touches = piece !== null && (change.from === change.to
        ? change.from > piece.from && change.from < piece.to
        : change.from < piece.to && change.to > piece.from);
      if (!touches) {
        nextSlots.push(piece);
        nextOwners.push(owners[i]!);
        return;
      }
      changed = true;
      const parts = [
        ...(change.from > piece.from ? [{ from: piece.from, to: change.from }] : []),
        ...(change.to < piece.to ? [{ from: change.to, to: piece.to }] : []),
      ];
      nextSlots.push(parts[0] ?? null);
      nextOwners.push(owners[i]!);
      for (const part of parts.slice(1)) after.push([part, owners[i]!]);
    });
    slots = [...nextSlots, ...after.map(([part]) => part)];
    owners = [...nextOwners, ...after.map(([, owner]) => owner)];
  }
  return changed ? { slots, owners } : range;
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
  const stretches = byUnit(range.slots, range.owners, range.units).flatMap((words) => words.reduce<LocalRange[]>((joined, piece) => {
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
  const tracker = localRangeTracker(presentIn, inlineLetter);
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
              const slots = asked.map((stretch) => letterBounds(tr.doc, stretch, inlineLetter));
              return rangeOver(slots, asked.map((_, unit) => unit), asked.length, entries);
            }
            if (current?.kind !== 'present' || !changesText(tr)) return current;
            const held = fromYjs(tr) ? current : { ...current, ...withoutRewritten(current, tr) };
            const moved = tracker.carry(tr, held, before);
            if (moved === current.slots) return current;
            return rangeOver(moved, held.owners, current.units, current.entry);
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
