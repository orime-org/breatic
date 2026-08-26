// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The shell around one dropdown on the bubble bar: opens on hover, and on click.
 *
 * The bar's four slots (block type, alignment, colour, AI) share it; what goes
 * inside is the caller's business. The shape comes from the menu-system ruling
 * §3.2.1 ("hover one of those icons and a list opens below it"), which defined
 * it for the AI slot; user 2026-08-26 spread it to all four and set five rules:
 * hover opens · the pointer can travel from the slot onto the menu and press a
 * row · only leaving the whole area closes it, and the slot stays · the body
 * does not scroll while the pointer rests on the menu · once the body really
 * scrolls, the menu goes.
 *
 * The keyboard takes no part (user 2026-08-26). Neither does focus — see below.
 */

import * as React from 'react';

import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
} from '@web/components/ui/dropdown-menu';

/**
 * How long the menu stands after the pointer leaves.
 *
 * WCAG 2.1 SC 1.4.13's Hoverable clause asks that the menu survive the trip
 * from the slot onto it, and `sideOffset` puts a gap between the two: crossing
 * it, the pointer is inside neither. This gives the trip time to finish, and
 * entering the menu cancels it. Radix's own submenus work at the same order of
 * magnitude (`MenuSubTrigger` opens after 100ms).
 */
const CLOSE_GRACE_MS = 120;

interface DocumentBubbleMenuProps {
  /** Stable id, used to build the test ids. */
  id: string;
  /** What the slot itself looks like. */
  trigger: React.ReactNode;
  /** What the menu holds. */
  children: React.ReactNode;
  /**
   * Which element the menu mounts inside.
   *
   * The bar itself. Portalled to `body`, the menu would take focus somewhere
   * the bar does not recognise as its own, and the bar — which decides whether
   * to stay on screen by asking where focus is — would take itself away and
   * the menu with it (ruling §5.1, second point).
   */
  container: HTMLElement | null;
  /** The body's scroller, watched so that a real scroll closes the menu. */
  scroller: HTMLElement | null;
  /** Is this slot open? The bar holds the state so only one opens at a time. */
  open: boolean;
  /** Open or close. */
  onOpenChange: (open: boolean) => void;
}

/**
 * One dropdown that opens on hover.
 * @param props - See {@link DocumentBubbleMenuProps}.
 * @param props.id - Stable id, used to build the test ids.
 * @param props.trigger - What the slot itself looks like.
 * @param props.children - What the menu holds.
 * @param props.container - Which element the menu mounts inside.
 * @param props.scroller - The body's scroller.
 * @param props.open - Is this slot open?
 * @param props.onOpenChange - Open or close.
 * @returns The slot and its menu.
 */
export function DocumentBubbleMenu({
  id,
  trigger,
  children,
  container,
  scroller,
  open,
  onOpenChange,
}: DocumentBubbleMenuProps): React.JSX.Element {
  const closeTimer = React.useRef<number | null>(null);
  const [content, setContent] = React.useState<HTMLDivElement | null>(null);

  /** Cancels a close that is counting down. */
  const cancelClose = React.useCallback((): void => {
    if (closeTimer.current === null) return;
    window.clearTimeout(closeTimer.current);
    closeTimer.current = null;
  }, []);

  /** The pointer entered the slot or the menu: keep it open, or open it. */
  const enter = React.useCallback((): void => {
    cancelClose();
    onOpenChange(true);
  }, [cancelClose, onOpenChange]);

  /** The pointer left: leave time for the trip across the gap. */
  const leave = React.useCallback((): void => {
    cancelClose();
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null;
      onOpenChange(false);
    }, CLOSE_GRACE_MS);
  }, [cancelClose, onOpenChange]);

  React.useEffect(() => cancelClose, [cancelClose]);

  // Once the body really scrolls, the menu goes (user 2026-08-26's fifth rule).
  // With the pointer on the menu the wheel is swallowed below and the body does
  // not move, so the two rules never contradict: they act on different pointer
  // positions.
  React.useEffect(() => {
    if (!open || !scroller) return undefined;
    /** The body scrolled; take the menu away. */
    const close = (): void => {
      cancelClose();
      onOpenChange(false);
    };
    scroller.addEventListener('scroll', close);
    return () => {
      scroller.removeEventListener('scroll', close);
    };
  }, [open, scroller, cancelClose, onOpenChange]);

  // While the pointer rests on the menu, the wheel does not scroll the body.
  //
  // A native listener rather than React's `onWheel`: React attaches wheel as a
  // passive listener, and `preventDefault()` inside a passive listener does
  // nothing (DOM standard).
  React.useEffect(() => {
    if (!content) return undefined;
    /**
     * Swallows the wheel.
     * @param event - The wheel event.
     */
    const swallow = (event: WheelEvent): void => {
      event.preventDefault();
    };
    content.addEventListener('wheel', swallow, { passive: false });
    return () => {
      content.removeEventListener('wheel', swallow);
    };
  }, [content]);

  return (
    <div
      data-testid={`${id}-zone`}
      className='flex items-center'
      onPointerLeave={leave}
    >
      <DropdownMenu open={open} onOpenChange={onOpenChange} modal={false}>
        <DropdownMenuTrigger asChild onPointerEnter={enter}>
          {trigger}
        </DropdownMenuTrigger>
        <DropdownMenuContent
          ref={setContent}
          container={container}
          data-testid={`${id}-menu`}
          align='start'
          onPointerEnter={enter}
          // Closing does not hand focus back to the trigger. Radix does by
          // default (`@radix-ui/react-dropdown-menu:114-115`), and the trigger
          // sits on the bar, where nothing takes focus (ruling R4 / §5.2).
          // `composeEventHandlers` carries `checkForDefaultPrevented`, so the
          // `preventDefault` here keeps Radix's own `focus()` from running.
          onCloseAutoFocus={(event) => {
            event.preventDefault();
          }}
        >
          {children}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
