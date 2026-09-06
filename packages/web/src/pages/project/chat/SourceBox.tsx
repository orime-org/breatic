// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';

import { ScrollArea } from '@web/components/ui/scroll-area';
import { useTranslation } from '@web/i18n/use-translation';

import { CITATION_RING } from '@web/pages/project/chat/CitationMark';
import { ReplyBox } from '@web/pages/project/chat/ReplyBox';
import type { ChatSource } from '@web/pages/project/chat/types';

interface SourceBoxProps {
  /** Every page this turn found, deduplicated. */
  sources: ChatSource[];
  /** Whether the box is up. */
  open: boolean;
  /** Called when the reader shuts it. */
  onOpenChange: (open: boolean) => void;
}

/**
 * Every source the turn found, opened from the line under the reply.
 *
 * Titles and full addresses, and no page text: what a reader follows a source
 * for is the page itself, and a few extracted lines here would be a worse
 * version of it that they have to read first.
 *
 * Pooled across the turn's searches rather than grouped by search, and it
 * lists what the turn found rather than what the model cited -- the three
 * products whose own words say either way say the same thing: OpenAI's help
 * page calls it "cited sources and other relevant links", Google's "sources
 * and related content", and Perplexity's teardown measured ten listed against
 * two cited.
 * @param root0 - The component props.
 * @param root0.sources - Every page this turn found.
 * @param root0.open - Whether the box is up.
 * @param root0.onOpenChange - Called when the reader shuts it.
 * @returns The box.
 */
export const SourceBox = React.memo(function SourceBox({
  sources,
  open,
  onOpenChange,
}: SourceBoxProps): React.JSX.Element {
  const t = useTranslation();
  return (
    <ReplyBox
      open={open}
      onOpenChange={onOpenChange}
      testId='source-box'
      title={t('chat.sources.count', { count: sources.length })}
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
              className='flex gap-2 rounded-chrome px-3 py-2 no-underline hover:bg-accent'
            >
              {/* Every number the turn handed this page, so a marker in the
                  prose can be found here whichever of them it carries. They
                  are one thing about this page rather than several: kept in a
                  group of their own, so the space between two of them reads
                  differently from the space before the title, and a page with
                  a great many of them wraps instead of squeezing the title
                  out of the line. */}
              <span
                data-testid='source-box-marks'
                className='mt-px flex max-w-[40%] shrink-0 flex-wrap gap-0.5'
              >
                {s.indexes.map((n) => (
                  <span key={n} className={CITATION_RING}>
                    {n}
                  </span>
                ))}
              </span>
              <span className='flex min-w-0 flex-col gap-0.5'>
                <span className='truncate text-xs text-foreground'>{s.title}</span>
                <span className='truncate text-2xs text-muted-foreground'>{s.url}</span>
              </span>
            </a>
          ))}
        </div>
      </ScrollArea>
    </ReplyBox>
  );
});
