// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { Check, Copy } from 'lucide-react';

import { getLocale } from '@breatic/shared';

import { Button } from '@web/components/ui/button';
import { cn } from '@web/lib/utils';
import { useTranslation } from '@web/i18n/use-translation';

import { CopyAnswerLabel, useCopyAnswer } from '@web/pages/project/chat/copy-answer';
import { SourceBox } from '@web/pages/project/chat/SourceBox';
import type { ChatSource } from '@web/pages/project/chat/types';

interface TurnActionsProps {
  /** What copy puts on the clipboard. */
  text: string;
  /**
   * The reader's own message.
   *
   * Its line is right-aligned and waits for hover, and the answer to a press
   * hugs the right edge because that is the edge its button sits against.
   */
  own?: boolean;
  /** When the message was written down, as an absolute instant. */
  sentAt?: string;
  /** Every page the turn found, when it searched. */
  sources?: ChatSource[];
}

/**
 * What a finished message offers.
 *
 * Copy first, then how many sources the turn found. Asking for another answer
 * is typing another message, which the composer below is already for.
 * @param root0 - The component props.
 * @param root0.text - What copy puts on the clipboard.
 * @param root0.own - Whether this is the reader's own message.
 * @param root0.sentAt - When the message was written down.
 * @param root0.sources - Every page the turn found.
 * @returns The row.
 */
export const TurnActions = React.memo(function TurnActions({
  text,
  own,
  sentAt,
  sources,
}: TurnActionsProps): React.JSX.Element {
  const t = useTranslation();
  const { answered, copy } = useCopyAnswer(text);
  // Everything on the reader's own line waits for the pointer together, and
  // an answered press brings the whole line up: half a line -- a time showing
  // beside a copy that is not -- reads as something having gone wrong.
  const waiting = own === true && !answered;
  const [boxOpen, setBoxOpen] = React.useState(false);
  const openBox = React.useCallback(() => setBoxOpen(true), []);

  return (
    <div
      data-testid='turn-actions'
      className={cn(
        'mt-3 flex items-center gap-2',
        // A line of its own under the reader's own message, and it keeps that
        // line whether or not anything on it is showing: a row that took no
        // space let the reply below come up under it, and the two were drawn
        // on top of each other.
        own === true && 'h-[var(--btn-compact)] justify-end',
      )}
    >
      {sentAt === undefined ? null : (
        // Said only once the server has written the message down, which is
        // where this instant comes from. The clock on this machine is not
        // asked to stand in for it in the stretch before that: two messages a
        // moment apart would then be timed by two different clocks.
        //
        // The reader's own day: an absolute instant arrives, and a Date reads
        // it in the zone the reader is in. `getLocale()` rather than the
        // runtime default, which is the browser's language and not the one
        // the language switch set.
        <span
          data-testid='turn-sent-at'
          className={cn(
            'text-2xs text-muted-foreground',
            waiting && 'opacity-0 transition-opacity group-hover:opacity-100',
          )}
        >
          {new Date(sentAt).toLocaleString(getLocale(), {
            dateStyle: 'short',
            timeStyle: 'short',
          })}
        </span>
      )}
      {/* Offered only when there is something to put on the clipboard: a turn
          that searched and wrote nothing still keeps this line for its
          sources, and copying it would replace whatever the reader had
          copied with nothing at all. */}
      {text === '' ? null : (
        <span className='relative inline-flex'>
          <Button
            data-testid='turn-copy'
            variant='ghost'
            size='icon'
            className={cn(
              'size-[var(--btn-compact)] text-muted-foreground',
              // Transparent alone is not enough: it would keep taking clicks
              // and keep its place in the tab order, so a blank would copy
              // when pressed with nothing visible there.
              waiting &&
              'opacity-0 pointer-events-none transition-opacity group-hover:opacity-100 group-hover:pointer-events-auto focus-visible:opacity-100 focus-visible:pointer-events-auto',
              answered && 'text-foreground',
            )}
            aria-label={t('chat.action.copy')}
            onClick={copy}
          >
            {answered ? (
              <Check className='size-3.5' aria-hidden='true' />
            ) : (
              <Copy className='size-3.5' aria-hidden='true' />
            )}
          </Button>
          {answered ? <CopyAnswerLabel side={own === true ? 'right' : 'left'} /> : null}
        </span>
      )}
      {sources === undefined || sources.length === 0 ? null : (
        <>
          <Button
            data-testid='turn-sources'
            variant='outline'
            size='sm'
            className='h-[var(--btn-compact)] px-2 text-xs font-normal text-muted-foreground'
            onClick={openBox}
          >
            {t('chat.sources.count', { count: sources.length })}
          </Button>
          <SourceBox sources={sources} open={boxOpen} onOpenChange={setBoxOpen} />
        </>
      )}
    </div>
  );
});
