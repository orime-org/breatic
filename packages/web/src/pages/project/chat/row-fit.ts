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

  if (widths.length === 0) return 0;
  if (fits(widths.length, false)) return widths.length;
  let n = widths.length - 1;
  while (n > 1 && !fits(n, true)) n -= 1;
  return Math.max(1, n);
}

/**
 * Measure the room a row has, and how wide each thing in it is.
 *
 * Two elements, because they answer two questions and one of them is sized by
 * the answer. `room` goes on the container the component never sizes, so what
 * it reports is what there is; `items` goes on the strip whose children are
 * measured. Measuring the strip for both would feed the result back in: it is
 * a flex item, so its width is its content, and cutting it to what fits makes
 * the next measurement smaller than the last.
 *
 * Read in a layout effect, so the row the reader sees is already the one that
 * fits.
 * @returns The two refs, the room, and each item's width.
 */
export function useRowMeasure(): {
  room: React.RefObject<HTMLDivElement | null>;
  items: React.RefObject<HTMLDivElement | null>;
  rowPx: number;
  widths: number[];
  } {
  const room = React.useRef<HTMLDivElement>(null);
  const items = React.useRef<HTMLDivElement>(null);
  const [rowPx, setRowPx] = React.useState(0);
  const [widths, setWidths] = React.useState<number[]>([]);

  React.useLayoutEffect(() => {
    const outer = room.current;
    if (outer === null) return undefined;
    /** Read the room and everything in it as it stands. */
    const measure = (): void => {
      setRowPx(outer.getBoundingClientRect().width);
      const strip = items.current ?? outer;
      setWidths((prev) => {
        // Merged rather than replaced. Only the items that fit are drawn, so
        // a later pass measures fewer of them than the first -- and dropping
        // the widths of the ones no longer drawn would leave the arithmetic
        // deciding from a shorter list each time, which is the feedback this
        // avoids. An item's width does not depend on how many are beside it,
        // so a width once read stays true.
        const next = [...prev];
        [...strip.children].forEach((c, i) => {
          next[i] = c.getBoundingClientRect().width;
        });
        const same = prev.length === next.length && prev.every((w, i) => w === next[i]);
        return same ? prev : next;
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(outer);
    return () => observer.disconnect();
  });

  return { room, items, rowPx, widths };
}
