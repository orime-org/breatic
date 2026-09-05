// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { Copy } from 'lucide-react';

import { Button } from '@web/components/ui/button';
import { cn } from '@web/lib/utils';
import { toast } from '@web/lib/toast';
import { useTranslation } from '@web/i18n/use-translation';

interface TurnActionsProps {
  /** What copy puts on the clipboard. */
  text: string;
  /** Shown only on hover, which is what the reader's own messages want. */
  onHoverOnly?: boolean;
}

/**
 * What a finished message offers.
 *
 * Copy, and that is the whole of it. Asking for another answer is typing
 * another message, which the composer below is already for.
 * @param root0 - The component props.
 * @param root0.text - What copy puts on the clipboard.
 * @param root0.onHoverOnly - Keep the row hidden until the message is hovered.
 * @returns The row.
 */
export const TurnActions = React.memo(function TurnActions({
  text,
  onHoverOnly,
}: TurnActionsProps): React.JSX.Element {
  const t = useTranslation();

  const copy = React.useCallback(() => {
    void navigator.clipboard.writeText(text).catch(() => {
      toast.error(t('common.clipboardError'));
    });
  }, [text, t]);

  return (
    <div
      data-testid='turn-actions'
      className={cn(
        'flex items-center gap-1',
        // No strip is reserved under the reader's own message. Transparent
        // alone is not enough: the element would keep its line, keep taking
        // clicks and keep its place in the tab order, so that blank would
        // copy when pressed with nothing visible there. Inside the bubble's
        // own box rather than below it -- the gap between messages is 8px and
        // this is 24px tall, so hanging it underneath covers the top of the
        // next message.
        onHoverOnly === true
          ? 'absolute bottom-1 right-1 opacity-0 pointer-events-none transition-opacity group-hover:opacity-100 group-hover:pointer-events-auto focus-within:opacity-100 focus-within:pointer-events-auto'
          : 'mt-[0.85em]',
      )}
    >
      <Button
        data-testid='turn-copy'
        variant='ghost'
        size='icon'
        className='size-[var(--btn-compact)] text-muted-foreground'
        aria-label={t('chat.action.copy')}
        title={t('chat.action.copy')}
        onClick={copy}
      >
        <Copy className='size-3.5' aria-hidden='true' />
      </Button>
    </div>
  );
});
