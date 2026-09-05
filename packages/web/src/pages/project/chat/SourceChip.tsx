// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';

import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from '@web/components/ui/hover-card';
import { cn } from '@web/lib/utils';

import type { ChatSource } from '@web/pages/project/chat/types';

/**
 * The colours a site's mark is drawn in.
 *
 * Taken from the palette rather than invented here, so the marks sit in the
 * same range as everything else on the surface and behave in both themes.
 */
const MARK_COLOURS = [
  'bg-palette-blue',
  'bg-palette-green',
  'bg-palette-orange',
  'bg-palette-violet',
  'bg-palette-red',
  'bg-palette-teal',
] as const;

/**
 * Pick a site's mark colour from its address.
 *
 * The same site is drawn the same colour every time it appears, which is what
 * lets a reader match a marker in the prose to a chip in the row below
 * without reading either. Derived rather than fetched: asking a favicon
 * service for an icon would tell that service which pages this reader is
 * reading, and asking the site itself would tell the site.
 * @param url - The page's address.
 * @returns A Tailwind background class.
 */
function markColour(url: string): string {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    host = url;
  }
  let hash = 0;
  for (const ch of host) hash = (hash * 31 + ch.charCodeAt(0)) % 100_000;
  return MARK_COLOURS[hash % MARK_COLOURS.length] ?? MARK_COLOURS[0];
}

interface SourceChipProps {
  /** The page this stands for. */
  source: ChatSource;
  /**
   * What the chip says.
   *
   * A number for a marker in the prose, where the sentence it supports is
   * what matters and the chip has to stay out of its way; the publisher's
   * name in the row at the foot, where the chip is the whole point.
   */
  label: string;
  /** Which of the two this is, for the test to look up. */
  testId: 'citation-chip' | 'source-chip';
}

/**
 * One page, as a chip that says where it came from.
 *
 * The card on hover is where the title goes: the chip has room for a number
 * or a publisher, and neither says enough to decide whether to follow it.
 * @param root0 - The component props.
 * @param root0.source - The page this stands for.
 * @param root0.label - What the chip says.
 * @param root0.testId - Which of the two this is.
 * @returns The chip.
 */
export const SourceChip = React.memo(function SourceChip({
  source,
  label,
  testId,
}: SourceChipProps): React.JSX.Element {
  return (
    <HoverCard openDelay={100}>
      <HoverCardTrigger asChild>
        <a
          data-testid={testId}
          href={source.url}
          target='_blank'
          rel='noreferrer noopener'
          className={cn(
            'inline-flex items-center gap-1.5 border border-border bg-card',
            'text-2xs text-muted-foreground no-underline',
            'hover:bg-accent hover:text-foreground',
            testId === 'citation-chip'
              // A marker in a sentence keeps its size: it is read as part of
              // the line it sits in, and a number is as short as it gets.
              ? 'h-[18px] shrink-0 rounded-full py-0 pl-[3px] pr-[5px] align-baseline'
              // A chip in the row gives way instead. Publishers' names are
              // whatever length they are and the column goes down to 320, so
              // chips that refused to shrink were simply cut off by the row --
              // along with the button that opens the rest.
              : 'h-[var(--btn-compact)] min-w-0 rounded-chrome px-2 text-xs',
          )}
        >
          <span
            aria-hidden='true'
            className={cn(
              'block shrink-0 rounded-chrome',
              markColour(source.url),
              testId === 'citation-chip' ? 'size-2.5' : 'size-3',
            )}
          />
          <span className={testId === 'citation-chip' ? undefined : 'truncate'}>{label}</span>
        </a>
      </HoverCardTrigger>
      {/* The gap is measured from the edge the reader sees. Nothing wraps the
          chip, so the trigger's own edge is that edge. */}
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
