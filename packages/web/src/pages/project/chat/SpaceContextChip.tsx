// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import type { SpaceType } from '@breatic/shared';

import { Button } from '@web/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@web/components/ui/tooltip';
import { useTranslation } from '@web/i18n/use-translation';
import { SPACE_TYPE_ICON, spaceContentReadable } from '@web/pages/project/space-type';

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
  // Whether the Agent reads it, then what a click does; the name is already on the chip.
  const readable = spaceContentReadable(type);
  const said = enabled
    ? t(readable ? 'chat.composer.spaceContextOn' : 'chat.composer.spaceContextOnUnreadable')
    : t(readable ? 'chat.composer.spaceContextOff' : 'chat.composer.spaceContextOffUnreadable');
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* The floor keeps the icon and three full-width characters: 2.125rem
            is px-2 on both sides (16px) + the 1px border on both sides (2px)
            + the h-3 icon (12px) + gap-1 (4px). Change any of those and this
            sum changes with them. */}
        <Button
          type='button'
          variant={null}
          size={null}
          aria-pressed={enabled}
          onClick={onToggle}
          data-testid='chat-composer-space'
          className={`h-6 min-w-[calc(3em+2.125rem)] max-w-full gap-1 overflow-hidden border px-2 text-xs font-normal ${
            enabled
              ? 'border-border bg-chip text-foreground hover:bg-accent'
              : 'border-dashed border-border bg-transparent text-muted-foreground hover:text-foreground'
          }`}
        >
          <Icon className='h-3 w-3 shrink-0 text-muted-foreground' aria-hidden='true' />
          <span className='truncate'>{name}</span>
        </Button>
      </TooltipTrigger>
      {/* Portalled: the composer card clips what overflows it, and an inline
          tip above the chip would be cut off at the card's top edge. */}
      <TooltipContent portal>{said}</TooltipContent>
    </Tooltip>
  );
}
