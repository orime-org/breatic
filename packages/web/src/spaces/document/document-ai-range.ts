// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The AI output dialog's original range (inner#1860, design §5.4, §6.3): the
 * words the reader selected when the dialog opened, followed while it stays
 * open, through the same local-range carrying the unposted comment uses
 * (`document-local-range.ts`), in an instance of its own.
 *
 * present → gone once no letter is left, by the reader's own edit or one that
 * comes in through Yjs. Gone stays gone, even when undo writes the words back:
 * the comment draft's rule, and replace is then not offered again for words
 * the reader may since have moved on from.
 *
 * While the dialog is open the words keep the body's selected look (design
 * §5.3): the reader's own selection moves on, so the range wears the
 * `[data-show-selection]` stand-in the link panel's words wear (`index.css`).
 */

import { createExtension } from '@blocknote/core';
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

import {
  aimAt,
  changesText,
  localRangeTracker,
  type LocalRange,
} from '@web/spaces/document/document-local-range';
import { bodyHolds } from '@web/spaces/document/document-body-focus';
import { watchPluginState } from '@web/spaces/document/document-plugin-watch';

/** The original range: on its words, or gone. */
export type AiRange =
  | { readonly kind: 'present'; readonly segments: readonly LocalRange[]; readonly entry: number }
  | { readonly kind: 'gone' };

/** What a caller dispatches under the key: stretches open the range, `null` closes it. */
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
 * The range while it is on its words.
 * @param state - The editor state.
 * @returns It, or null when gone or not open.
 */
function presentIn(state: EditorState): (AiRange & { kind: 'present' }) | null {
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
  const parts = range.segments.flatMap(({ from, to }) => (drawn === null
    ? [{ from, to }]
    : [{ from, to: Math.min(to, drawn.from) }, { from: Math.max(from, drawn.to), to }]));
  return DecorationSet.create(
    state.doc,
    parts
      .filter(({ from, to }) => to > from)
      .map(({ from, to }) => Decoration.inline(from, to, { 'data-show-selection': 'true' })),
  );
}

/** The broadcast for the range: opening and closing it dispatch nothing but the meta. */
const watch = watchPluginState(aiRangeIn);

/** Hear about every change to the range. */
export const onAiRangeChange: (listener: () => void) => () => void = watch.onChange;

/**
 * The extension that keeps the AI dialog's original range on its words.
 * @returns The extension, for the assembly to register.
 */
export const documentAiRange = createExtension(() => {
  const tracker = localRangeTracker(presentIn);
  return {
    key: 'document-ai-range',
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
              const segments = aimAt(tr.doc, asked);
              entries += 1;
              return segments.length === 0 ? { kind: 'gone' } : { kind: 'present', segments, entry: entries };
            }
            if (current?.kind !== 'present' || !changesText(tr)) return current;
            const moved = tracker.carry(tr, current, before);
            if (moved.length === 0) return { kind: 'gone' };
            return moved === current.segments ? current : { ...current, segments: moved };
          },
        },

        props: {
          decorations: paintRange,
        },

        /**
         * Broadcasts the range, and names it in Yjs terms after every change.
         * @param view - The editor view.
         * @returns The view's update and teardown.
         */
        view: (view) => {
          const watching = watch.view(view);
          const naming = tracker.view(view);
          return {
            update: (next, prev): void => {
              naming.update(next, prev);
              watching.update?.(next, prev);
            },
            destroy: (): void => {
              naming.destroy();
              watching.destroy?.();
            },
          };
        },
      }),
    ],
  };
});
