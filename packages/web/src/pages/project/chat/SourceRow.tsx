// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';

import { Button } from '@web/components/ui/button';
import { ScrollArea } from '@web/components/ui/scroll-area';
import { useTranslation } from '@web/i18n/use-translation';

import { ReplyBox } from '@web/pages/project/chat/ReplyBox';
import { fitsInRow, useRowMeasure } from '@web/pages/project/chat/row-fit';
import { SourceChip } from '@web/pages/project/chat/SourceChip';
import type { ChatSource } from '@web/pages/project/chat/types';

/** The gap between two chips, and how wide the button after them is. */
const GAP_PX = 8;
const MORE_PX = 28;

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

  const { room, items, rowPx, widths } = useRowMeasure();
  // Publishers' names are each their own length, so what fits is measured
  // rather than assumed. The room is read off the outer row, which nothing
  // here sizes; the widths off the strip inside it. Only what fits is drawn,
  // so nothing hidden keeps a tab stop or a place in what a screen reader
  // reads out.
  const shown =
    rowPx === 0 || widths.length === 0
      ? sources.length
      : fitsInRow(widths, GAP_PX, rowPx, MORE_PX);
  const hidden = sources.length - shown;

  return (
    <>
      <div data-testid='source-row' className='mt-[0.85em] flex items-center gap-2'>
        {/* Outside the measured row, so the room the chips are counted
            against is what is left beside it. */}
        <span data-testid='source-row-label' className='shrink-0 text-xs text-muted-foreground'>
          {t('chat.sources.label')}
        </span>
        <div ref={room} className='flex min-w-0 flex-1 gap-2 overflow-hidden'>
          <div ref={items} className='flex gap-2'>
            {sources.slice(0, shown).map((s) => (
              <SourceChip key={s.url} source={s} label={s.publisher} testId='source-chip' />
            ))}
          </div>
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
      </div>
      <SourceBox sources={sources} open={boxOpen} onOpenChange={setBoxOpen} />
    </>
  );
});

interface SourceBoxProps {
  /** Every page this turn found. */
  sources: ChatSource[];
  /** Whether the box is up. */
  open: boolean;
  /** Called when the reader shuts it. */
  onOpenChange: (open: boolean) => void;
}

/**
 * Every source the turn found, over the column it was opened from.
 *
 * Titles and full addresses, and no page text: what a reader follows a source
 * for is the page itself, and a few extracted lines here would be a worse
 * version of it that they have to read first.
 * @param root0 - The component props.
 * @param root0.sources - Every page this turn found.
 * @param root0.open - Whether the box is up.
 * @param root0.onOpenChange - Called when the reader shuts it.
 * @returns The box.
 */
function SourceBox({ sources, open, onOpenChange }: SourceBoxProps): React.JSX.Element {
  const t = useTranslation();
  return (
    <ReplyBox
      open={open}
      onOpenChange={onOpenChange}
      testId='source-box'
      title={t('chat.sources.title')}
    >
      <ScrollArea className='min-h-0 flex-1' viewportClassName='px-2 py-2'>
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
    </ReplyBox>
  );
}
