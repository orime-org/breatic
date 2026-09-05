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
  vi.restoreAllMocks();
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

/**
 * Report the widths a browser would, for the row and for each chip.
 * @param root0 - The sizes.
 * @param root0.row - How wide the row is.
 * @param root0.chip - How wide one chip is.
 */
function withLayout({ row, chip }: { row: number; chip: number }): void {
  const real = Element.prototype.getBoundingClientRect;
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: Element,
  ): DOMRect {
    const isChip = this.getAttribute('data-testid') === 'source-chip';
    return { ...real.call(this), width: isChip ? chip : row } as DOMRect;
  });
}

describe('a row of source chips', () => {
  it('draws them all when they all fit', () => {
    // 3 × 60 + 2 × 8 = 196, inside 296. Nothing to hide, so no button.
    withLayout({ row: 296, chip: 60 });
    render(<SourceRow sources={[1, 2, 3].map(source)} />);

    expect(screen.getAllByTestId('source-chip')).toHaveLength(3);
    expect(screen.queryByTestId('source-row-more')).toBeNull();
  });

  it('keeps as many as fit beside the button, not just one', () => {
    // 296 room, 28 for the button and a gap: 5 × 60 + 4 × 8 = 332 is too much,
    // 3 × 60 + 2 × 8 + 8 + 28 = 232 fits.
    withLayout({ row: 296, chip: 60 });
    render(<SourceRow sources={[1, 2, 3, 4, 5].map(source)} />);

    expect(screen.getAllByTestId('source-chip')).toHaveLength(3);
    expect(screen.getByTestId('source-row-more')).toHaveTextContent('2');
  });

  it('shows more of them as the column widens', () => {
    withLayout({ row: 616, chip: 60 });
    render(<SourceRow sources={[1, 2, 3, 4, 5].map(source)} />);

    expect(screen.getAllByTestId('source-chip')).toHaveLength(5);
  });

  it('offers no button for the only source there is', () => {
    withLayout({ row: 296, chip: 60 });
    render(<SourceRow sources={[source(1)]} />);

    expect(screen.getAllByTestId('source-chip')).toHaveLength(1);
    expect(screen.queryByTestId('source-row-more')).toBeNull();
  });

  it('leaves nothing drawn that the row does not show', () => {
    // What is hidden is not rendered, so it takes no tab stop and no
    // announcement -- clipping paint leaves both behind.
    withLayout({ row: 296, chip: 60 });
    render(<SourceRow sources={[1, 2, 3, 4, 5, 6, 7, 8].map(source)} />);

    expect(screen.getAllByTestId('source-chip').length).toBeLessThan(8);
  });
});
