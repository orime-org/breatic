// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The one scroller a sticky's parts are allowed to use.
 *
 * A sticky lives inside a board that pans on the wheel, so every scroller on
 * it has to claim the wheel back with `nowheel` or the words stay put while
 * the board moves under them. Written as "remember `nowheel` on each one" that
 * was five call sites to keep in step, and the new-note box was the one that
 * missed: measured on a board, 216px of draft below the cap, 208px of room
 * above the caret, and a wheel over it left `scrollTop` on 208 while the
 * canvas panned 60px.
 *
 * The cap goes on the viewport, which is the element that scrolls; on the Root
 * it clips instead. `caps.ts` carries the two heights and why each part takes
 * the one it does.
 */

import * as React from 'react';

import { ScrollArea } from '@web/components/ui/scroll-area';
import { cn } from '@web/lib/utils';

interface NoteScrollerProps {
  /** How tall the content may grow before it scrolls — one of `caps.ts`. */
  cap: string;
  /** Anything else the root carries, such as `nodrag` or a border. */
  className?: string;
  /** The element that scrolls, for a caller that has to move it. */
  viewportRef?: React.Ref<HTMLDivElement>;
  /** Test hook for the root. */
  'data-testid'?: string;
  /** What scrolls. */
  children: React.ReactNode;
}

/**
 * Draw a capped, wheel-claiming scroller.
 * @param root0 - The component props.
 * @param root0.cap - The viewport's maximum height.
 * @param root0.className - Extra classes for the root.
 * @param root0.viewportRef - Receives the scrolling element.
 * @param root0.children - What scrolls.
 * @returns The scroller.
 */
export function NoteScroller({
  cap,
  className,
  viewportRef,
  children,
  ...rest
}: NoteScrollerProps): React.JSX.Element {
  return (
    <ScrollArea
      scrollbars='vertical'
      className={cn('nowheel', className)}
      viewportClassName={cap}
      viewportRef={viewportRef}
      data-testid={rest['data-testid']}
    >
      {children}
    </ScrollArea>
  );
}
