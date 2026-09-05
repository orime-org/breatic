// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';

/**
 * How many of a row's items fit in it, keeping room for the button.
 *
 * One line, no wrap, no scroll: what does not fit goes behind a button that
 * opens the rest, and the button has to fit too. Both rows a reply can carry
 * follow this rule, so the arithmetic is here rather than twice -- the
 * squares are all one size and the source chips are each their own, which is
 * why this takes the widths rather than a count and a size.
 *
 * At least one, whatever the arithmetic says: a row that drew nothing would
 * be a row that says a turn found nothing.
 * @param widths - Each item's width, in the order they are drawn.
 * @param gapPx - The gap between two of them.
 * @param rowPx - How much room the row has.
 * @param buttonPx - How wide the button is, when one is needed.
 * @returns How many to draw.
 */
export function fitsInRow(
  widths: readonly number[],
  gapPx: number,
  rowPx: number,
  buttonPx: number,
): number {
  /**
   * Whether the first `n` of them, and what follows, stay inside the row.
   * @param n - How many items.
   * @param withButton - Whether the button follows them.
   * @returns True when it fits.
   */
  const fits = (n: number, withButton: boolean): boolean => {
    const items = widths.slice(0, n).reduce((sum, w) => sum + w, 0) + gapPx * (n - 1);
    return items + (withButton ? gapPx + buttonPx : 0) <= rowPx;
  };

  if (fits(widths.length, false)) return widths.length;
  let n = widths.length - 1;
  while (n > 1 && !fits(n, true)) n -= 1;
  return n;
}

/**
 * Measure a row, and each of its items, as the column is dragged.
 *
 * The widths are read while every item is drawn, and they stay true as the
 * ones that do not fit are taken away: items are laid out left to right and
 * do not shrink, so removing the last of them leaves the rest where they
 * were. Reading them in a layout effect means the row the reader sees is
 * already the one that fits.
 * @returns The ref to put on the row, how wide it is, and each item's width.
 */
export function useRowMeasure(): {
  row: React.RefObject<HTMLDivElement | null>;
  rowPx: number;
  widths: number[];
  } {
  const row = React.useRef<HTMLDivElement>(null);
  const [rowPx, setRowPx] = React.useState(0);
  const [widths, setWidths] = React.useState<number[]>([]);

  React.useLayoutEffect(() => {
    const el = row.current;
    if (el === null) return undefined;
    /** Read the row and everything in it as it stands. */
    const measure = (): void => {
      setRowPx(el.getBoundingClientRect().width);
      setWidths((prev) => {
        const next = [...el.children].map((c) => c.getBoundingClientRect().width);
        // The same numbers as last time are the same array as last time, so
        // measuring does not itself cause the render that measures again.
        const same = prev.length === next.length && prev.every((w, i) => w === next[i]);
        return same ? prev : next;
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  });

  return { row, rowPx, widths };
}
