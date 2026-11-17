// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';

import { Popover, PopoverAnchor, PopoverContent } from '@web/components/ui/popover';
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
  /** Esc, unless a text box with words in it takes the press first. */
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

// The pin is 20px wide and centred on its point, so 18px leaves the same 8px gap a popover keeps from its trigger.
const POINT_OFFSET = 18;

/**
 * A card anchored to a point on the Motion frame, or to the frame's bottom centre (#1490 design §7.1, §7.3): the thread
 * card and the annotation write box. It opens beside the point and stays inside the preview area, flipping or sliding
 * near an edge; pressing outside does not close it, Esc does. One Esc closes only this card, not the panel behind it.
 * @param props - The card.
 * @param props.testId - Its test hook.
 * @param props.point - Its point.
 * @param props.boundary - The preview area.
 * @param props.container - The Space element.
 * @param props.onClose - Closes it.
 * @param props.className - Its surface.
 * @param props.children - Its content.
 * @returns The card.
 * @throws {never} Never.
 */
export function MotionFrameCard({ testId, point, boundary, container, onClose, className, children }: MotionFrameCardProps): React.JSX.Element {
  const changeOpen = React.useCallback((open: boolean): void => { if (!open) onClose(); }, [onClose]);
  const anchorStyle = React.useMemo((): React.CSSProperties => (point === null
    ? { left: '50%', top: '100%' }
    : { left: `${point.x * 100}%`, top: `${point.y * 100}%` }), [point]);
  return <Popover open onOpenChange={changeOpen}>
    <PopoverAnchor asChild><span className='pointer-events-none absolute size-0' style={anchorStyle} /></PopoverAnchor>
    <PopoverContent data-testid={testId} container={container} side='right' align='start' sideOffset={point === null ? 8 : POINT_OFFSET}
      collisionBoundary={boundary} collisionPadding={8} onInteractOutside={keepOpen} onEscapeKeyDown={leaveWordsToTheBox} onOpenAutoFocus={focusCard}
      onClick={stopAtCard} updatePositionStrategy='always' className={className}>
      {children}
    </PopoverContent>
  </Popover>;
}
