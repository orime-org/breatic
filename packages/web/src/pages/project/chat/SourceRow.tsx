// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';

import { Button } from '@web/components/ui/button';
import { ScrollArea } from '@web/components/ui/scroll-area';
import { useTranslation } from '@web/i18n/use-translation';

import { SourceChip } from '@web/pages/project/chat/SourceChip';
import type { ChatSource } from '@web/pages/project/chat/types';

/**
 * How many chips the row draws before the rest go behind the button.
 *
 * The row is one line and never scrolls, so something has to decide where it
 * stops. Measuring what fits would need the width, and the column is
 * resizable -- the count would change under the reader as they drag. A fixed
 * count keeps the row still; what it cannot show is one press away, and that
 * press shows everything rather than the remainder.
 */
const CHIPS_IN_THE_ROW = 3;

interface SourceRowProps {
  /** Every page this turn found, deduplicated. */
  sources: ChatSource[];
}

/**
 * Where a reply's answer came from, at the foot of the reply.
 *
 * Pooled across the turn's searches rather than grouped by search, and it
 * lists what the turn found rather than what the model cited -- the three
 * products whose own words say either way say the same thing: OpenAI's help
 * page calls it "cited sources and other relevant links", Google's "sources
 * and related content", and Perplexity's teardown measured ten listed against
 * two cited.
 * @param root0 - The component props.
 * @param root0.sources - Every page this turn found.
 * @returns The row, and the box when it is open.
 */
export const SourceRow = React.memo(function SourceRow({
  sources,
}: SourceRowProps): React.JSX.Element {
  const t = useTranslation();
  const [boxOpen, setBoxOpen] = React.useState(false);
  const openBox = React.useCallback(() => setBoxOpen(true), []);
  const closeBox = React.useCallback(() => setBoxOpen(false), []);

  const shown = sources.slice(0, CHIPS_IN_THE_ROW);
  const hidden = sources.length - shown.length;

  return (
    <>
      <div data-testid='source-row' className='mt-[0.85em] flex gap-2 overflow-hidden'>
        {shown.map((s) => (
          <SourceChip key={s.url} source={s} label={s.publisher} testId='source-chip' />
        ))}
        {hidden > 0 ? (
          <Button
            data-testid='source-row-more'
            variant='outline'
            size='sm'
            className='h-[var(--btn-compact)] shrink-0 px-3 text-2xs text-muted-foreground'
            onClick={openBox}
          >
            {t('chat.sources.more', { count: hidden })}
          </Button>
        ) : null}
      </div>
      {boxOpen ? <SourceBox sources={sources} onClose={closeBox} /> : null}
    </>
  );
});

interface SourceBoxProps {
  /** Every page this turn found. */
  sources: ChatSource[];
  /** Shut the box. */
  onClose: () => void;
}

/**
 * Every source the turn found, over the column it was opened from.
 *
 * Titles and full addresses, and no page text: what a reader follows a source
 * for is the page itself, and a few extracted lines here would be a worse
 * version of it that they have to read first.
 * @param root0 - The component props.
 * @param root0.sources - Every page this turn found.
 * @param root0.onClose - Shut the box.
 * @returns The box.
 */
function SourceBox({ sources, onClose }: SourceBoxProps): React.JSX.Element {
  const t = useTranslation();
  return (
    <div className='absolute inset-0 z-40' data-testid='source-box'>
      <Button
        variant={null}
        size={null}
        aria-label={t('common.close')}
        className='absolute inset-0 cursor-default bg-black/80'
        onClick={onClose}
      />
      <div className='absolute inset-4 z-10 flex flex-col overflow-hidden rounded-content-md border border-border bg-popover shadow-lg'>
        <div className='flex items-center justify-between px-4 py-3'>
          <span className='text-sm font-medium'>{t('chat.sources.title')}</span>
          <Button
            variant='ghost'
            size='sm'
            className='h-[var(--btn-compact)] px-2 text-xs text-muted-foreground'
            onClick={onClose}
          >
            {t('common.close')}
          </Button>
        </div>
        <ScrollArea className='min-h-0 flex-1' viewportClassName='px-2 pb-3'>
          <div className='flex flex-col gap-0.5'>
            {sources.map((s) => (
              <a
                key={s.url}
                data-testid='source-box-row'
                href={s.url}
                target='_blank'
                rel='noreferrer noopener'
                className='flex flex-col gap-0.5 rounded-chrome px-3 py-2 no-underline hover:bg-accent'
              >
                <span className='truncate text-xs text-foreground'>{s.title}</span>
                <span className='truncate text-2xs text-muted-foreground'>{s.url}</span>
              </a>
            ))}
          </div>
        </ScrollArea>
      </div>
    </div>
  );
}
