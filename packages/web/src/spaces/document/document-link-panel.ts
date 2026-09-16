// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The surface both link panels are drawn on.
 *
 * `DocumentLinkPopover` and `DocumentLinkToolbar` show the same two faces —
 * the address and the field — and a reader meets them in the same document a
 * few seconds apart, so they have to look like one control. Each one's
 * surface IS its floating element, carrying its own position; the popover's
 * carries a dialog role as well. What they share is how the surface looks,
 * and that is this.
 *
 * Stacking is each panel's own, and both are positioned, so a `z-` class on
 * either settles where it sits.
 */

/** How a link panel's surface is drawn. */
export const LINK_PANEL_SURFACE =
  'w-auto rounded-overlay border border-border bg-popover p-1.5 text-popover-foreground shadow-md outline-none';
