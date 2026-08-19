// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The class that names the body's scroll container.
 *
 * One definition because two different kinds of code depend on it: the
 * stylesheet paints the scrollbar through it, and `SelectionBubbleBar` looks
 * the element up by it to learn which box the bar is judged against. Left as a
 * literal in both places, renaming it while restyling the scrollbar would take
 * the bar off screen for good and say nothing — the lookup would simply answer
 * null and the bar would never render.
 */
export const BODY_SCROLLER_CLASS = 'doc-body-scroller';
