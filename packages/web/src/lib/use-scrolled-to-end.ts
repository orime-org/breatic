// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';

interface ScrolledToEndOptions {
  /** There is more to fetch. Nothing is watched when this is false. */
  enabled: boolean;
  /** Called when the end of the list comes into view. */
  onReachEnd: () => void;
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
 * Guarding against asking twice is the caller's: this fires as often as the
 * end stays in view, and only the caller knows whether a request is out.
 * @param options - What to watch, and what to call.
 * @param options.enabled - There is more to fetch.
 * @param options.onReachEnd - Called when the end comes into view.
 * @returns The two refs to place.
 */
export function useScrolledToEnd({
  enabled,
  onReachEnd,
}: ScrolledToEndOptions): ScrolledToEndRefs {
  const [scroller, setScroller] = React.useState<HTMLElement | null>(null);
  const [sentinel, setSentinel] = React.useState<HTMLElement | null>(null);

  React.useEffect(() => {
    const viewport = scroller?.querySelector('[data-radix-scroll-area-viewport]');
    if (!sentinel || !viewport || !enabled) return;

    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) onReachEnd();
      },
      { root: viewport, rootMargin: END_MARGIN },
    );
    io.observe(sentinel);
    return () => io.disconnect();
  }, [scroller, sentinel, enabled, onReachEnd]);

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
