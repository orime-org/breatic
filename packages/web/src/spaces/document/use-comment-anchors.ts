// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Where each comment's words are down the body (#18, user 2026-09-22).
 *
 * The panel reads across from the body — a run commented halfway down has its
 * card halfway down — and this is the measurement that makes that possible:
 * for every thread, how far its first mark sits from the top of the body's
 * content.
 *
 * CONTENT COORDINATES, NOT THE VIEWPORT'S. A position measured against the
 * screen changes on every scroll, and the panel would then have to be
 * recomputed at the scroll rate. Measured against the content it changes only
 * when the text does, and the scroll is one number applied to the whole
 * column.
 *
 * What is measured is the START of a thread's first stretch, which is where
 * the eye goes: a comment covering three paragraphs is read from its first
 * word, and its card belongs beside that word.
 */

import * as React from 'react';

import { threadRangesIn } from '@web/spaces/document/document-comment-ranges';
import type { ToolEditor } from '@web/spaces/document/document-tool-button';
import { onEditorSettled } from '@web/spaces/document/use-editor-snapshot';

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
 * @returns Each thread's offset, by id; absent for one with no words left.
 */
export function useCommentAnchors(
  editor: ToolEditor,
  threadIds: readonly string[],
): ReadonlyMap<string, number> {
  const [anchors, setAnchors] = React.useState(NOTHING);
  // The ids as one string, so an effect can depend on WHICH threads rather
  // than on the identity of the array holding them.
  const key = threadIds.join(',');

  React.useEffect(() => {
    /** Measures every thread and keeps the answer if it moved. */
    const measure = (): void => {
      const view = editor.prosemirrorView;
      const scroller = bodyScrollerOf(editor);
      if (view === null || scroller === null) return;
      const top = scroller.getBoundingClientRect().top - scroller.scrollTop;
      const next = new Map<string, number>();
      key
        .split(',')
        .filter((id) => id.length > 0)
        .forEach((id) => {
          const at = threadRangesIn(view.state.doc, id)[0];
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
    const stop = onEditorSettled(editor as never, measure);
    return () => {
      sizes.disconnect();
      stop();
    };
  }, [editor, key]);

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

/**
 * How far the body has been scrolled, kept current.
 * @param editor - The document editor.
 * @returns The scroll offset, zero before the editor is mounted.
 */
export function useBodyScrollTop(editor: ToolEditor): number {
  const [scrolled, setScrolled] = React.useState(0);

  React.useEffect(() => {
    const scroller = bodyScrollerOf(editor);
    if (scroller === null) return;
    /** Reads the offset off the element. */
    const read = (): void => {
      setScrolled(scroller.scrollTop);
    };
    read();
    scroller.addEventListener('scroll', read, { passive: true });
    return () => {
      scroller.removeEventListener('scroll', read);
    };
  }, [editor]);

  return scrolled;
}
