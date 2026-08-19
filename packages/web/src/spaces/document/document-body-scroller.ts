// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The class that names the body's scroll container.
 *
 * One definition because two different kinds of code depend on it: the
 * stylesheet paints the scrollbar through it, and `SelectionBubbleBar` walks up
 * from the scroller to it to find the box the bar must hang outside of. Left as
 * a literal in both places, renaming it while restyling the scrollbar would
 * silently move the bar to the end of the body. Where it appears would not
 * change — the plugin positions it absolutely and floating-ui measures against
 * whatever offset parent it lands in — but it would leave the editor's own
 * subtree, and with it every stacking and clipping relationship that placement
 * was chosen for.
 */
export const BODY_SCROLLER_CLASS = 'doc-body-scroller';
