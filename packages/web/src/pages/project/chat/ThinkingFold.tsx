// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { ChevronDown, ChevronRight } from 'lucide-react';
import * as React from 'react';

import { Button } from '@web/components/ui/button';
import { useTranslation } from '@web/i18n/use-translation';
import { MarkdownMessage } from '@web/pages/project/chat/MarkdownMessage';

interface ThinkingFoldProps {
  thinking: string;
  /** How long the turn thought, in milliseconds. Absent on turns stored before it was measured. */
  ms?: number;
  /** Whether the turn this belongs to is still going. */
  running?: boolean;
}

/**
 * Foldable "thinking" block shown inside an assistant bubble. Collapsed
 * by default; expansion is a per-bubble UI affordance — the thinking
 * payload is never sent back to the LLM (see docs/ARCHITECTURE.md, "Three-layer
 * memory + Turn compression").
 * @param root0 - The component props.
 * @param root0.thinking - The assistant's thinking text to show when expanded.
 * @param root0.ms - How long the turn thought, in milliseconds.
 * @param root0.running - Whether the turn this belongs to is still going.
 * @returns The collapsible thinking block.
 */
export function ThinkingFold({
  thinking,
  ms,
  running,
}: ThinkingFoldProps): React.JSX.Element {
  const t = useTranslation();
  const [open, setOpen] = React.useState(false);
  // Rounded to the second the reader is shown, so the minutes and the seconds
  // are read off one figure and cannot disagree at the boundary.
  // At least one: the server sends any figure above zero, and a stretch under
  // half a second would round to none at all -- a line saying it thought for
  // no time is a line that contradicts itself.
  const seconds = ms === undefined ? undefined : Math.max(1, Math.round(ms / 1000));
  // Three things this line can be saying, and which one is settled by the
  // turn rather than by whether a figure happens to have arrived. The figure
  // is sent as the turn ends, so a turn still going has none to say --
  // and saying it thought for a while while it is still thinking is the line
  // reading back to front. A turn that has stopped and carries no figure is
  // the third: it did think for a while, and how long is what is missing.
  let label: string;
  if (running === true) label = t('chat.thinkingNow');
  else if (seconds === undefined) label = t('chat.thinking');
  else label = t('chat.thinkingFor', { m: Math.floor(seconds / 60), s: seconds % 60 });
  return (
    <div
      data-testid='thinking-fold'
      className='mb-2 text-xs'
    >
      <Button
        type='button'
        variant={null}
        size={null}
        onClick={() => setOpen((o) => !o)}
        className='inline-flex items-center gap-1 p-0 text-muted-foreground hover:text-foreground'
        aria-expanded={open}
        data-testid='thinking-fold-toggle'
      >
        {open ? (
          <ChevronDown className='h-3 w-3' />
        ) : (
          <ChevronRight className='h-3 w-3' />
        )}
        {label}
      </Button>
      {open ? (
        <div data-testid='thinking-fold-body' className='py-1 pl-4 text-muted-foreground'>
          <MarkdownMessage content={thinking} size='2xs' softBreaks />
        </div>
      ) : null}
    </div>
  );
}
