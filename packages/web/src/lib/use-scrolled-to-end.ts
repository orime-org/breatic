// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';

interface ScrolledToEndOptions {
  /** There is more to fetch. Nothing is watched when this is false. */
  enabled: boolean;
  /** Called when the end of the list comes into view, or scrolled to again. */
  onReachEnd: () => void;
  /**
   * How many rows are listed right now.
   *
   * Read only to notice that it changed. Coming into view happens once, and a
   * page that does not fill the window leaves the end in view for good -- no
   * second crossing, so nothing more is ever asked for and the reader has
   * nothing left to scroll. A fresh watcher reports where things stand as it
   * starts, so rebuilding it when rows arrive is what asks again while the end
   * is still there. It stops on its own: the last page turns `enabled` off.
   */
  itemCount?: number;
  /**
   * The last attempt did not arrive.
   *
   * Changes what is watched, not just when. An end already in view stays in
   * view when an attempt fails -- nothing moved -- so a watcher for it would
   * report the same thing the instant it started, and asking again would be
   * the failure's own doing rather than the reader's. While this is true the
   * end is not watched at all; a scroll is, and that is a thing only the
   * reader can do.
   */
  failed?: boolean;
}

interface ScrolledToEndRefs {
  /**
   * Goes on the element wrapping the `ScrollArea`, not the scroller itself.
   *
   * Radix stamps `[data-radix-scroll-area-viewport]` on the element that
   * actually scrolls, one level in, so the viewport is found from here rather
   * than by extending the shared primitive with a ref of its own.
   */
  scrollerRef: (node: HTMLElement | null) => void;
  /** Goes on an empty element after the last row. */
  sentinelRef: (node: HTMLElement | null) => void;
}

/**
 * Ask for more as the reader reaches the end of a scrolling list.
 *
 * What is watched is an element after the last row coming into view, not a
 * scroll offset: an offset has to be compared against a height, and the height
 * is wrong for exactly as long as the rows that just arrived have not been
 * laid out yet.
 *
 * Both refs are callbacks rather than ref objects, and that is load-bearing.
 * A list inside a Radix overlay is mounted by `Presence` a beat after the
 * component around it renders, so an effect reading `ref.current` finds null,
 * returns, and -- its dependencies never having changed -- never runs again:
 * the observer is never built and the list never pages. Taking the nodes as
 * state means the subscription happens when they actually arrive.
 *
 * Rows arriving rebuild the watcher, which is what carries a list that does not
 * fill its window past its second page: the end came into view once and stayed
 * there, and a watcher only reports crossings.
 *
 * After a failure it watches for a scroll instead. The end being in view is a
 * state, and a state that a failure leaves untouched: watching it again would
 * report it again immediately, and the next request would be the failure's own
 * doing. A scroll is an event, and one only the reader produces.
 *
 * That leaves one case with no way to ask again: a list too short to scroll,
 * whose page failed. Reaching the end is the only way to ask, and a list that
 * cannot move cannot be reached again. It takes a window taller than a full
 * page of rows plus a failed page to get there. Opening the list again -- or the project --
 * fetches it afresh.
 *
 * Guarding against asking twice is the caller's: this fires as often as the
 * end stays in view, and only the caller knows whether a request is out.
 * @param options - What to watch, and what to call.
 * @param options.enabled - There is more to fetch.
 * @param options.onReachEnd - Called when the end comes into view, or is scrolled to again.
 * @param options.itemCount - How many rows are listed right now.
 * @param options.failed - The last attempt did not arrive.
 * @returns The two refs to place.
 */
export function useScrolledToEnd({
  enabled,
  onReachEnd,
  itemCount = 0,
  failed = false,
}: ScrolledToEndOptions): ScrolledToEndRefs {
  const [scroller, setScroller] = React.useState<HTMLElement | null>(null);
  const [sentinel, setSentinel] = React.useState<HTMLElement | null>(null);

  React.useEffect(() => {
    const viewport = scroller?.querySelector('[data-radix-scroll-area-viewport]');
    if (!sentinel || !viewport || !enabled) return;

    if (failed) {
      /**
       * The reader has moved, which is them asking again.
       * @returns Nothing.
       */
      const moved = (): void => onReachEnd();
      viewport.addEventListener('scroll', moved, { passive: true, once: true });
      return () => viewport.removeEventListener('scroll', moved);
    }

    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) onReachEnd();
      },
      { root: viewport, rootMargin: END_MARGIN },
    );
    io.observe(sentinel);
    return () => io.disconnect();
  }, [scroller, sentinel, enabled, failed, itemCount, onReachEnd]);

  return { scrollerRef: setScroller, sentinelRef: setSentinel };
}

/**
 * How far before the end of the list to start fetching the next page.
 *
 * Enough that the rows usually arrive before the reader reaches where they go,
 * and not so much that a list barely taller than its window asks for more the
 * moment it is opened.
 */
const END_MARGIN = '80px';
