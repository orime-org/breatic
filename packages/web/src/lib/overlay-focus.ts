// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type * as React from 'react';

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
