// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { X } from 'lucide-react';
import type * as React from 'react';

import { Button } from '@web/components/ui/button';

/**
 * The frame a panel anchored to a canvas node draws itself in.
 *
 * `nowheel` + `nodrag`: the panel floats over the ReactFlow canvas, which
 * otherwise captures the wheel to zoom — so a list inside it would never
 * scroll on wheel and only the scrollbar drag would work. ReactFlow checks
 * ancestors, so putting them on the root frees the whole panel: an inner
 * ScrollArea scrolls on wheel, and dragging the panel never moves the node
 * behind it.
 *
 * The width, the frame and the header live here because a reader moving
 * between two panels on the same canvas is reading one thing: a panel that
 * closes with a 24px key next to one that closes with a 28px key reads as two
 * different products (visual adversary, 2026-09-09; user picked 24).
 */
export interface CanvasPanelProps {
  /** What the panel is showing, in the header's own voice. */
  title: React.ReactNode;
  /** A count or other aside, set beside the title in muted type. */
  aside?: React.ReactNode;
  /** The close button's accessible name. */
  closeLabel: string;
  /** Closes the panel. */
  onClose: () => void;
  /** Test hook for the close button, so each panel keeps its own. */
  closeTestId?: string;
  /** The panel's body, below the header. */
  children: React.ReactNode;
}

/**
 * A panel anchored to a canvas node: frame, header, close button, body.
 * @param props - What the header shows and what sits under it.
 * @param props.title - What the panel is showing.
 * @param props.aside - A count or other aside beside the title.
 * @param props.closeLabel - The close button's accessible name.
 * @param props.onClose - Closes the panel.
 * @param props.closeTestId - Test hook for the close button.
 * @param props.children - The panel's body.
 * @returns The panel element.
 */
export function CanvasPanel({
  title,
  aside,
  closeLabel,
  onClose,
  closeTestId,
  children,
}: CanvasPanelProps): React.JSX.Element {
  return (
    <div className='nowheel nodrag flex w-[min(344px,92vw)] flex-col rounded-overlay border border-border bg-popover text-popover-foreground shadow-md'>
      <div className='flex items-center justify-between px-3 py-2.5'>
        <div className='flex items-baseline gap-2'>
          {title}
          {aside}
        </div>
        <Button
          type='button'
          variant={null}
          size={null}
          {...(closeTestId !== undefined && { 'data-testid': closeTestId })}
          aria-label={closeLabel}
          onClick={onClose}
          className='flex h-6 w-6 items-center justify-center rounded-content-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'
        >
          <X className='h-3.5 w-3.5' aria-hidden='true' />
        </Button>
      </div>
      {children}
    </div>
  );
}
