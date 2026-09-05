// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * How many source chips the row shows at a given width.
 *
 * jsdom has no layout, so a row that measures itself sees zeroes and takes
 * its unmeasured branch. Every case here hands it the sizes a browser would
 * report -- which is the only way this row's arithmetic is exercised at all.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import { SourceRow } from '@web/pages/project/chat/SourceRow';
import type { ChatSource } from '@web/pages/project/chat/types';

afterEach(() => {
  cleanup();
});

/**
 * A source, numbered.
 * @param n - Which one.
 * @returns The source.
 */
const source = (n: number): ChatSource => ({
  url: `https://s${String(n)}.example`,
  title: `Page ${String(n)}`,
  publisher: `Site${String(n)}`,
  index: n,
});

let layout = { row: 0, widths: [] as readonly number[] };

/**
 * Report the widths a browser would, for the row and for each chip.
 *
 * Each chip reports its own width, and reports it whatever else is drawn
 * beside it: measured in Chrome, five chips whose widths total 384 sit in a
 * 296 row at their full size and overflow it, rather than being squeezed to
 * fit. The row reads real numbers on its first pass because of that.
 * @param next - The row's width and each chip's.
 */
function withLayout(next: { row: number; widths: readonly number[] }): void {
  layout = next;
}

const realRect = Element.prototype.getBoundingClientRect;
vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
  this: Element,
): DOMRect {
  const strip = this.parentElement;
  if (this.getAttribute('data-testid') !== 'source-chip' || strip === null) {
    return { ...realRect.call(this), width: layout.row } as DOMRect;
  }
  const at = [...strip.children].indexOf(this);
  return { ...realRect.call(this), width: layout.widths[at] ?? 0 } as DOMRect;
});

describe('a row of source chips', () => {
  it('draws them all when they all fit', () => {
    // 3 × 60 + 2 × 8 = 196, inside 296. Nothing to hide, so no button.
    withLayout({ row: 296, widths: [60, 60, 60] });
    render(<SourceRow sources={[1, 2, 3].map(source)} />);

    expect(screen.getAllByTestId('source-chip')).toHaveLength(3);
    expect(screen.queryByTestId('source-row-more')).toBeNull();
  });

  it('keeps as many as fit beside the button, not just one', () => {
    // 296 room, 28 for the button and a gap: 5 × 60 + 4 × 8 = 332 is too much,
    // 3 × 60 + 2 × 8 + 8 + 28 = 232 fits.
    withLayout({ row: 296, widths: [60, 60, 60, 60, 60] });
    render(<SourceRow sources={[1, 2, 3, 4, 5].map(source)} />);

    expect(screen.getAllByTestId('source-chip')).toHaveLength(3);
    expect(screen.getByTestId('source-row-more')).toHaveTextContent('2');
  });

  it('shows more of them as the column widens', () => {
    withLayout({ row: 616, widths: [60, 60, 60, 60, 60] });
    render(<SourceRow sources={[1, 2, 3, 4, 5].map(source)} />);

    expect(screen.getAllByTestId('source-chip')).toHaveLength(5);
  });

  it('offers no button for the only source there is', () => {
    withLayout({ row: 296, widths: [60] });
    render(<SourceRow sources={[source(1)]} />);

    expect(screen.getAllByTestId('source-chip')).toHaveLength(1);
    expect(screen.queryByTestId('source-row-more')).toBeNull();
  });

  it('counts each name at its own length', () => {
    // The widths Chrome reported for five real publishers. 104 + 93 + 68 with
    // gaps is 281, and the button no longer fits after it; two of them and
    // the button come to 241.
    withLayout({ row: 296, widths: [104, 93, 68, 71, 66] });
    render(<SourceRow sources={[1, 2, 3, 4, 5].map(source)} />);

    expect(screen.getAllByTestId('source-chip')).toHaveLength(2);
    expect(screen.getByTestId('source-row-more')).toHaveTextContent('3');
  });

  it('takes back the ones it hid when the row grows', () => {
    // A pass measures only what it draws, so the widths of the hidden ones
    // survive from the pass that did draw them. Without that the row could
    // only ever count what is on screen, and hiding one would hide it for
    // good however wide the column became.
    withLayout({ row: 296, widths: [104, 93, 68, 71, 66] });
    const { rerender } = render(<SourceRow sources={[1, 2, 3, 4, 5].map(source)} />);
    expect(screen.getAllByTestId('source-chip')).toHaveLength(2);

    withLayout({ row: 616, widths: [104, 93, 68, 71, 66] });
    rerender(<SourceRow sources={[1, 2, 3, 4, 5].map(source)} />);

    expect(screen.getAllByTestId('source-chip')).toHaveLength(5);
    expect(screen.queryByTestId('source-row-more')).toBeNull();
  });

  it('leaves nothing drawn that the row does not show', () => {
    // What is hidden is not rendered, so it takes no tab stop and no
    // announcement -- clipping paint leaves both behind.
    withLayout({ row: 296, widths: [60, 60, 60, 60, 60, 60, 60, 60] });
    render(<SourceRow sources={[1, 2, 3, 4, 5, 6, 7, 8].map(source)} />);

    expect(screen.getAllByTestId('source-chip').length).toBeLessThan(8);
  });
});
