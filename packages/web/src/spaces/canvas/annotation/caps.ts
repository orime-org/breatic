// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * How tall each part of a sticky may grow before it scrolls.
 *
 * A sticky is a fixed landmark on the board, and nothing about what somebody
 * writes on it is bounded: measured, 10800 characters made a 200px note 6487px
 * tall, reaching past the viewport in both directions with no way to see the
 * note as a whole. So each part carries its own cap and its own scroller.
 *
 * Both go on a `ScrollArea`'s VIEWPORT, which is the element that scrolls. Put
 * on the Root it clips instead: measured with ten replies, a 179px root over a
 * 468px viewport whose `scrollTop` would not move off 0, and 267px of thread
 * that could not be reached at all.
 */

/**
 * A settled region: the body, or the thread of replies.
 *
 * Measured on a real board rather than reasoned about — it holds roughly four
 * short replies.
 */
export const NOTE_REGION_MAX_HEIGHT = 'max-h-[180px]';

/**
 * A box somebody is writing in: the new-note box, an edit box, the reply box.
 *
 * Shorter than a settled region, because a box shares the note with the two
 * regions and a note is only 200px wide: at `text-xs` this is about seven
 * lines, and past that the words scroll rather than push the thread it is
 * answering off the screen.
 */
export const NOTE_BOX_MAX_HEIGHT = 'max-h-[120px]';
