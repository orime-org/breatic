// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import * as React from 'react';
import { X } from 'lucide-react';

import { Button } from '@web/components/ui/button';
import { Popover, PopoverAnchor, PopoverContent } from '@web/components/ui/popover';
import { ScrollArea } from '@web/components/ui/scroll-area';
import { useTranslation } from '@web/i18n/use-translation';
import { cn } from '@web/lib/utils';
import type { FramePoint } from '@web/spaces/web-animation/annotation-draft';

/** A card over the frame. */
interface MotionFrameCardProps {
  testId: string;
  /** The point on the frame it belongs to, as 0..1 of the frame; null for the bottom of the frame. */
  point: FramePoint | null;
  /** The preview area the card stays inside. */
  boundary: HTMLElement | null;
  /** The Space, which the card is drawn in so it stays under the Space's shared notices. */
  container: HTMLElement | null;
  /** Esc (unless a text box with words in it takes the press first) or its close button. */
  onClose: () => void;
  className?: string;
  children: React.ReactNode;
}

/**
 * Keep the card open when the user works outside it (design §7.3: they look and click while it is open).
 * @param event - The outside press or focus.
 */
function keepOpen(event: Event): void {
  event.preventDefault();
}

/**
 * Leave Esc to a text box with words in it, which throws its words away (or asks to); the next Esc closes the card.
 * @param event - The key.
 */
function leaveWordsToTheBox(event: KeyboardEvent): void {
  if (event.target instanceof HTMLTextAreaElement && event.target.value !== '') event.preventDefault();
}

/**
 * Focus the card itself on opening, so a ring shows only once the keyboard moves inside it.
 * @param event - The open focus.
 */
function focusCard(event: Event): void {
  event.preventDefault();
  (event.currentTarget as HTMLElement).focus();
}

/**
 * Keep clicks in the card from reaching the frame, which a portal still bubbles to in React.
 * @param event - The click.
 */
function stopAtCard(event: React.MouseEvent): void {
  event.stopPropagation();
}

// The pin is 20px wide and its tip, the bottom-left corner, is on the point, so 28px leaves the same 8px gap a
// popover keeps from its trigger.
const POINT_OFFSET = 28;

/**
 * A card anchored to a point on the Motion frame, or to the frame's bottom centre (#1490 design §7.1, §7.3): the thread
 * card and the annotation write box. It opens beside the point, or centred just inside the frame's bottom when there is
 * none (the approved demo's `cardAt(null)`), and stays inside the preview area, flipping or sliding
 * near an edge, and no taller than the room there, scrolling what does not fit; pressing outside does not close it, Esc
 * does, and so does its close button, which stays in the corner while the content scrolls. One Esc closes only this card,
 * not the panel behind it. The card has no padding and the content scrolls edge to edge, so its 8px rail runs along the
 * card's right edge.
 * @param props - The card.
 * @param props.testId - Its test hook.
 * @param props.point - Its point.
 * @param props.boundary - The preview area.
 * @param props.container - The Space element.
 * @param props.onClose - Closes it.
 * @param props.className - Its surface.
 * @param props.children - Its content, padded by the caller inside the scroller.
 * @returns The card.
 * @throws {never} Never.
 */
export function MotionFrameCard({ testId, point, boundary, container, onClose, className, children }: MotionFrameCardProps): React.JSX.Element {
  const t = useTranslation();
  const changeOpen = React.useCallback((open: boolean): void => { if (!open) onClose(); }, [onClose]);
  const anchorStyle = React.useMemo((): React.CSSProperties => (point === null
    ? { left: '50%', top: '100%' }
    : { left: `${point.x * 100}%`, top: `${point.y * 100}%` }), [point]);
  return <Popover open onOpenChange={changeOpen}>
    <PopoverAnchor asChild><span className='pointer-events-none absolute size-0' style={anchorStyle} /></PopoverAnchor>
    <PopoverContent data-testid={testId} container={container} side={point === null ? 'top' : 'right'} align={point === null ? 'center' : 'start'} sideOffset={point === null ? 8 : POINT_OFFSET}
      collisionBoundary={boundary} collisionPadding={8} onInteractOutside={keepOpen} onEscapeKeyDown={leaveWordsToTheBox} onOpenAutoFocus={focusCard}
      onClick={stopAtCard} updatePositionStrategy='always'
      className={cn('relative grid max-h-[var(--radix-popover-content-available-height)] grid-rows-[minmax(0,1fr)] overflow-hidden bg-card p-0', className)}>
      <ScrollArea scrollbars='vertical' className='min-h-0'>{children}</ScrollArea>
      {/* 10px in from the right edge, clear of the 8px rail. */}
      <Button type='button' variant='ghost' size='compact' className='absolute right-2.5 top-1 z-10 bg-card px-1' aria-label={t('spaces.webAnimation.closePanel')}
        onClick={onClose} icon={<X className='size-4' />} />
    </PopoverContent>
  </Popover>;
}
