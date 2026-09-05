// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { Check, Copy } from 'lucide-react';

import { Button } from '@web/components/ui/button';
import { toast } from '@web/lib/toast';
import { useTranslation } from '@web/i18n/use-translation';

/** How long the button says it worked before going back to offering. */
const CONFIRMED_FOR_MS = 1500;

/**
 * A block of code in a reply, with a way to take it.
 *
 * Code is the one thing in a reply a reader wants exactly, and selecting it
 * by hand is where the leading spaces and the wrapping get lost. The button
 * sits over the block's top right corner and comes out on hover, so a block
 * being read is a block and nothing else.
 *
 * What it copies is read off the rendered element rather than kept alongside
 * it: the highlighting rebuilds these nodes, and a copy of the source held
 * here would be the version before whatever the last rebuild did.
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
  const [copied, setCopied] = React.useState(false);

  React.useEffect(() => {
    if (!copied) return undefined;
    const timer = window.setTimeout(() => setCopied(false), CONFIRMED_FOR_MS);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copy = React.useCallback(() => {
    const text = block.current?.innerText ?? '';
    void navigator.clipboard
      .writeText(text)
      .then(() => setCopied(true))
      .catch(() => {
        toast.error(t('common.clipboardError'));
      });
  }, [t]);

  return (
    <div className='group/code relative'>
      <pre ref={block} {...rest}>
        {children}
      </pre>
      <Button
        data-testid='code-copy'
        variant='outline'
        size='icon'
        aria-label={copied ? t('chat.code.copied') : t('chat.code.copy')}
        title={copied ? t('chat.code.copied') : t('chat.code.copy')}
        onClick={copy}
        className='absolute right-2 top-2 size-[var(--btn-compact)] bg-card text-muted-foreground opacity-0 transition-opacity group-hover/code:opacity-100 focus-visible:opacity-100'
      >
        {copied ? (
          <Check className='size-3.5' aria-hidden='true' />
        ) : (
          <Copy className='size-3.5' aria-hidden='true' />
        )}
      </Button>
    </div>
  );
}
