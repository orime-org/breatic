// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * How long the link toolbar waits, in both directions.
 *
 * Its own pair rather than the canvas hover preview's: one is a picture
 * glanced at while passing over a node, the other is a control the reader
 * reaches out to press, drawn on top of the prose they are reading. A preview
 * that comes late wastes the glance; a toolbar that comes early covers the
 * line under a hand that was only crossing the page.
 */

/**
 * How long a hand rests on a link before the toolbar comes up.
 *
 * 300ms, and the number comes from what a link is rather than from any
 * published figure: a link can be pressed, so a hand arriving at one wants
 * either to open it or to change it. A toolbar that comes up at once stands in
 * the way of the first of those. The wait is what separates them — reach over
 * and press, and it never appears; rest there, and it comes.
 *
 * The published figures agree with the value without being about this control:
 * the Nielsen Norman Group gives 0.3–0.5s for exposing hidden content on
 * hover, and TipTap's own floating menus default to 250ms.
 */
export const LINK_TOOLBAR_OPEN_DELAY_MS = 300;

/**
 * How long the toolbar waits after the pointer leaves it and its link.
 *
 * Leaving one of the two is not leaving both, and the gap between them has to
 * be crossable, which is what WCAG 2.2 SC 1.4.13 Hoverable asks for.
 */
export const LINK_TOOLBAR_CLOSE_DELAY_MS = 200;
