// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';
import { Maximize } from 'lucide-react';

import { Button } from '@web/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@web/components/ui/tooltip';
import { useTranslation } from '@web/i18n/use-translation';
import { cn } from '@web/lib/utils';

/** Props for {@link MediaFullscreenButton}. */
interface MediaFullscreenButtonProps {
  /** Opens the full-screen view. */
  onOpen: () => void;
  /** Where the caller places it. */
  className?: string;
}

/**
 * The button over the top-right corner of an image or video that opens it
 * full screen (inner#1844). It shows while the pointer is on the nearest
 * `group/media` ancestor and is drawn on its own dark scrim, so it reads on
 * any picture.
 * @param root0 - Component props.
 * @param root0.onOpen - Opens the full-screen view.
 * @param root0.className - Where the caller places it.
 * @returns The button.
 */
export function MediaFullscreenButton({ onOpen, className }: MediaFullscreenButtonProps): React.JSX.Element {
  const t = useTranslation();
  const label = t('common.mediaViewer.fullscreen');
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type='button'
          variant={null}
          size={null}
          aria-label={label}
          data-testid='media-fullscreen-button'
          onClick={(event) => {
            event.stopPropagation();
            onOpen();
          }}
          className={cn(
            'nodrag inline-flex h-[var(--btn-inline)] w-[var(--btn-inline)] items-center justify-center rounded-chrome bg-black/50 text-white opacity-0 transition-opacity hover:bg-black/70 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white group-hover/media:opacity-100',
            className,
          )}
        >
          <Maximize className='h-4 w-4' />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
