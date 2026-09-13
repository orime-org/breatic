// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The surface both link panels are drawn on.
 *
 * `DocumentLinkPopover` and `DocumentLinkToolbar` show the same two faces —
 * the address and the field — and a reader meets them in the same document a
 * few seconds apart, so they have to look like one control. They are separate
 * elements: the popover's surface IS the floating element, carrying its
 * position and its dialog role, while the toolbar's is a plain child of one.
 * What they share is how the surface looks, and that is this.
 *
 * Stacking is each panel's own: the popover is positioned, so a `z-` class on
 * it settles where it sits; the toolbar's is an ordinary child with no
 * position of its own, and the controller already stacks the floating element
 * around it.
 */

/** How a link panel's surface is drawn. */
export const LINK_PANEL_SURFACE =
  'w-auto rounded-overlay border border-border bg-popover p-1.5 text-popover-foreground shadow outline-none';
