// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The class that names the body's scroll container.
 *
 * One definition because two different kinds of code depend on it: the
 * stylesheet paints the scrollbar through it, and `SelectionBubbleBar` walks
 * up from the scroller to find the viewport it portals itself into. Left as a
 * literal in those places, renaming it while restyling the scrollbar would put
 * the bar at the end of the body.
 */
export const BODY_SCROLLER_CLASS = 'doc-body-scroller';

/**
 * The class on the row that holds the scroller and the heading outline beside
 * it. The stylesheet hangs the whole-document entry's layout variables on it
 * (`--doc-entry-*`, `--doc-body-gutter`), which the outline's icon and its
 * shut column read as well.
 */
export const BODY_ROW_CLASS = 'doc-body-row';
