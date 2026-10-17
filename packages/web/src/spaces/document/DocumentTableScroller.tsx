// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The frame a table scrolls sideways in (inner#1126 A12), with an edge on each
 * side that still has more to scroll (A21): a line along the frame and a fade
 * inward, gone from the side scrolled to its end. The pattern is the overflow
 * shadow of Atlassian's editor (`elevation.shadow.overflow`).
 */

import * as React from 'react';

import { ScrollArea } from '@web/components/ui/scroll-area';

/** Which sides of a frame have more to scroll. */
interface OverflowSides {
  readonly left: boolean;
  readonly right: boolean;
}

/**
 * Which sides of a frame still have more to scroll. A scroll position is
 * rounded by the browser to its pixel grid, so a side within a pixel of its
 * end counts as at its end.
 * @param scrollLeft - How far the frame is scrolled.
 * @param scrollWidth - How wide its content is.
 * @param clientWidth - How wide the frame is.
 * @returns The sides.
 */
export function overflowSides(scrollLeft: number, scrollWidth: number, clientWidth: number): OverflowSides {
  return { left: scrollLeft >= 1, right: scrollWidth - clientWidth - scrollLeft >= 1 };
}

/** No side has more to scroll. */
const FITS: OverflowSides = { left: false, right: false };

/**
 * The frame.
 * @param props - The frame's content.
 * @param props.children - The table.
 * @returns The frame.
 */
export function DocumentTableScroller({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [viewport, setViewport] = React.useState<HTMLDivElement | null>(null);
  const [sides, setSides] = React.useState<OverflowSides>(FITS);

  React.useEffect(() => {
    if (viewport === null) return undefined;
    /** Reads which sides have more to scroll now. */
    const read = (): void => {
      const next = overflowSides(viewport.scrollLeft, viewport.scrollWidth, viewport.clientWidth);
      setSides((prev) => (prev.left === next.left && prev.right === next.right ? prev : next));
    };
    read();
    viewport.addEventListener('scroll', read, { passive: true });
    // The frame narrows with the window, and the table widens as columns are
    // added or dragged wider.
    const sizes = new ResizeObserver(read);
    sizes.observe(viewport);
    if (viewport.firstElementChild !== null) sizes.observe(viewport.firstElementChild);
    return () => {
      viewport.removeEventListener('scroll', read);
      sizes.disconnect();
    };
  }, [viewport]);

  return (
    <div className='doc-table-frame'>
      <ScrollArea scrollbars='horizontal' viewportRef={setViewport}>
        {children}
      </ScrollArea>
      <span aria-hidden='true' className='doc-table-overflow-edge' data-overflow-edge='left' data-on={sides.left ? '' : undefined} />
      <span aria-hidden='true' className='doc-table-overflow-edge' data-overflow-edge='right' data-on={sides.right ? '' : undefined} />
    </div>
  );
}
