// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { ChevronLeft, ChevronRight } from 'lucide-react';
import * as React from 'react';

import { Badge } from '@web/components/ui/badge';
import { Button } from '@web/components/ui/button';
import { Label } from '@web/components/ui/label';
import { ScrollArea } from '@web/components/ui/scroll-area';
import { Tooltip, TooltipContent, TooltipTrigger } from '@web/components/ui/tooltip';
import { endsAfter, scrollTargetFor, startsBefore, type Span } from '@web/lib/strip-scroll';
import { cn } from '@web/lib/utils';
import { SPACE_TYPE_ICON } from '@web/spaces/space-type-icon';
import { type SpaceType } from '@breatic/shared';

import { useTranslation } from '@web/i18n/use-translation';

interface SpaceKindPickerProps {
  /** The currently selected space type. */
  value: SpaceType;
  /** Called with the chosen type when a card is clicked. */
  onChange: (type: SpaceType) => void;
  /**
   * Prefix for the cards' `data-testid` + radiogroup test id, so the two
   * dialogs that embed this picker (new-space on the project page,
   * new-project on the studio page) get non-colliding hooks. Defaults to
   * `space-kind`.
   */
  idPrefix?: string;
}

interface TypeCardMeta {
  type: SpaceType;
  titleKey: 'spaces.kind.canvas' | 'spaces.kind.document' | 'spaces.kind.timeline' | 'spaces.kind.threeD' | 'spaces.kind.webAnimation';
  descriptionKey: 'spaces.kind.canvasSub' | 'spaces.kind.documentSub' | 'spaces.kind.timelineSub' | 'spaces.kind.threeDSub' | 'spaces.kind.webAnimationSub';
}

const TYPE_CARDS: ReadonlyArray<TypeCardMeta> = [
  {
    type: 'canvas',
    titleKey: 'spaces.kind.canvas',
    descriptionKey: 'spaces.kind.canvasSub',
  },
  {
    type: 'document',
    titleKey: 'spaces.kind.document',
    descriptionKey: 'spaces.kind.documentSub',
  },
  { type: '3d', titleKey: 'spaces.kind.threeD', descriptionKey: 'spaces.kind.threeDSub' },
  {
    type: 'timeline',
    titleKey: 'spaces.kind.timeline',
    descriptionKey: 'spaces.kind.timelineSub',
  },
  {
    type: 'web_animation',
    titleKey: 'spaces.kind.webAnimation',
    descriptionKey: 'spaces.kind.webAnimationSub',
  },
];

/** The types still in development, which carry the DEV badge. */
const IN_DEVELOPMENT: ReadonlySet<SpaceType> = new Set(['3d', 'timeline', 'web_animation']);

/** How wide the fade is on a side the row can still scroll to; a landed card stays clear of it and its arrow. */
const FADE_PX = 56;

/** How far one line of a line-based wheel moves the row. */
const WHEEL_LINE_PX = 16;

/** Which sides the row can still scroll to. */
interface RowEdges {
  start: boolean;
  end: boolean;
}

/**
 * Which sides a row can still scroll to.
 * @param viewport - The row's scroller.
 * @returns Its open sides.
 * @throws {never} Never.
 */
function edgesOf(viewport: HTMLElement): RowEdges {
  return { start: viewport.scrollLeft > 1, end: viewport.scrollLeft + viewport.clientWidth < viewport.scrollWidth - 1 };
}

/**
 * Where a card sits in the row's own coordinates.
 * @param viewport - The row's scroller.
 * @param card - The card.
 * @returns Its span.
 * @throws {never} Never.
 */
function spanOf(viewport: HTMLElement, card: HTMLElement): Span {
  const box = card.getBoundingClientRect();
  const start = box.left - viewport.getBoundingClientRect().left + viewport.scrollLeft;
  return { start, end: start + box.width };
}

/**
 * What the row shows clear of its fades.
 * @param viewport - The row's scroller.
 * @returns The visible span, less the fade on each side that can still scroll.
 * @throws {never} Never.
 */
function clearSpan(viewport: HTMLElement): Span {
  const edges = edgesOf(viewport);
  return {
    start: viewport.scrollLeft + (edges.start ? FADE_PX : 0),
    end: viewport.scrollLeft + viewport.clientWidth - (edges.end ? FADE_PX : 0),
  };
}

/**
 * The scroll position that rests a card against one side, just inside the fade that side keeps while the row can
 * still scroll past it.
 * @param viewport - The row's scroller.
 * @param span - The card.
 * @param edge - The side it rests against.
 * @returns The scroll position, within the row's range.
 * @throws {never} Never.
 */
function landing(viewport: HTMLElement, span: Span, edge: 'start' | 'end'): number {
  const max = viewport.scrollWidth - viewport.clientWidth;
  const target = edge === 'end'
    ? span.end - viewport.clientWidth + (span.end < viewport.scrollWidth - 1 ? FADE_PX : 0)
    : span.start - (span.start > 1 ? FADE_PX : 0);
  return Math.max(0, Math.min(target, max));
}

/**
 * The Project and Space creation dialogs share this control so type labels
 * and ordering stay consistent across both entry points.
 * @param root0 - Component props.
 * @param root0.value - The currently selected space type.
 * @param root0.onChange - Called with the chosen type when a card is clicked.
 * @param root0.idPrefix - Prefix for the cards' + group's `data-testid`.
 * @returns The labelled space-type segmented control.
 */
export function SpaceKindPicker({
  value,
  onChange,
  idPrefix = 'space-kind',
}: SpaceKindPickerProps): React.JSX.Element {
  const t = useTranslation();
  const viewportRef = React.useRef<HTMLDivElement | null>(null);
  const cardRefs = React.useRef(new Map<SpaceType, HTMLElement>());
  const [edges, setEdges] = React.useState<RowEdges>({ start: false, end: false });

  const setViewport = React.useCallback((node: HTMLDivElement | null): void => {
    viewportRef.current = node;
    node?.setAttribute('data-testid', `${idPrefix}-viewport`);
  }, [idPrefix]);

  const readEdges = React.useCallback((): void => {
    const viewport = viewportRef.current;
    if (viewport === null) return;
    const next = edgesOf(viewport);
    setEdges((now) => (now.start === next.start && now.end === next.end ? now : next));
  }, []);

  React.useEffect(() => {
    const viewport = viewportRef.current;
    if (viewport === null) return undefined;
    readEdges();
    /**
     * Turn a vertical wheel into a sideways scroll; a sideways swipe is the browser's.
     * @param event - The turn.
     */
    const onWheel = (event: WheelEvent): void => {
      if (event.ctrlKey || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      event.preventDefault();
      viewport.scrollLeft += event.deltaMode === WheelEvent.DOM_DELTA_LINE ? event.deltaY * WHEEL_LINE_PX : event.deltaY;
    };
    viewport.addEventListener('scroll', readEdges, { passive: true });
    viewport.addEventListener('wheel', onWheel, { passive: false });
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(readEdges) : null;
    observer?.observe(viewport);
    return (): void => {
      viewport.removeEventListener('scroll', readEdges);
      viewport.removeEventListener('wheel', onWheel);
      observer?.disconnect();
    };
  }, [readEdges]);

  const reveal = React.useCallback((type: SpaceType): void => {
    const viewport = viewportRef.current;
    const card = cardRefs.current.get(type);
    if (viewport === null || card === undefined) return;
    const span = spanOf(viewport, card);
    const visible = clearSpan(viewport);
    if (scrollTargetFor(span, visible) === null) return;
    viewport.scrollTo({ left: landing(viewport, span, endsAfter(span, visible) ? 'end' : 'start'), behavior: 'smooth' });
  }, []);

  const step = React.useCallback((edge: 'start' | 'end'): void => {
    const viewport = viewportRef.current;
    if (viewport === null) return;
    const visible = clearSpan(viewport);
    const spans = TYPE_CARDS.flatMap((card) => {
      const element = cardRefs.current.get(card.type);
      return element === undefined ? [] : [spanOf(viewport, element)];
    });
    const next = edge === 'end' ? spans.find((span) => endsAfter(span, visible)) : spans.findLast((span) => startsBefore(span, visible));
    if (next !== undefined) viewport.scrollTo({ left: landing(viewport, next, edge), behavior: 'smooth' });
  }, []);

  const choose = React.useCallback((type: SpaceType): void => {
    onChange(type);
    reveal(type);
  }, [onChange, reveal]);

  return (
    <div className='flex flex-col gap-2'>
      <Label>{t('spaces.create.typeLabel')}</Label>
      <div className='relative'>
        <ScrollArea scrollbars='horizontal' viewportRef={setViewport}>
          <div
            className='flex gap-2 py-1'
            role='radiogroup'
            aria-label={t('spaces.create.typeAria')}
            data-testid={`${idPrefix}-segmented`}
          >
            {TYPE_CARDS.map((card) => {
              const Icon = SPACE_TYPE_ICON[card.type];
              const selected = value === card.type;
              const option = (
                <Button
                  key={card.type}
                  ref={(node: HTMLButtonElement | null) => {
                    if (node === null) cardRefs.current.delete(card.type);
                    else cardRefs.current.set(card.type, node);
                  }}
                  variant={null}
                  // The stacked icon and name determine the card's height.
                  size={null}
                  type='button'
                  role='radio'
                  aria-checked={selected}
                  onClick={() => choose(card.type)}
                  data-testid={`${idPrefix}-${card.type}`}
                  className={cn(
                    'flex w-28 flex-col items-center gap-2 rounded-chrome border px-3 py-3 text-center transition-colors',
                    selected
                      ? 'border-active-border bg-accent-strong text-foreground'
                      : 'border-border bg-transparent text-foreground',
                    // The picked card keeps its own fill under the pointer: plain
                    // hover outranks it and would drop it to the fill of the
                    // hoverable sibling cards.
                    selected ? 'hover-enabled:bg-accent-strong' : 'hover-enabled:bg-accent',
                  )}
                >
                  <Icon
                    className={cn(
                      'h-7 w-7',
                      selected ? 'text-foreground' : 'text-muted-foreground',
                    )}
                  />
                  <span className='whitespace-nowrap text-sm font-medium'>{t(card.titleKey)}</span>
                </Button>
              );
              return (
                <Tooltip key={card.type}>
                  <div className='relative shrink-0'>
                    <TooltipTrigger asChild>{option}</TooltipTrigger>
                    {IN_DEVELOPMENT.has(card.type) ? (
                      <Badge variant='secondary' className='pointer-events-none absolute right-1 top-1 px-1 py-0 text-2xs font-medium'>
                        {t('spaces.kind.developmentBadge')}
                      </Badge>
                    ) : null}
                  </div>
                  <TooltipContent>{t(card.descriptionKey)}</TooltipContent>
                </Tooltip>
              );
            })}
          </div>
        </ScrollArea>
        {edges.start ? (
          <>
            <div aria-hidden='true' className='pointer-events-none absolute inset-y-0 left-0 w-14 bg-gradient-to-r from-card via-card/80 to-transparent' />
            <Button
              type='button'
              variant='outline'
              size='icon'
              aria-label={t('spaces.create.scrollTypesStart')}
              data-testid={`${idPrefix}-scroll-start`}
              onClick={() => step('start')}
              className='absolute left-1 top-1/2 size-7 -translate-y-1/2 rounded-full bg-card'
            >
              <ChevronLeft className='h-4 w-4' aria-hidden='true' />
            </Button>
          </>
        ) : null}
        {edges.end ? (
          <>
            <div aria-hidden='true' className='pointer-events-none absolute inset-y-0 right-0 w-14 bg-gradient-to-l from-card via-card/80 to-transparent' />
            <Button
              type='button'
              variant='outline'
              size='icon'
              aria-label={t('spaces.create.scrollTypesEnd')}
              data-testid={`${idPrefix}-scroll-end`}
              onClick={() => step('end')}
              className='absolute right-1 top-1/2 size-7 -translate-y-1/2 rounded-full bg-card'
            >
              <ChevronRight className='h-4 w-4' aria-hidden='true' />
            </Button>
          </>
        ) : null}
      </div>
    </div>
  );
}
