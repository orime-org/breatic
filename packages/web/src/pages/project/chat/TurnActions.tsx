// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { Copy } from 'lucide-react';

import { getLocale } from '@breatic/shared';

import { Button } from '@web/components/ui/button';
import { cn } from '@web/lib/utils';
import { toast } from '@web/lib/toast';
import { useTranslation } from '@web/i18n/use-translation';

interface TurnActionsProps {
  /** What copy puts on the clipboard. */
  text: string;
  /** Shown only on hover, which is what the reader's own messages want. */
  onHoverOnly?: boolean;
  /** When the message was written down, as an absolute instant. */
  sentAt?: string;
}

/**
 * What a finished message offers.
 *
 * Copy, and that is the whole of it. Asking for another answer is typing
 * another message, which the composer below is already for.
 * @param root0 - The component props.
 * @param root0.text - What copy puts on the clipboard.
 * @param root0.onHoverOnly - Keep the row hidden until the message is hovered.
 * @param root0.sentAt - When the message was written down.
 * @returns The row.
 */
export const TurnActions = React.memo(function TurnActions({
  text,
  onHoverOnly,
  sentAt,
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
        // A line of its own under the reader's own message, and it keeps that
        // line whether or not anything on it is showing: a row that took no
        // space let the reply below come up under it, and the two were drawn
        // on top of each other.
        onHoverOnly === true ? 'mt-1 h-[var(--btn-compact)] justify-end' : 'mt-[0.85em]',
      )}
    >
      {sentAt === undefined ? null : (
        // The reader's own day: an absolute instant arrives, and a Date reads
        // it in the zone the reader is in. `getLocale()` rather than the
        // runtime default, which is the browser's language and not the one
        // the language switch set.
        <span data-testid='turn-sent-at' className='text-2xs text-muted-foreground'>
          {new Date(sentAt).toLocaleString(getLocale(), {
            dateStyle: 'short',
            timeStyle: 'short',
          })}
        </span>
      )}
      <Button
        data-testid='turn-copy'
        variant='ghost'
        size='icon'
        className={cn(
          'size-[var(--btn-compact)] text-muted-foreground',
          // Transparent alone is not enough: it would keep taking clicks and
          // keep its place in the tab order, so a blank would copy when
          // pressed with nothing visible there.
          onHoverOnly === true &&
            'opacity-0 pointer-events-none transition-opacity group-hover:opacity-100 group-hover:pointer-events-auto focus-visible:opacity-100 focus-visible:pointer-events-auto',
        )}
        aria-label={t('chat.action.copy')}
        onClick={copy}
      >
        <Copy className='size-3.5' aria-hidden='true' />
      </Button>
    </div>
  );
});
