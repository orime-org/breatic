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
  Popover,
  PopoverTrigger,
  PopoverContent,
} from '@web/components/ui/popover';
import { cn } from '@web/lib/utils';

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

/**
 * How far below the bar the menu sits.
 *
 * A panel that hangs off a surface keeps a visible gap from that surface's
 * edge. User 2026-08-27 put the width of it at 4px here.
 *
 * `sideOffset` measures from the TRIGGER, and this trigger is a slot that sits
 * inside the bar's own 4px padding and 1px border. Those 5px come out of the
 * gap, so plain 4 leaves none at all; 9 puts the visible gap at 4.
 */
const MENU_SIDE_OFFSET = 4 + 5;

/**
 * The panel a menu is drawn on.
 *
 * `PopoverContent` is built for a wide panel of rich content; these hold a
 * short list of rows, so they take the shared menu's width and padding.
 */
const MENU_PANEL =
  'z-[var(--z-popover)] w-auto min-w-[10rem] overflow-hidden p-1 shadow-md';

/**
 * Closes the menu a row belongs to.
 *
 * Picking a row takes the menu away with it. The rows are written by the
 * callers, so what closes the menu reaches them through here rather than
 * through every one of the twenty rows.
 */
const CloseBubbleMenu = React.createContext<() => void>(() => {});

/**
 * What closes the menu the caller's rows are inside.
 * @returns That function; a no-op outside a menu.
 */
export function useCloseBubbleMenu(): () => void {
  return React.useContext(CloseBubbleMenu);
}

interface DocumentBubbleMenuProps {
  /** Stable id, used to build the test ids. */
  id: string;
  /** What the slot itself looks like. */
  trigger: React.ReactNode;
  /** What the menu holds. */
  children: React.ReactNode;
  /**
   * Extra classes for the menu panel.
   *
   * A menu of rows wants a gap between them; the colour panel is not rows —
   * its spacing comes from the demo — so it passes nothing.
   */
  contentClassName?: string;
  /**
   * Which element the menu mounts inside.
   *
   * The bar itself. The bar keeps the focus in the body by swallowing
   * `mousedown` on itself (`SelectionBubbleBar.tsx`), and an event only
   * reaches that listener if it started inside the bar — a menu portalled to
   * `body` would take the focus out of the document on the first press of a
   * row, and the selection highlight with it.
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
 * @param props.contentClassName - Extra classes for the menu panel.
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
  contentClassName,
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

  /** Takes the menu away now. */
  const close = React.useCallback((): void => {
    cancelClose();
    onOpenChange(false);
  }, [cancelClose, onOpenChange]);

  React.useEffect(() => cancelClose, [cancelClose]);

  // Once the body really scrolls, the menu goes (user 2026-08-26's fifth rule).
  // With the pointer on the menu the wheel is swallowed below and the body does
  // not move, so the two rules never contradict: they act on different pointer
  // positions.
  React.useEffect(() => {
    if (!open || !scroller) return undefined;
    scroller.addEventListener('scroll', close);
    return () => {
      scroller.removeEventListener('scroll', close);
    };
  }, [open, scroller, close]);

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
      <Popover open={open} onOpenChange={onOpenChange} modal={false}>
        {/* A pointer cannot rest on the slot with the menu shut — entering it
            opened the menu — so every click a reader makes lands on an open
            one. Radix would read that click as a toggle and take the menu
            away; the slot answers it by opening, which is what it already is
            (ruling R4 / B2). */}
        <PopoverTrigger
          asChild
          onPointerEnter={enter}
          onClick={(event) => {
            // Radix runs its own handler after this one unless the default is
            // prevented (`composeEventHandlers`).
            event.preventDefault();
            enter();
          }}
        >
          {trigger}
        </PopoverTrigger>
        <PopoverContent
          ref={setContent}
          container={container}
          data-testid={`${id}-menu`}
          className={cn(MENU_PANEL, contentClassName)}
          align='start'
          sideOffset={MENU_SIDE_OFFSET}
          onPointerEnter={enter}
          // The focus stays in the body, on both ways.
          //
          // These menus take no keyboard input (user 2026-08-26), so the focus
          // has no business moving into one: a reader typing while a menu is
          // open goes on reaching the body. Radix moves it in on open and back
          // out on close, and both halves are refused here — the way out is
          // what closed a menu that had just opened beside it, since it runs
          // one turn late (`react-focus-scope` puts the unmount half in a
          // `setTimeout`) and by then the focus it takes belongs to the next
          // menu along the bar.
          onOpenAutoFocus={(event) => {
            event.preventDefault();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
          }}
        >
          <CloseBubbleMenu.Provider value={close}>
            {children}
          </CloseBubbleMenu.Provider>
        </PopoverContent>
      </Popover>
    </div>
  );
}
