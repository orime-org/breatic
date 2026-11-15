// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';

/**
 * `onFocusCapture` handler for a button that opens a Radix hover overlay AND
 * gets focus handed back to it by something other than the user.
 *
 * Both Radix hover overlays open on focus: `Tooltip` instantly (bypassing
 * `delayDuration`) and `HoverCard` through its trigger's own `onFocus`. That is
 * the intended behaviour for a keyboard user Tabbing in, but it ALSO fires when
 * the app restores focus to the button — Radix returning it as an overlay
 * closes (DropdownMenu / Dialog / Sheet / Popover, the reported bug), or the
 * canvas returning it to a pick trigger when a pick ends (generate-panel slots,
 * #1946). Either way something pops with the pointer nowhere near it. Stopping
 * the focus event in the capture phase keeps the overlay's own focus handler
 * from running, so it never opens from focus; it still opens on hover (pointer
 * events are untouched).
 *
 * Crucially this does NOT touch the overlay's `onCloseAutoFocus`, so focus still
 * returns to the trigger on close — satisfying the WAI-ARIA focus-restoration
 * requirement for modal dialogs and menu buttons (which `onCloseAutoFocus`
 * preventDefault would have violated). The trigger's `aria-label` conveys the
 * accessible name to screen readers in place of the focus-shown tooltip.
 * @param event - The trigger button's capture-phase focus event.
 */
export function suppressTooltipFocusOpen(event: React.FocusEvent): void {
  event.stopPropagation();
}

/**
 * Hands focus back to whatever opened an overlay that has no Radix `Trigger`, when focus went down with the overlay to
 * the body; focus that another element already holds (an overlay that took the shared slot, a box opened from it) stays
 * there, as `useKeepMovedFocus` keeps it for the overlay contents.
 *
 * Radix restores focus by focusing its own trigger and nothing else: on close
 * it calls `event.preventDefault()` on the FocusScope's restoration and then
 * `context.triggerRef.current?.focus()` (`@radix-ui/react-dialog@1.1.23`,
 * `dist/index.mjs:154`). An overlay opened from state rather than from
 * `DialogTrigger` / `SheetTrigger` has no such ref, so that call reaches
 * nothing and focus lands on the body -- a keyboard user who pressed Escape
 * has to Tab back through the whole page to where they were.
 *
 * Several things open the same overlay in places -- every square in a row of
 * results, and the button after them -- which is why the element is read at
 * the moment it opens rather than declared by one trigger.
 * @param open - Whether the overlay is showing.
 * @returns The handler to pass as the content's `onCloseAutoFocus`.
 */
export function useReturnFocus(open: boolean): (event: Event) => void {
  const opener = React.useRef<HTMLElement | null>(null);

  if (open && opener.current === null) {
    const active = document.activeElement;
    opener.current = active instanceof HTMLElement ? active : null;
  }

  return React.useCallback((event: Event): void => {
    // Radix's own handler runs after this one and only while the event is not
    // already prevented, so preventing it here is what keeps it from focusing
    // the trigger it does not have.
    event.preventDefault();
    const target = opener.current;
    opener.current = null;
    if (focusMovedOn()) return;
    // Gone from the document if the row it sat in re-rendered while the
    // overlay was up; the body is then where focus was headed anyway.
    if (target !== null && document.contains(target)) target.focus();
  }, []);
}

/**
 * Whether focus has moved on to another element, rather than going down with a closing overlay to the body.
 * @returns True when something other than the body holds focus.
 */
function focusMovedOn(): boolean {
  const active = document.activeElement;
  return active !== null && active !== document.body;
}

/**
 * The `onCloseAutoFocus` that the focus-taking overlay contents in `components/ui` (Dialog, AlertDialog, Sheet, Popover,
 * DropdownMenu) pass to Radix: the caller's own handler first, then focus goes back to the trigger only when it went down
 * with the overlay. An overlay that another one closed
 * (a panel taking the shared overlay slot, a Space opened from a menu that hands focus to its own panel) otherwise
 * pulls focus back to its trigger once its exit ends and closes the overlay that now holds it. react-aria's
 * `FocusScope` restores focus on the same condition.
 * @param handler - The caller's `onCloseAutoFocus`, if any.
 * @returns The handler to pass to the Radix content.
 */
export function useKeepMovedFocus(handler?: (event: Event) => void): (event: Event) => void {
  return React.useCallback((event: Event): void => {
    handler?.(event);
    if (focusMovedOn()) event.preventDefault();
  }, [handler]);
}
