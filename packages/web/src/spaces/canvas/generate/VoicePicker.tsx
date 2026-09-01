// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { ChevronDown, Play } from 'lucide-react';
import * as React from 'react';

import type { Voice } from '@breatic/shared';

import { Button } from '@web/components/ui/button';
import {
  Command,
  CommandInput,
  CommandItem,
  CommandList,
} from '@web/components/ui/command';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@web/components/ui/popover';
import { useTranslation } from '@web/i18n/use-translation';
import { cn } from '@web/lib/utils';
import { useFollowCanvasViewport } from '@web/spaces/canvas/generate/use-follow-canvas-viewport';
import type { VoiceListState } from '@web/spaces/canvas/generate/voice-list-state';

/** How close to the bottom asking for the next page starts, in pixels. */
const PAGE_TRIGGER_DISTANCE = 24;

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
 * Searching happens upstream, so cmdk's own filtering is off (`shouldFilter`).
 * Leaving it on hides voices the server just sent whose names do not match the
 * term locally, and the picker then claims no matches over a list that has
 * them.
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
      if (!next) audioRef.current?.pause();
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

  const playSample = React.useCallback((url: string) => {
    audioRef.current?.pause();
    const audio = new Audio(url);
    audioRef.current = audio;
    void audio.play().catch(() => {
      // Autoplay policy, a dead url, an unsupported codec: the sample is a
      // convenience, and the voice stays pickable either way.
    });
  }, []);

  // The listener goes on the element that scrolls, which the ScrollArea inside
  // CommandList owns. It arrives through a callback ref rather than a plain
  // one: the popover renders into a portal, so on the render that opens it the
  // viewport does not exist yet and an effect reading a ref would find null.
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
          className='flex h-8 min-w-0 max-w-[12rem] items-center gap-1 rounded-full border border-border bg-background px-2.5 text-xs text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'
        >
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
      >
        <Command shouldFilter={false}>
          <CommandInput
            data-testid='generate-voice-search'
            value={list.query}
            onValueChange={onQueryChange}
            placeholder={t('canvas.generatePanel.voiceSearchPlaceholder')}
          />
          {/* The scroll listener has to sit on the element that actually
              scrolls, which is the ScrollArea viewport CommandList wraps its
              children in — so it comes from there rather than from a container
              of our own. */}
          <CommandList
            viewportRef={setScroller}
            viewportClassName='max-h-52'
          >
            <div className='flex flex-col gap-0.5 p-1'>
              {list.status === 'loading' && (
                <p
                  data-testid='generate-voice-loading'
                  className='py-6 text-center text-sm text-muted-foreground'
                >
                  {t('canvas.generatePanel.voiceLoading')}
                </p>
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
              {list.voices.map((voice) => (
                <CommandItem
                  key={voice.id}
                  value={voice.id}
                  data-testid={`generate-voice-option-${voice.id}`}
                  onSelect={() => handlePick(voice)}
                  className={cn(
                    // Same row chrome as the model picker's ghost menu-item
                    // Buttons: 6px corners, and hover lifts the label as well
                    // as the fill.
                    'gap-2 rounded-chrome hover:text-accent-foreground',
                    voice.id === selectedId
                      ? // cmdk marks whatever the pointer or the arrow keys
                    // landed on with data-selected, and CommandItem draws
                    // that as plain accent. That is a class plus an
                    // attribute, which outranks a single class, so the
                    // chosen fill has to answer in the same shape or it
                    // drops to its neighbours' colour under the pointer.
                      'bg-accent-strong data-[selected=\'true\']:bg-accent-strong hover:bg-accent-strong'
                      : 'hover:bg-accent',
                  )}
                >
                  {voice.previewUrl !== undefined && (
                    <Button
                      type='button'
                      variant={null}
                      size={null}
                      data-testid={`generate-voice-sample-${voice.id}`}
                      aria-label={t('canvas.generatePanel.voiceSample', {
                        name: voice.name,
                      })}
                      className='flex h-[var(--btn-compact)] w-[var(--btn-compact)] shrink-0 items-center justify-center rounded-full border border-border transition-colors hover:bg-accent-strong'
                      onClick={(e) => {
                        // cmdk hangs onSelect off the item's own onClick, so
                        // a sample click that reached it would choose the
                        // voice as well as play it.
                        e.stopPropagation();
                        playSample(voice.previewUrl as string);
                      }}
                    >
                      <Play className='h-3 w-3' aria-hidden='true' />
                    </Button>
                  )}
                  <span className='flex min-w-0 flex-1 flex-col'>
                    <span className='truncate'>{voice.name}</span>
                    {voice.description !== undefined && (
                      <span className='truncate text-xs text-muted-foreground'>
                        {voice.description}
                      </span>
                    )}
                  </span>
                </CommandItem>
              ))}
              {list.loadingMore && (
                <p
                  data-testid='generate-voice-loading-more'
                  className='py-2 text-center text-xs text-muted-foreground'
                >
                  {t('canvas.generatePanel.voiceLoading')}
                </p>
              )}
            </div>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
});
