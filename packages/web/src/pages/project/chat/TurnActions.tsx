// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { Check, Copy } from 'lucide-react';

import { getLocale } from '@breatic/shared';

import { Button } from '@web/components/ui/button';
import { cn } from '@web/lib/utils';
import { toast } from '@web/lib/toast';
import { useTranslation } from '@web/i18n/use-translation';

import { SourceBox } from '@web/pages/project/chat/SourceBox';
import type { ChatSource } from '@web/pages/project/chat/types';

/**
 * How long the answer to a press stays up.
 *
 * Long enough to be read after the eye has moved on, short enough that the
 * line is back to offering copy before the reader thinks to press it again.
 */
export const COPY_ANSWER_MS = 1600;

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
  const [answered, setAnswered] = React.useState(false);
  const [boxOpen, setBoxOpen] = React.useState(false);
  const openBox = React.useCallback(() => setBoxOpen(true), []);
  const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  React.useEffect(
    () => () => {
      if (timer.current !== undefined) clearTimeout(timer.current);
    },
    [],
  );

  const copy = React.useCallback(() => {
    void navigator.clipboard
      .writeText(text)
      .then(() => {
        // A second press while the answer is up leaves the first timer
        // running, so the answer neither flickers nor outstays the press
        // that put it there.
        if (timer.current !== undefined) return;
        setAnswered(true);
        timer.current = setTimeout(() => {
          timer.current = undefined;
          setAnswered(false);
        }, COPY_ANSWER_MS);
      })
      .catch(() => {
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
        own === true ? 'mt-1 h-[var(--btn-compact)] justify-end' : 'mt-[0.85em]',
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
      {/* Offered only when there is something to put on the clipboard: a turn
          that searched and wrote nothing still keeps this line for its
          sources, and copying it would replace whatever the reader had
          copied with nothing at all.

          The answer to a press is a status rather than a description of the
          control, so it is said here rather than through the tooltip
          primitive: a tooltip is what hovering an element tells you about it,
          and this is what pressing it did. Nothing in it can be pointed at,
          so it needs none of what a real overlay is for. */}
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
              own === true &&
              'opacity-0 pointer-events-none transition-opacity group-hover:opacity-100 group-hover:pointer-events-auto focus-visible:opacity-100 focus-visible:pointer-events-auto',
              // A press answers with a mark, and the answer is worth seeing
              // even on a message whose line is otherwise waiting for hover.
              answered && 'opacity-100 pointer-events-auto text-foreground',
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
          {answered ? (
            <span
              data-testid='turn-copied'
              role='status'
              className={cn(
                'pointer-events-none absolute bottom-full z-10 mb-1.5 whitespace-nowrap rounded-chrome bg-accent-strong px-2 py-1 text-2xs leading-none text-foreground',
                // Against the edge the button is against. Centred on the button
                // it reaches half its width past the column, and the list is
                // clipped: measured at 1315 wide, the Chinese words already lost
                // 6px off the left, and the Japanese ones lose four times that.
                own === true ? 'right-0' : 'left-0',
              )}
            >
              {t('chat.action.copied')}
            </span>
          ) : null}
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
