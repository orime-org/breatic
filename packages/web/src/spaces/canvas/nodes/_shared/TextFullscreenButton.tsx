// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import * as React from 'react';
import { Maximize2 } from 'lucide-react';

import { Button } from '@web/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@web/components/ui/tooltip';
import { cn } from '@web/lib/utils';

/** Props for {@link TextFullscreenButton}. */
interface TextFullscreenButtonProps {
  /** What it says, as its tooltip and name. */
  label: string;
  /** Opens full screen. */
  onOpen: () => void;
  /** What tests reach for it by. */
  testId: string;
  /** Shown only while the pointer is on the nearest `group/media` (the node); always shown when false. */
  onHover?: boolean;
  /** Where the caller places it. */
  className?: string;
}

/**
 * The button that opens text full screen (inner#2115): above a text node's
 * top-right corner, shown while the pointer is on the node, or in the
 * generation panel's first row, always shown.
 * @param root0 - Component props.
 * @param root0.label - What it says.
 * @param root0.onOpen - Opens full screen.
 * @param root0.testId - The test id.
 * @param root0.onHover - Whether it shows only on hover.
 * @param root0.className - Where the caller places it.
 * @returns The button.
 */
export function TextFullscreenButton({
  label,
  onOpen,
  testId,
  onHover = false,
  className,
}: TextFullscreenButtonProps): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type='button'
          variant={null}
          size={null}
          aria-label={label}
          data-testid={testId}
          onClick={(event) => {
            event.stopPropagation();
            onOpen();
          }}
          className={cn(
            'nodrag inline-flex items-center justify-center rounded-chrome text-muted-foreground transition-colors hover-enabled:bg-accent hover-enabled:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
            onHover
              ? 'h-5 w-5 opacity-0 transition-opacity focus-visible:opacity-100 group-hover/media:opacity-100'
              : 'h-6 w-6',
            className,
          )}
        >
          <Maximize2 className={onHover ? 'h-3 w-3' : 'h-3.5 w-3.5'} aria-hidden='true' />
        </Button>
      </TooltipTrigger>
      {/* Through the body: a canvas node clips its children. */}
      <TooltipContent portal>{label}</TooltipContent>
    </Tooltip>
  );
}
