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
 * A box somebody is writing in: the new-note box, and the reply box.
 *
 * A rewrite box takes this cap only where its entry has no scroller of its
 * own. Under the annotation's body it takes the region cap instead, standing
 * where the words it is rewriting stood; a reply has no scroller to stand in,
 * and unbounded inside the thread's own cap a long rewrite pushed its buttons
 * below the fold.
 *
 * Shorter than a settled region, because a box shares the note with the two
 * regions and a note is only 200px wide: at `text-xs` this is about seven
 * lines, and past that the words scroll rather than push the thread it is
 * answering off the screen.
 */
export const NOTE_BOX_MAX_HEIGHT = 'max-h-[120px]';

/**
 * The shape every box on a sticky takes: no minimum, no resize grip, no
 * scrollbar of its own, and the note's own text size.
 *
 * `md:text-xs` is here because the primitive carries `md:text-sm` for the
 * viewports it was written for, and tailwind-merge keeps a class that has a
 * modifier beside one that has none. Written as `text-xs` alone, all three
 * boxes measured 13px on a real board while the words they were rewriting
 * measured 12px, so the text changed size the moment the box opened.
 */
/**
 * How much one person may write on one note, in characters (user 2026-09-16).
 *
 * A note is a landmark on the board, so what goes into it is bounded the same
 * way what it draws is. The three boxes carry it as `maxLength`, which is the
 * platform refusing the 301st character as it is typed or pasted — measured on
 * a real browser, since jsdom writes a value straight past the attribute.
 *
 * Every box on a note takes the same number: a reply and a rewrite sit on the
 * same 200px surface as the body and grow it the same way.
 */
export const NOTE_MAX_CHARS = 300;

export const NOTE_BOX_CLASS =
  'min-h-0 resize-none overflow-hidden text-xs md:text-xs ' +
  'placeholder:text-note-foreground-muted';
