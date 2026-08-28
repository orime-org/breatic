// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The class that names the body's scroll container.
 *
 * One definition because three different kinds of code depend on it: the
 * stylesheet paints the scrollbar through it and hangs the entry's layout
 * variables on it (`--doc-entry-*`, `--doc-body-gutter`), and
 * `SelectionBubbleBar` walks up from the scroller to find the viewport it
 * portals itself into. Left as a literal in those places, renaming it while
 * restyling the scrollbar would put the bar at the end of the body and leave
 * the entry with no sizes at all.
 */
export const BODY_SCROLLER_CLASS = 'doc-body-scroller';
