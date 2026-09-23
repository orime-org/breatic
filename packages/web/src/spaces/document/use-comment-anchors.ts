// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Where each comment's words are down the body (#18, user 2026-09-22).
 *
 * The panel reads across from the body — a run commented halfway down has its
 * card halfway down — and this is the measurement that makes that possible:
 * for every thread, where down the panel its card belongs.
 *
 * MEASURED AGAINST THE COLUMN THE CARDS ARE PLACED IN, so the number handed
 * back is the card's `top` and nothing has to be added to it. Both rectangles
 * are viewport ones taken in the same frame and both move with the scroll, so
 * the difference between them holds at any scroll position — and the column
 * and the body share one scroller, which is what makes that true.
 *
 * Deriving the origin any other way means assuming what sits above the
 * column: the panel's own header is 40px of it, and a card measured against
 * the scroller's content top came out that much high.
 *
 * What is measured is the START of a thread's first stretch, which is where
 * the eye goes: a comment covering three paragraphs is read from its first
 * word, and its card belongs beside that word.
 */

import * as React from 'react';

import { threadRangesByThread } from '@web/spaces/document/document-comment-ranges';
import type { ToolEditor } from '@web/spaces/document/document-tool-button';

/** Nothing measured, one object for every such answer. */
const NOTHING: ReadonlyMap<string, number> = new Map();

/**
 * The scroll container the body sits in, as the editor stands.
 * @param editor - The document editor.
 * @returns That element, or null before the editor is mounted.
 */
export function bodyScrollerOf(editor: ToolEditor): HTMLElement | null {
  const dom = (editor as unknown as { domElement?: HTMLElement }).domElement;
  return dom?.closest<HTMLElement>('[data-radix-scroll-area-viewport]') ?? null;
}

/**
 * How far each thread's words sit from the top of the body's content.
 * @param editor - The document editor.
 * @param threadIds - The threads to measure, in any order.
 * @param column - The element the cards are positioned inside.
 * @returns Each thread's top, by id; absent for one with no words left.
 */
export function useCommentAnchors(
  editor: ToolEditor,
  threadIds: readonly string[],
  column: React.RefObject<HTMLElement | null>,
): ReadonlyMap<string, number> {
  const [anchors, setAnchors] = React.useState(NOTHING);
  // The ids as one string, so an effect can depend on WHICH threads rather
  // than on the identity of the array holding them.
  const key = threadIds.join(',');

  // Before paint, for the same reason `PlacedCard` takes a card's height
  // before paint: a frame with these missing hands `layOutCards` no anchors
  // at all, which stacks every card from the top of the column — and the
  // cards animate their `top`, so the reader watches them slide into place
  // (measured 2026-09-23: three cards painted at 11 and 141 before sliding
  // to 384 and 913).
  React.useLayoutEffect(() => {
    /** Measures every thread and keeps the answer if it moved. */
    const measure = (): void => {
      const view = editor.prosemirrorView;
      const origin = column.current;
      if (view === null || origin === null) return;
      const top = origin.getBoundingClientRect().top;
      const next = new Map<string, number>();
      // One walk for every thread: this runs on each settle, and per-thread
      // it was one full walk of the document each.
      const ranges = threadRangesByThread(view.state.doc);
      key
        .split(',')
        .filter((id) => id.length > 0)
        .forEach((id) => {
          const at = ranges.get(id)?.[0];
          if (at === undefined) return;
          // `coordsAtPos` throws for a position the view has not laid out,
          // which happens for a moment after a peer's delete arrives.
          try {
            next.set(id, view.coordsAtPos(at.from).top - top);
          } catch {
            // Leaving it out reads as a thread with no words, and the next
            // measurement puts it back.
          }
        });
      setAnchors((held) => (sameAnchors(held, next) ? held : next));
    };

    measure();
    const scroller = bodyScrollerOf(editor);
    // The body's own height changes without the text changing — a window
    // resize rewraps every line — so the element is watched as well.
    const sizes = new ResizeObserver(measure);
    if (scroller !== null) sizes.observe(scroller);
    // The document only: a caret move cannot move a thread's words, and
    // subscribing to it costs one full walk of the body per keypress.
    const stop = editor.onChange(measure);
    return () => {
      sizes.disconnect();
      stop();
    };
  }, [editor, key, column]);

  return anchors;
}

/**
 * Whether two measurements would place the cards the same way.
 * @param a - The measurement held.
 * @param b - The one just taken.
 * @returns True when nothing moved.
 */
function sameAnchors(
  a: ReadonlyMap<string, number>,
  b: ReadonlyMap<string, number>,
): boolean {
  if (a.size !== b.size) return false;
  for (const [id, top] of a) {
    if (b.get(id) !== top) return false;
  }
  return true;
}
