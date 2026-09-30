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
import { domElementOf } from '@web/spaces/document/document-editor-view';
import type { ToolEditor } from '@web/spaces/document/document-tool-button';

/** The draft card's id and where it is aimed. */
export interface DraftAnchor {
  readonly id: string;
  readonly from: number;
}

/** What the hook measured, and for which draft. */
export interface CommentAnchors {
  /** Each thread's top, by id; absent for one with no words left. */
  readonly tops: ReadonlyMap<string, number>;
  /**
   * The draft the tops were measured for. A moved draft keeps its id, so its
   * old top stays in `tops` until the new place is measured; this says which
   * place the number is for.
   */
  readonly measuredFor: DraftAnchor | null;
}

/** Nothing measured, one object for every such answer. */
const NOTHING: CommentAnchors = { tops: new Map(), measuredFor: null };

/**
 * How far each thread's words sit from the top of the body's content.
 *
 * A draft is measured the same way, from the range it is aimed at: it has no
 * mark to walk to yet, and a card with no anchor is one the layout puts at
 * the bottom of the column — the one place a draft must not be (A28).
 * @param editor - The document editor.
 * @param threadIds - The threads to measure, in any order.
 * @param column - The element the cards are positioned inside.
 * @param draft - The draft card's id and where it is aimed, while one is
 *   open. Held steady by the caller: this re-measures whenever it changes,
 *   and a fresh object per render would do that on every keystroke.
 * @returns Each thread's top, and the draft they were measured for.
 */
export function useCommentAnchors(
  editor: ToolEditor,
  threadIds: readonly string[],
  column: React.RefObject<HTMLElement | null>,
  draft: DraftAnchor | null = null,
): CommentAnchors {
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
      const stale: string[] = [];
      if (draft !== null) {
        try {
          next.set(draft.id, view.coordsAtPos(draft.from).top - top);
        } catch {
          // Same reason as below: a position the view has not laid out yet.
          stale.push(draft.id);
        }
      }
      // One walk for every thread: this runs on each settle, and per-thread
      // it was one full walk of the document each.
      const ranges = threadRangesByThread(view.state.doc);
      key
        .split(',')
        .filter((id) => id.length > 0)
        .forEach((id) => {
          const at = ranges.get(id)?.[0];
          // Absent from the ranges means no words left; such a thread is
          // not on the panel (A13).
          if (at === undefined) return;
          try {
            next.set(id, view.coordsAtPos(at.from).top - top);
          } catch {
            // `coordsAtPos` throws for a position the view has not laid out,
            // which happens for a moment after a peer's delete arrives. The
            // thread still has its words, and the card still shows the quote
            // it took from them — dropping it here would slide that card to
            // the bottom of the panel, where the layout puts a card with no
            // anchor, and nothing would bring it back until the reader typed.
            stale.push(id);
          }
        });
      setAnchors((held) => {
        stale.forEach((id) => {
          const last = held.tops.get(id);
          if (last !== undefined) next.set(id, last);
        });
        const tops = sameAnchors(held.tops, next) ? held.tops : next;
        // A draft whose place was not laid out kept its old top, which is
        // still the one for the draft last measured.
        const measuredFor =
          draft !== null && stale.includes(draft.id) ? held.measuredFor : draft;
        return tops === held.tops && held.measuredFor === measuredFor
          ? held
          : { tops, measuredFor };
      });
    };

    measure();
    // The body element, not the scroller it sits in. Text moves without the
    // text changing — a window resize rewraps every line, the panel opening
    // narrows the column, a web font arriving reflows the lot — and the
    // scroller's own box holds still through the last two of those.
    const body = domElementOf(editor);
    const sizes = new ResizeObserver(measure);
    if (body !== null) sizes.observe(body);
    // The document only: a caret move cannot move a thread's words, and
    // subscribing to it costs one full walk of the body per keypress.
    const stop = editor.onChange(measure);
    return () => {
      sizes.disconnect();
      stop();
    };
  }, [editor, key, column, draft]);

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
