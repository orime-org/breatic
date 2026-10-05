// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * inner#1126 A21: a table wider than the body shows, on each side that still
 * has more to scroll, an edge; the side scrolled to its end shows none.
 */

import { act, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { DocumentTableScroller, overflowSides } from '@web/spaces/document/document-table-scroller';

describe('which sides of a table frame still have more to scroll', () => {
  it.each([
    ['fits', 0, 400, 400, { left: false, right: false }],
    ['at the start', 0, 1000, 400, { left: false, right: true }],
    ['in the middle', 300, 1000, 400, { left: true, right: true }],
    ['at the end', 600, 1000, 400, { left: true, right: false }],
    ['a fraction short of the end', 599.5, 1000, 400, { left: true, right: false }],
  ] as const)('%s', (_label, scrollLeft, scrollWidth, clientWidth, sides) => {
    expect(overflowSides(scrollLeft, scrollWidth, clientWidth)).toEqual(sides);
  });
});

describe('the table frame', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  /**
   * Gives the frame's viewport a size and a scroll position, and tells it it scrolled.
   * @param viewport - The viewport.
   * @param scrollLeft - Where it is scrolled to.
   */
  function scrollTo(viewport: HTMLElement, scrollLeft: number): void {
    Object.defineProperty(viewport, 'scrollWidth', { configurable: true, value: 1000 });
    Object.defineProperty(viewport, 'clientWidth', { configurable: true, value: 400 });
    viewport.scrollLeft = scrollLeft;
    act(() => {
      viewport.dispatchEvent(new Event('scroll'));
    });
  }

  it('shows an edge on each side that has more to scroll, and none on a side at its end', () => {
    const { container } = render(
      <DocumentTableScroller>
        <div style={{ width: 1000 }} />
      </DocumentTableScroller>,
    );
    const viewport = container.querySelector<HTMLElement>('[data-radix-scroll-area-viewport]')!;
    const edge = (side: string): Element => container.querySelector(`[data-overflow-edge="${side}"]`)!;

    scrollTo(viewport, 0);
    expect([edge('left').hasAttribute('data-on'), edge('right').hasAttribute('data-on')]).toEqual([false, true]);

    scrollTo(viewport, 300);
    expect([edge('left').hasAttribute('data-on'), edge('right').hasAttribute('data-on')]).toEqual([true, true]);

    scrollTo(viewport, 600);
    expect([edge('left').hasAttribute('data-on'), edge('right').hasAttribute('data-on')]).toEqual([true, false]);
  });

  it('draws its edges out of the way of the pointer and of reading', () => {
    const { container } = render(
      <DocumentTableScroller>
        <div />
      </DocumentTableScroller>,
    );
    for (const edge of container.querySelectorAll('[data-overflow-edge]')) {
      expect(edge.getAttribute('aria-hidden')).toBe('true');
    }
  });
});
