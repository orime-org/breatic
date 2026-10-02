// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';

/**
 * Which side a popover's second panel opens on (#2156 design §16.1, #2254).
 *
 * The second panel opens to the right of the first; when the first sits near
 * the right edge and there is no room there, it opens to the left instead,
 * rather than being cut off by the window. The side is measured each time a
 * different second panel opens, because the first panel follows the canvas
 * and can have moved since the last one.
 * @param openKey - Which second panel is open, or null when none is.
 * @param spanOf - How far the second panel reaches beside the first, its width
 *   plus the gap, read at the moment of measuring.
 * @returns A ref for the first panel, and whether the second opens on the left.
 */
export function useSecondPanelSide(
  openKey: string | null,
  spanOf: () => number,
): [React.RefObject<HTMLDivElement | null>, boolean] {
  const firstPanelRef = React.useRef<HTMLDivElement>(null);
  const [onLeft, setOnLeft] = React.useState(false);
  const spanRef = React.useRef(spanOf);
  spanRef.current = spanOf;
  React.useLayoutEffect(() => {
    const el = firstPanelRef.current;
    if (openKey === null || !el) return;
    const box = el.getBoundingClientRect();
    const span = spanRef.current();
    setOnLeft(box.right + span > window.innerWidth && box.left >= span);
  }, [openKey]);
  return [firstPanelRef, onLeft];
}
