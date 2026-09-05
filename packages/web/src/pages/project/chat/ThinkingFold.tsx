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
}

/**
 * Foldable "thinking" block shown inside an assistant bubble. Collapsed
 * by default; expansion is a per-bubble UI affordance — the thinking
 * payload is never sent back to the LLM (see docs/ARCHITECTURE.md, "Three-layer
 * memory + Turn compression").
 * @param root0 - The component props.
 * @param root0.thinking - The assistant's thinking text to show when expanded.
 * @param root0.ms - How long the turn thought, in milliseconds.
 * @returns The collapsible thinking block.
 */
export function ThinkingFold({
  thinking,
  ms,
}: ThinkingFoldProps): React.JSX.Element {
  const t = useTranslation();
  const [open, setOpen] = React.useState(false);
  // Rounded to the second the reader is shown, so the minutes and the seconds
  // are read off one figure and cannot disagree at the boundary.
  // At least one: the server sends any figure above zero, and a stretch under
  // half a second would round to none at all -- a line saying it thought for
  // no time is a line that contradicts itself.
  const seconds = ms === undefined ? undefined : Math.max(1, Math.round(ms / 1000));
  const label =
    seconds === undefined
      ? t('chat.thinking')
      : t('chat.thinkingFor', { m: Math.floor(seconds / 60), s: seconds % 60 });
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
