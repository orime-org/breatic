// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type * as React from 'react';

/**
 * `onFocusCapture` handler for a button that is BOTH a `TooltipTrigger` and an
 * overlay trigger (DropdownMenu / Dialog / Sheet / Popover).
 *
 * Radix Tooltip opens instantly on focus (bypassing `delayDuration`). That is
 * the intended behaviour for a keyboard user Tabbing in, but it ALSO fires when
 * an overlay closes and Radix returns focus to the trigger — popping a stray
 * tooltip the moment the menu / dialog closes (the reported bug). Stopping the
 * focus event in the capture phase keeps Radix Tooltip's own focus handler from
 * running, so the tooltip never opens from focus; it still opens on hover
 * (pointer events are untouched).
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
