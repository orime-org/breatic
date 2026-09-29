// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { Loader2 } from 'lucide-react';
import * as React from 'react';

import type { Voice } from '@breatic/shared';

import { Button } from '@web/components/ui/button';
import { Input } from '@web/components/ui/input';
import { ScrollArea } from '@web/components/ui/scroll-area';
import { useTranslation } from '@web/i18n/use-translation';
import { cn } from '@web/lib/utils';
import { SampleButton } from '@web/spaces/canvas/generate/SampleButton';
import type { SamplePlayer } from '@web/spaces/canvas/generate/use-sample-player';
import type { VoiceListState } from '@web/spaces/canvas/generate/voice-list-state';

/** How close to the bottom asking for the next page starts, in pixels. */
const PAGE_TRIGGER_DISTANCE = 24;

/**
 * How tall the list stands, counted in rows.
 *
 * The height is the same in every state: a full result set scrolls inside it,
 * a short one leaves the space below empty, and the loading and empty lines
 * centre in it. The popover opens upward, so a box that grew and shrank with
 * its contents would take the search box with it, out from under the reader's
 * hands — and on every keystroke, since each one restarts the request.
 */
const LIST_ROWS = 5;

/** A row's height on a real browser: `size='menu-item'` around two lines. */
const ROW_HEIGHT = 46;
/** The `gap-0.5` between two rows. */
const ROW_GAP = 2;

/** The `p-1` the rows sit inside, top and bottom. */
const LIST_PADDING = 4;

/**
 * The one height every state of this list stands at.
 *
 * Counts the padding as well as the rows: the box is `border-box`, so a height
 * of just the rows has its own inset taken out of that same number and the
 * last row comes up a padding short of a row.
 */
export const LIST_BODY_HEIGHT = `${
  LIST_ROWS * ROW_HEIGHT + (LIST_ROWS - 1) * ROW_GAP + 2 * LIST_PADDING
}px`;

interface VoiceListProps {
  /** Where the list is, owned by the container's reducer. */
  list: VoiceListState;
  /** The id held in the node's param record, or null when none is. */
  selectedId: string | null;
  /** What the user typed. Searched upstream. */
  onQueryChange: (query: string) => void;
  /** The voice the user chose. */
  onPick: (voice: Voice) => void;
  /** The list reached its end and there is another page. */
  onLoadMore: () => void;
  /** Ask for the list again after it failed. */
  onRetry: () => void;
  /** The one player every sample in the settings panel goes through. */
  player: SamplePlayer;
}

/**
 * The voice list the audio settings panel opens beside itself (#2156, design
 * §16): a search box over what this deployment's provider offers.
 *
 * The rows are the option shape every other single-choice dropdown in this app
 * uses — a column of ghost menu-item Buttons, chosen one filled with
 * `accent-strong` (LangSwitcher, ThemeToggle, ModelPicker, ModeToggle,
 * ParamOptionGroup). Being real buttons they take Tab and draw their own focus
 * ring, and the fill is the whole mark for the chosen one.
 *
 * Searching happens upstream, so what is rendered is exactly what the server
 * sent.
 * @param root0 - Component props.
 * @param root0.list - The list state.
 * @param root0.selectedId - The stored voice id.
 * @param root0.onQueryChange - Called with what the user typed.
 * @param root0.onPick - Called with the chosen voice.
 * @param root0.onLoadMore - Called when the list reaches its end.
 * @param root0.onRetry - Called to ask for the list again.
 * @param root0.player - Plays the samples.
 * @returns The voice list.
 */
export const VoiceList = React.memo(function VoiceList({
  list,
  selectedId,
  onQueryChange,
  onPick,
  onLoadMore,
  onRetry,
  player,
}: VoiceListProps): React.JSX.Element {
  const t = useTranslation();

  // The listener goes on the element that scrolls, which the ScrollArea owns.
  // It arrives through a callback ref rather than a plain one: the popover
  // renders into a portal, so on the render that opens it the viewport does
  // not exist yet and an effect reading a ref would find null.
  const [scroller, setScroller] = React.useState<HTMLDivElement | null>(null);
  const hasMore = list.hasMore;
  const loadingMore = list.loadingMore;
  React.useEffect(() => {
    if (!scroller || !hasMore || loadingMore) return;
    /** Asks for the next page once the end of this one is in reach. */
    const onScroll = (): void => {
      const remaining =
        scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop;
      if (remaining <= PAGE_TRIGGER_DISTANCE) onLoadMore();
    };
    scroller.addEventListener('scroll', onScroll);
    return () => scroller.removeEventListener('scroll', onScroll);
  }, [scroller, hasMore, loadingMore, onLoadMore]);

  return (
    <div className='flex flex-col'>
      <div className='border-b border-border p-2'>
        <Input
          data-testid='generate-voice-search'
          value={list.query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder={t('canvas.generatePanel.voiceSearchPlaceholder')}
          className='h-8 text-sm'
        />
      </div>
      {/* One height for every state this list can be in. A box that grew with
          its contents would move under the reader on each keystroke, since the
          popover opens upward and a search changes how many rows there are —
          so a short result set leaves the space below it empty instead
          (user 2026-09-03). */}
      <div
        data-testid='generate-voice-list-body'
        className='p-1'
        style={{ height: LIST_BODY_HEIGHT }}
      >
        {list.status === 'loading' && (
          // A line rather than blocks of grey standing in for rows: this
          // popover opens over a canvas someone is working on, and those
          // blocks read as movement on a surface that is already busy
          // (user 2026-09-03).
          <p
            data-testid='generate-voice-loading'
            className='flex h-full items-center justify-center gap-2 text-sm text-muted-foreground'
          >
            <Loader2
              className='h-3.5 w-3.5 animate-spin'
              aria-hidden='true'
            />
            {t('canvas.generatePanel.voiceLoading')}
          </p>
        )}
        {list.status === 'empty' && (
          // Centred, and outside the ScrollArea: its viewport wraps content in
          // an auto-height table box, where a full-height child collapses.
          <p
            data-testid='generate-voice-empty'
            className='flex h-full items-center justify-center text-sm text-muted-foreground'
          >
            {t('canvas.generatePanel.voiceEmpty')}
          </p>
        )}
        {list.status === 'failed' && (
          <div
            data-testid='generate-voice-error'
            className='flex h-full flex-col items-center justify-center gap-2 text-sm text-muted-foreground'
          >
            <span>{t('canvas.generatePanel.voiceError')}</span>
            <Button
              type='button'
              variant='outline'
              size='sm'
              data-testid='generate-voice-retry'
              onClick={onRetry}
            >
              {t('canvas.generatePanel.voiceRetry')}
            </Button>
          </div>
        )}
        {(list.status === 'ready' || list.status === 'idle') && (
          <ScrollArea viewportRef={setScroller} className='h-full'>
            <div className='flex flex-col gap-0.5'>
              {list.voices.map((voice) => {
                const chosen = voice.id === selectedId;
                return (
                  // The row carries the fill and the hover, and the two controls
                  // sit inside it as siblings: a sample button nested in the row
                  // button would be a button inside a button, which the content
                  // model does not allow. The model picker's rows have one
                  // control and are a single Button.
                  <div
                    key={voice.id}
                    className={cn(
                      'flex items-center gap-1 rounded-chrome',
                      chosen ? 'bg-accent-strong' : 'hover:bg-accent',
                    )}
                  >
                    <Button
                      type='button'
                      variant='ghost'
                      size='menu-item'
                      aria-pressed={chosen}
                      data-testid={`generate-voice-option-${voice.id}`}
                      className='min-w-0 flex-1 justify-start hover:bg-transparent'
                      onClick={() => onPick(voice)}
                    >
                      <span className='flex min-w-0 flex-1 flex-col items-start'>
                        <span className='w-full truncate text-left'>
                          {voice.name}
                        </span>
                        {voice.description !== undefined && (
                          <span className='w-full truncate text-left text-xs text-muted-foreground'>
                            {voice.description}
                          </span>
                        )}
                      </span>
                    </Button>
                    {voice.previewUrl !== undefined && (
                      <SampleButton
                        name={voice.name}
                        testId={`generate-voice-sample-${voice.id}`}
                        playing={player.playing === voice.id}
                        onToggle={() => player.toggle(voice.id, voice.previewUrl ?? '')}
                      />
                    )}
                  </div>
                );
              })}
              {list.loadingMore && (
                <p
                  data-testid='generate-voice-loading-more'
                  className='py-2 text-center text-xs text-muted-foreground'
                >
                  {t('canvas.generatePanel.voiceLoading')}
                </p>
              )}
              {list.moreFailed && !list.loadingMore && (
                // Scrolling again would retry on its own, but only after the
                // reader scrolls up and back down — from where they are
                // standing the list just stopped.
                <div className='flex items-center justify-center gap-2 py-2 text-xs text-muted-foreground'>
                  {/* Its own sentence: the whole-list one is written for an
                        empty list, and here a full page is on screen. */}
                  <span>{t('canvas.generatePanel.voiceMoreError')}</span>
                  <Button
                    type='button'
                    variant='outline'
                    size='sm'
                    data-testid='generate-voice-more-retry'
                    onClick={onLoadMore}
                  >
                    {t('canvas.generatePanel.voiceRetry')}
                  </Button>
                </div>
              )}
            </div>
          </ScrollArea>
        )}
      </div>
    </div>
  );
});
