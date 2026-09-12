// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';

/**
 * How many squares a row is divided into.
 *
 * The count is what stays fixed and the size is what follows from it, so the
 * pictures are as large as the column allows. A reader scanning a row of
 * photographs is deciding which one to open, and a crop too small to tell two
 * neon streets apart sends them through the dialog to find out.
 */
export const ROW_SLOTS = 4;

/**
 * The least room a row can have.
 *
 * The Agent column's floor is 320 and the message list pads it by 12 a side.
 * Used for the first frame, before the layout effect has measured anything,
 * and as the floor for anything narrower -- a row narrower than its own column
 * allows is not a row this has to have an answer for, and clamping keeps the
 * arithmetic from producing a size no square can be drawn at.
 */
const NARROWEST_ROW_PX = 296;

/** What a row draws, once it knows how much room it has. */
export interface RowPlan {
  /** How wide and tall each square is. */
  sizePx: number;
  /** How many assets get a square of their own. */
  shown: number;
  /** How many are left behind the button. */
  hidden: number;
}

/**
 * Divide a row's room into squares, and say how many of them hold a picture.
 *
 * One line, no wrap, no scroll. What does not fit goes behind a button that
 * opens the rest, and that button takes a slot of its own -- so a turn with
 * more pictures than slots shows one fewer picture than a turn with exactly
 * as many.
 * @param total - How many the turn found.
 * @param roomPx - How much room the row has; 0 before it has been measured.
 * @param gapPx - The gap between two squares.
 * @returns The size to draw at, and how the assets divide between the row and the button.
 */
export function planRow(total: number, roomPx: number, gapPx: number): RowPlan {
  const room = Math.max(roomPx, NARROWEST_ROW_PX);
  // Floored, so the row stays inside the room it was given: a fraction of a
  // pixel per square adds up to a square's worth of overflow across the row.
  const sizePx = Math.floor((room - gapPx * (ROW_SLOTS - 1)) / ROW_SLOTS);

  if (total <= ROW_SLOTS) return { sizePx, shown: total, hidden: 0 };
  const shown = ROW_SLOTS - 1;
  return { sizePx, shown, hidden: total - shown };
}

/**
 * Measure the room a row has.
 *
 * Read off the container the component never sizes, so what it reports is what
 * there is. Measuring the strip of squares instead would feed the result back
 * in: it is a flex item, so its width is its content.
 *
 * Read in a layout effect, so the row the reader sees is already the one that
 * fits.
 * @returns The ref to put on the container, and the room it has.
 */
export function useRowMeasure(): {
  room: React.RefObject<HTMLDivElement | null>;
  rowPx: number;
  } {
  const room = React.useRef<HTMLDivElement>(null);
  const [rowPx, setRowPx] = React.useState(0);

  React.useLayoutEffect(() => {
    const outer = room.current;
    if (outer === null) return undefined;
    /** Read the room as it stands. */
    const measure = (): void => {
      setRowPx(outer.getBoundingClientRect().width);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(outer);
    return () => observer.disconnect();
  });

  return { room, rowPx };
}
