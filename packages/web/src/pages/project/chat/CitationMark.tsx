// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';

import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from '@web/components/ui/hover-card';

import type { ChatSource } from '@web/pages/project/chat/types';

interface CitationMarkProps {
  /** The page this stands for. */
  source: ChatSource;
  /** The number the reply cited it by. */
  index: number;
}

/**
 * A marker where a claim is written, standing for the page it came from.
 *
 * A ring with the number in it and nothing else. Drawing the site's own icon
 * would mean fetching it from that site, and that fetch hands the reader's
 * address to whoever the reply happened to cite; a number owes nobody a
 * request. The card on hover is where the title goes -- a number alone does
 * not say enough to decide whether to follow it.
 * @param root0 - The component props.
 * @param root0.source - The page this stands for.
 * @param root0.index - The number the reply cited it by.
 * @returns The marker.
 */
export const CitationMark = React.memo(function CitationMark({
  source,
  index,
}: CitationMarkProps): React.JSX.Element {
  return (
    <HoverCard openDelay={100}>
      <HoverCardTrigger asChild>
        <a
          data-testid='citation-chip'
          href={source.url}
          target='_blank'
          rel='noreferrer noopener'
          // A ring for one digit and a short pill for two: the number is what
          // has to stay readable, so the width follows it and only the height
          // is fixed.
          className='inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full border border-border bg-card px-1 align-[-3px] text-2xs leading-none text-muted-foreground no-underline hover:border-muted-foreground hover:bg-accent hover:text-foreground'
        >
          {index}
        </a>
      </HoverCardTrigger>
      {/* The gap is measured from the edge the reader sees. Nothing wraps the
          marker, so the trigger's own edge is that edge. */}
      <HoverCardContent
        data-testid='source-hover-card'
        side='top'
        sideOffset={6}
        className='w-72 p-3'
      >
        <div className='flex flex-col gap-1'>
          <span className='text-2xs text-muted-foreground'>{source.publisher}</span>
          <span className='text-xs font-medium leading-snug'>{source.title}</span>
          <span className='break-all text-2xs text-muted-foreground'>{source.url}</span>
        </div>
      </HoverCardContent>
    </HoverCard>
  );
});
