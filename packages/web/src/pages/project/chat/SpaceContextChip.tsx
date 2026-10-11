// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import type { SpaceType } from '@breatic/shared';

import { Button } from '@web/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@web/components/ui/tooltip';
import { useTranslation } from '@web/i18n/use-translation';
import { SPACE_TYPE_ICON } from '@web/pages/project/space-type-icon';
import { spaceContentReadable } from '@web/pages/project/chat/space-context';

/** The chip's props; the composer takes all of them or none. */
export interface SpaceContextChipProps {
  /** The open Space's name. */
  name: string;
  /** The open Space's type. */
  type: SpaceType;
  /** Whether each message carries this Space to the Agent. */
  enabled: boolean;
  /** Turns sending the open Space on or off. */
  onToggle: () => void;
}

/**
 * The chip right of the plus sign (inner#1413): it always names the Space
 * whose tab is active, and pressing it turns sending that Space to the Agent
 * on and off. On, it looks like an attachment; off, the same chip with a
 * dashed border and muted words, so the name stays readable either way.
 * @param root0 - The component props.
 * @param root0.name - The open Space's name.
 * @param root0.type - The open Space's type.
 * @param root0.enabled - Whether each message carries this Space.
 * @param root0.onToggle - Turns it on or off.
 * @returns The chip.
 */
export function SpaceContextChip({ name, type, enabled, onToggle }: SpaceContextChipProps): React.JSX.Element {
  const t = useTranslation();
  const Icon = SPACE_TYPE_ICON[type];
  // What a click does next; the name is already on the chip.
  const said = !enabled
    ? t('chat.composer.spaceContextOff')
    : spaceContentReadable(type)
      ? t('chat.composer.spaceContextOn')
      : t('chat.composer.spaceContextOnUnreadable');
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type='button'
          variant='chrome-ghost'
          size={null}
          aria-pressed={enabled}
          onClick={onToggle}
          data-testid='chat-composer-space'
          className={`h-6 min-w-[calc(3ch+2.125rem)] max-w-full gap-1 overflow-hidden border px-2 text-xs font-normal ${
            // Each state says its own hover: the variant's grey hover would
            // fill an off chip right after the press that turned it off,
            // leaving only the dashed border to tell the two apart.
            enabled
              ? 'border-border bg-chip text-foreground hover:bg-accent'
              : 'border-dashed border-border bg-transparent text-muted-foreground hover:bg-transparent hover:text-foreground'
          }`}
        >
          <Icon className='h-3 w-3 shrink-0 text-muted-foreground' aria-hidden='true' />
          <span className='min-w-[3ch] truncate'>{name}</span>
        </Button>
      </TooltipTrigger>
      {/* Portalled: the composer card clips what overflows it, and an inline
          tip above the chip would be cut off at the card's top edge. */}
      <TooltipContent portal>{said}</TooltipContent>
    </Tooltip>
  );
}
