// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { Check, Copy } from 'lucide-react';

import { Button } from '@web/components/ui/button';
import { cn } from '@web/lib/utils';
import { useTranslation } from '@web/i18n/use-translation';
import { CopyAnswerLabel, useCopyAnswer } from '@web/pages/project/chat/copy-answer';

/**
 * A block of code in a reply, with a way to take it.
 *
 * Code is the one thing in a reply a reader wants exactly, and selecting it
 * by hand is where the leading spaces and the wrapping get lost. The button
 * sits over the block's top right corner and comes out on hover, so a block
 * being read is a block and nothing else.
 *
 * What it copies is read off the rendered element at the moment of the press:
 * the highlighting rebuilds these nodes, and a copy of the source held here
 * would be the version before whatever the last rebuild did.
 * @param root0 - Everything the markdown renderer passes a `pre`.
 * @param root0.children - The highlighted code.
 * @returns The block.
 */
export function CodeBlock({
  children,
  ...rest
}: React.ComponentPropsWithoutRef<'pre'>): React.JSX.Element {
  const t = useTranslation();
  const block = React.useRef<HTMLPreElement>(null);
  const read = React.useCallback(() => block.current?.innerText ?? '', []);
  const { answered, copy } = useCopyAnswer(read);

  return (
    <div className='group/code relative'>
      <pre ref={block} {...rest}>
        {children}
      </pre>
      {/* The answer hangs below: this button is against the block's top edge,
          and above it the label would stand off the code entirely. */}
      <span className='absolute right-2 top-2 inline-flex'>
        <Button
          data-testid='code-copy'
          variant='outline'
          size='icon'
          aria-label={t('chat.code.copy')}
          onClick={copy}
          className={cn(
            'size-[var(--btn-compact)] bg-card text-muted-foreground opacity-0 transition-opacity group-hover/code:opacity-100 focus-visible:opacity-100',
            answered && 'opacity-100 text-foreground',
          )}
        >
          {answered ? (
            <Check className='size-3.5' aria-hidden='true' />
          ) : (
            <Copy className='size-3.5' aria-hidden='true' />
          )}
        </Button>
        {answered ? <CopyAnswerLabel side='right' below /> : null}
      </span>
    </div>
  );
}
