// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { ChevronDown, Pause, Play, Volume2 } from 'lucide-react';
import * as React from 'react';

import type { Voice } from '@breatic/shared';

import { Button } from '@web/components/ui/button';
import { Input } from '@web/components/ui/input';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@web/components/ui/popover';
import { ScrollArea } from '@web/components/ui/scroll-area';
import { Skeleton } from '@web/components/ui/skeleton';
import { useTranslation } from '@web/i18n/use-translation';
import { cn } from '@web/lib/utils';
import { useFollowCanvasViewport } from '@web/spaces/canvas/generate/use-follow-canvas-viewport';
import type { VoiceListState } from '@web/spaces/canvas/generate/voice-list-state';

/** How close to the bottom asking for the next page starts, in pixels. */
const PAGE_TRIGGER_DISTANCE = 24;

/**
 * How tall the list stands, counted in rows.
 *
 * The placeholder shows this many rows and the loaded list is capped at the
 * same height, so the popover neither collapses while a page is on its way
 * nor grows when one lands. Both matter on every keystroke, since each one
 * restarts the request, and the popover opens upward: a height that moved
 * would take the search box with it, out from under the reader's hands.
 *
 * Fewer results than this make it shorter, which is what a short list should
 * look like.
 */
const LIST_ROWS = 7;

/** A row's height on a real browser: `size='menu-item'` around two lines. */
const ROW_HEIGHT = 46;
/** The `gap-0.5` between two rows. */
const ROW_GAP = 2;

/**
 * The list body's height, which the placeholder fills exactly and the results
 * are capped at. Both read it off this one value, so the two agree whatever a
 * row turns out to measure.
 */
const LIST_BODY_HEIGHT = `${LIST_ROWS * ROW_HEIGHT + (LIST_ROWS - 1) * ROW_GAP}px`;

interface VoicePickerProps {
  /** Where the list is, owned by the container's reducer. */
  list: VoiceListState;
  /** The id held in the node's param record, or null when none is. */
  selectedId: string | null;
  /** That voice's name once fetched. Null while unknown. */
  selectedName: string | null;
  /** Opening asks for a page; collapsing throws the list away. */
  onOpenChange: (open: boolean) => void;
  /** What the user typed. Searched upstream. */
  onQueryChange: (query: string) => void;
  /** The voice the user chose. */
  onPick: (voice: Voice) => void;
  /** The list reached its end and there is another page. */
  onLoadMore: () => void;
}

/**
 * The Generate panel's voice picker: a pill naming the chosen voice that opens
 * a searchable list of what this deployment's provider offers.
 *
 * The rows are the option shape every other single-choice dropdown in this app
 * uses — a column of ghost menu-item Buttons, chosen one filled with
 * `accent-strong` (LangSwitcher, ThemeToggle, ModelPicker, ModeToggle,
 * ParamOptionGroup). Being real buttons they take Tab and draw their own focus
 * ring, and the fill is the whole mark for the chosen one.
 *
 * Searching happens upstream, so what is rendered is exactly what the server
 * sent.
 *
 * Samples play through one audio element held here, so starting one stops
 * whatever was playing. Two at once is two voices over each other.
 * @param root0 - Component props.
 * @param root0.list - The list state.
 * @param root0.selectedId - The stored voice id.
 * @param root0.selectedName - That voice's name, once known.
 * @param root0.onOpenChange - Called when the list opens or collapses.
 * @param root0.onQueryChange - Called with what the user typed.
 * @param root0.onPick - Called with the chosen voice.
 * @param root0.onLoadMore - Called when the list reaches its end.
 * @returns The voice picker.
 */
export const VoicePicker = React.memo(function VoicePicker({
  list,
  selectedId,
  selectedName,
  onOpenChange,
  onQueryChange,
  onPick,
  onLoadMore,
}: VoicePickerProps): React.JSX.Element {
  const t = useTranslation();
  const [open, setOpen] = React.useState(false);
  // Follow the ReactFlow viewport while open (#1796): Radix's Floating-UI
  // auto-update reacts to scroll / resize but not to the canvas's
  // CSS-transform pan/zoom, so the popover would drift off its trigger.
  useFollowCanvasViewport(open);

  const audioRef = React.useRef<HTMLAudioElement | null>(null);
  const [playingId, setPlayingId] = React.useState<string | null>(null);
  React.useEffect(
    () => () => {
      audioRef.current?.pause();
      audioRef.current = null;
    },
    [],
  );

  const handleOpenChange = React.useCallback(
    (next: boolean) => {
      setOpen(next);
      onOpenChange(next);
      if (!next) {
        audioRef.current?.pause();
        setPlayingId(null);
      }
    },
    [onOpenChange],
  );

  const handlePick = React.useCallback(
    (voice: Voice) => {
      onPick(voice);
      handleOpenChange(false);
    },
    [onPick, handleOpenChange],
  );

  const toggleSample = React.useCallback(
    (voice: Voice) => {
      audioRef.current?.pause();
      if (playingId === voice.id) {
        setPlayingId(null);
        return;
      }
      const audio = new Audio(voice.previewUrl);
      audioRef.current = audio;
      audio.addEventListener('ended', () => setPlayingId(null));
      setPlayingId(voice.id);
      void audio.play().catch(() => {
        // Autoplay policy, a dead url, an unsupported codec: the sample is a
        // convenience, and the voice stays pickable either way.
        setPlayingId(null);
      });
    },
    [playingId],
  );

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

  const triggerLabel =
    selectedName ?? selectedId ?? t('canvas.generatePanel.voicePlaceholder');

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          type='button'
          variant={null}
          size={null}
          data-testid='generate-voice-trigger'
          // Truncation here is the intended behaviour, not a shortfall: the
          // first characters name the voice well enough to recognise, and the
          // full name is one click away in the list. The cap is what keeps
          // this row inside the panel's own width (user 2026-09-02).
          className='flex h-8 min-w-0 max-w-[11rem] items-center gap-1 rounded-full border border-border bg-background px-2.5 text-xs text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'
        >
          <Volume2 className='h-4 w-4 shrink-0' aria-hidden='true' />
          <span className='truncate'>{triggerLabel}</span>
          <ChevronDown
            className='h-3.5 w-3.5 shrink-0 opacity-60'
            aria-hidden='true'
          />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side='top'
        align='start'
        // Clip rather than flip at a screen edge: a following popover that
        // flipped would fight the follow and jump as the canvas pans (#1788).
        avoidCollisions={false}
        // 20rem, which is where the model picker's own width tops out. Fixed
        // rather than auto because the list changes with every keystroke, and
        // a width that follows its content would jump as the user types.
        className='w-80 p-0'
        style={{ '--voice-list-body': LIST_BODY_HEIGHT } as React.CSSProperties}
      >
        <div className='border-b border-border p-2'>
          <Input
            data-testid='generate-voice-search'
            value={list.query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder={t('canvas.generatePanel.voiceSearchPlaceholder')}
            className='h-8 text-sm'
          />
        </div>
        {/* Taller than the model picker's list, which this height does not
            answer to: that one offers a handful of models under no search box,
            this one offers every voice the deployment has (52 on the inline
            catalogue) under one (user 2026-09-02). */}
        <ScrollArea
          viewportRef={setScroller}
          // The body plus the `p-1` this same class states, so the loaded list
          // stops exactly where the placeholder stood.
          viewportClassName='max-h-[calc(var(--voice-list-body)+0.5rem)] p-1'
        >
          <div className='flex flex-col gap-0.5'>
            {list.status === 'loading' && (
              // The placeholder is one block of the body's own height sharing
              // itself between rows, rather than rows of a height guessed here:
              // that way it fills the body exactly whatever a real row measures.
              <div
                className='flex flex-col gap-0.5'
                style={{ height: 'var(--voice-list-body)' }}
              >
                {Array.from({ length: LIST_ROWS }, (_, i) => (
                  <Skeleton
                    key={i}
                    data-testid='generate-voice-skeleton'
                    className='min-h-0 flex-1'
                  />
                ))}
              </div>
            )}
            {list.status === 'empty' && (
              <p
                data-testid='generate-voice-empty'
                className='py-6 text-center text-sm text-muted-foreground'
              >
                {t('canvas.generatePanel.voiceEmpty')}
              </p>
            )}
            {list.status === 'failed' && (
              <div
                data-testid='generate-voice-error'
                className='flex flex-col items-center gap-2 py-6 text-sm text-muted-foreground'
              >
                <span>{t('canvas.generatePanel.voiceError')}</span>
                <Button
                  type='button'
                  variant='outline'
                  size='sm'
                  data-testid='generate-voice-retry'
                  onClick={() => onOpenChange(true)}
                >
                  {t('canvas.generatePanel.voiceRetry')}
                </Button>
              </div>
            )}
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
                    onClick={() => handlePick(voice)}
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
                    <Button
                      type='button'
                      variant={null}
                      size={null}
                      data-testid={`generate-voice-sample-${voice.id}`}
                      data-playing={playingId === voice.id}
                      aria-label={t('canvas.generatePanel.voiceSample', {
                        name: voice.name,
                      })}
                      className='mr-1 flex h-[var(--btn-compact)] w-[var(--btn-compact)] shrink-0 items-center justify-center rounded-full border border-border transition-colors hover:bg-accent-strong'
                      onClick={() => toggleSample(voice)}
                    >
                      {playingId === voice.id ? (
                        <Pause className='h-3 w-3' aria-hidden='true' />
                      ) : (
                        <Play className='h-3 w-3' aria-hidden='true' />
                      )}
                    </Button>
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
                <span>{t('canvas.generatePanel.voiceError')}</span>
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
      </PopoverContent>
    </Popover>
  );
});
