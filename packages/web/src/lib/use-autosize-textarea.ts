// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';

/**
 * Hold onto where every scroller above an element is scrolled to.
 *
 * Returns the way to put them back. Measuring a box by letting it shrink is
 * a real layout while it lasts, and a scroller whose content just got
 * shorter has its position clamped to what is left -- it does not come back
 * when the height does. `autosize` keeps the same list for the same reason
 * (`cacheScrollTops`, "ensure the scrollTop values of parent elements are
 * not modified as a consequence of shrinking the textarea height"), down to
 * turning off smooth scrolling for the restore: a scroller told to animate
 * would spend the next frames travelling back rather than being back.
 * @param from - The element about to change height.
 * @returns Puts every position held back where it was.
 */
function holdScrollPositions(from: HTMLElement): () => void {
  const held: [HTMLElement, number][] = [];
  for (let el = from.parentElement; el !== null; el = el.parentElement) {
    if (el.scrollTop !== 0) held.push([el, el.scrollTop]);
  }
  return () => {
    for (const [el, top] of held) {
      const behaviour = el.style.scrollBehavior;
      el.style.scrollBehavior = 'auto';
      el.scrollTop = top;
      el.style.scrollBehavior = behaviour;
    }
  };
}

/**
 * Give a textarea exactly the height of what is written in it.
 *
 * The reason is whose scrollbar the reader sees. A textarea left to scroll
 * itself draws the browser's, which is a different shape in every engine, and
 * the app owns every visible scroller through `ScrollArea` (`index.css`, the
 * scrollbar section). A box that is always as tall as its content never
 * scrolls, so the cap and the scrollbar both belong to a `ScrollArea` wrapped
 * around it — put the same `max-h-*` on the wrapper and its viewport.
 *
 * Reset to `auto` before measuring, because `scrollHeight` on an element
 * already given a height reports that height, so a box that has grown would
 * never shrink again. The shrink is a real layout while it lasts, which is
 * what {@link holdScrollPositions} is for: measured with the box 675px in a
 * 100px wrapper, the wrapper went 574.5 to 0 at `height = 'auto'` and stayed
 * there, and what it cost was the caret the browser had just scrolled to.
 *
 * A `ResizeObserver` refits on width, since the same words take a different
 * number of lines at a different width and the panels this sits in are
 * resizable.
 * @param box - The textarea to size, or a ref that is null before it mounts.
 * @param value - What is written in it; a change refits.
 */
export function useAutosizeTextarea(
  box: React.RefObject<HTMLTextAreaElement | null>,
  value: string,
): void {
  React.useLayoutEffect(() => {
    const el = box.current;
    if (el === null) return undefined;
    /** Take the height of what is written, at the width there is. */
    const fit = (): void => {
      const restore = holdScrollPositions(el);
      el.style.height = 'auto';
      el.style.height = `${String(el.scrollHeight)}px`;
      restore();
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    return () => observer.disconnect();
  }, [box, value]);
}
