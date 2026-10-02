// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { ChevronLeft, ChevronRight } from 'lucide-react';
import * as React from 'react';

import { Button } from '@web/components/ui/button';
import { cn } from '@web/lib/utils';

/** The gap between the first panel and the second, the `ml-2` / `mr-2` below. */
const GAP_PX = 8;

/** The share of the window a second panel may take before it narrows. */
const WINDOW_SHARE = 0.88;

/**
 * Which side a popover's second panel opens on (#2156 design §16.1, #2254).
 *
 * The second panel opens to the right of the first; when the first sits near
 * the right edge and there is no room there, it opens to the left instead,
 * rather than being cut off by the window. The side is measured each time a
 * different second panel opens, because the first panel follows the canvas
 * and can have moved since the last one.
 * @param openKey - Which second panel is open, or null when none is.
 * @param maxWidth - The second panel's widest width in pixels, as given to `SecondPanelFrame`.
 * @returns A ref for the first panel, and whether the second opens on the left.
 */
export function useSecondPanelSide(
  openKey: string | null,
  maxWidth: number,
): [React.RefObject<HTMLDivElement | null>, boolean] {
  const firstPanelRef = React.useRef<HTMLDivElement>(null);
  const [onLeft, setOnLeft] = React.useState(false);
  React.useLayoutEffect(() => {
    const el = firstPanelRef.current;
    if (openKey === null || !el) return;
    const box = el.getBoundingClientRect();
    const span = Math.min(maxWidth, window.innerWidth * WINDOW_SHARE) + GAP_PX;
    setOnLeft(box.right + span > window.innerWidth && box.left >= span);
  }, [openKey, maxWidth]);
  return [firstPanelRef, onLeft];
}

interface SecondPanelRowProps {
  /** The row's name, in the first column. */
  label: string;
  /** What the row stands on, in the second column. */
  value: React.ReactNode;
  /** Whether this row's second panel is open. */
  open: boolean;
  /** Whether the second panel opens on the left, which turns the chevron. */
  onLeft: boolean;
  /** Draws the value muted, for a value that reads as nothing set. */
  valueMuted?: boolean;
  /** The row's test id. */
  testId: string;
  /** Opens or closes this row's second panel. */
  onClick: () => void;
  /** Outer spacing, which depends on the popover's own padding. */
  className?: string;
}

/**
 * A row of a popover that opens a second panel beside it: name, value, and a
 * chevron pointing at the side the panel opens on.
 * @param root0 - Component props.
 * @param root0.label - The row's name.
 * @param root0.value - What the row stands on.
 * @param root0.open - Whether its panel is open.
 * @param root0.onLeft - Whether the panel opens on the left.
 * @param root0.valueMuted - Draws the value muted.
 * @param root0.testId - The row's test id.
 * @param root0.onClick - Opens or closes the panel.
 * @param root0.className - Outer spacing.
 * @returns The row.
 */
export function SecondPanelRow({
  label,
  value,
  open,
  onLeft,
  valueMuted = false,
  testId,
  onClick,
  className,
}: SecondPanelRowProps): React.JSX.Element {
  const Chevron = onLeft ? ChevronLeft : ChevronRight;
  return (
    <Button
      type='button'
      variant='ghost'
      size='menu-item'
      aria-expanded={open}
      data-testid={testId}
      className={cn(
        'group grid grid-cols-[72px_minmax(0,1fr)_16px] items-center gap-2 px-1',
        open && 'bg-accent',
        className,
      )}
      onClick={onClick}
    >
      {/* Muted text on the accent fill, open or hovered, is 4.46:1 in the
          dark theme, under the 4.5:1 floor; on the fill it reads in full. */}
      <span
        className={cn(
          'truncate text-left text-xs font-medium',
          open ? 'text-foreground' : 'text-muted-foreground group-hover:text-foreground',
        )}
      >
        {label}
      </span>
      <span
        className={cn(
          'truncate text-left text-xs',
          valueMuted && !open && 'text-muted-foreground group-hover:text-foreground',
        )}
      >
        {value}
      </span>
      <Chevron className='h-3.5 w-3.5 opacity-60' aria-hidden='true' />
    </Button>
  );
}

interface SecondPanelFrameProps {
  /** Whether it opens on the left of the first panel. */
  onLeft: boolean;
  /** Its widest width in pixels, the same number given to `useSecondPanelSide`. */
  maxWidth: number;
  /** The frame's test id. */
  testId: string;
  /** Inner spacing and overflow, which differ by content. */
  className?: string;
  /** The panel's content. */
  children: React.ReactNode;
}

/**
 * The second panel's frame, beside the first panel and level with its bottom.
 * @param root0 - Component props.
 * @param root0.onLeft - Whether it opens on the left.
 * @param root0.maxWidth - Its widest width in pixels.
 * @param root0.testId - The frame's test id.
 * @param root0.className - Inner spacing and overflow.
 * @param root0.children - The panel's content.
 * @returns The frame.
 */
export function SecondPanelFrame({
  onLeft,
  maxWidth,
  testId,
  className,
  children,
}: SecondPanelFrameProps): React.JSX.Element {
  return (
    <div
      data-testid={testId}
      data-side={onLeft ? 'left' : 'right'}
      style={{ width: `min(${maxWidth}px, ${WINDOW_SHARE * 100}vw)` }}
      className={cn(
        'absolute bottom-0 rounded-overlay border border-border bg-popover text-popover-foreground shadow-md',
        onLeft ? 'right-full mr-2' : 'left-full ml-2',
        className,
      )}
    >
      {children}
    </div>
  );
}
