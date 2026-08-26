// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { ChevronDown, ChevronRight } from 'lucide-react';
import * as React from 'react';

import { Button } from '@web/components/ui/button';
import { MarkdownMessage } from '@web/pages/project/chat/MarkdownMessage';

interface ThinkingFoldProps {
  thinking: string;
}

/**
 * Foldable "thinking" block shown inside an assistant bubble. Collapsed
 * by default; expansion is a per-bubble UI affordance — the thinking
 * payload is never sent back to the LLM (see CLAUDE.md turn compression
 * notes).
 * @param root0 - The component props.
 * @param root0.thinking - The assistant's thinking text to show when expanded.
 * @returns The collapsible thinking block.
 */
export function ThinkingFold({
  thinking,
}: ThinkingFoldProps): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  return (
    <div
      data-testid='thinking-fold'
      className='mb-2 rounded border border-border bg-background/50 text-xs'
    >
      <Button
        type='button'
        variant={null}
        size={null}
        onClick={() => setOpen((o) => !o)}
        className='flex w-full items-center gap-1 px-2 py-1 text-muted-foreground hover:bg-accent'
        aria-expanded={open}
        data-testid='thinking-fold-toggle'
      >
        {open ? (
          <ChevronDown className='h-3 w-3' />
        ) : (
          <ChevronRight className='h-3 w-3' />
        )}
        Thinking
      </Button>
      {open ? (
        <div data-testid='thinking-fold-body' className='px-2 py-1 text-muted-foreground'>
          <MarkdownMessage content={thinking} size='2xs' softBreaks />
        </div>
      ) : null}
    </div>
  );
}
