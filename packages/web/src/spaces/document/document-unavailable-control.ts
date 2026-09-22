// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * How a control that cannot be used right now is drawn.
 *
 * Two carriers need it. A bubble bar slot whose command reaches nothing under
 * this selection, and a block handle row whose command reaches nothing on this
 * row — the colour panel over a row with no words in it, for one. What they
 * must not do is look usable: a control that reads as available and answers a
 * press with nothing tells the reader it is broken (user 2026-08-23).
 *
 * The treatment is dimmed, a cursor that says so, and the hover highlight
 * switched off. `aria-disabled` goes on the element itself at each call site,
 * rather than here, because it travels with whatever else that carrier needs.
 *
 * Why there are two of them is the whole content of this file: whether the
 * focus treatment belongs depends on how the entry can be focused.
 */

/**
 * What a control that cannot be used looks like to the pointer.
 *
 * The two `hover:` classes cancel what `variant='ghost'` would otherwise
 * give: `cn()` runs twMerge, and a class named here beats the variant's own
 * in the same group. Without them the entry lights up under the pointer the
 * way a working button does, and says it can be pressed.
 *
 * THE FOCUS TREATMENT IS NOT IN HERE, because whether it belongs depends on
 * how the entry can be focused — see {@link UNAVAILABLE}. An entry the
 * keyboard can reach and the pointer cannot needs this one: its `:focus` only
 * ever comes from an arrow key, and that is the one mark saying where the
 * reader is.
 */
export const UNAVAILABLE_KEYBOARD_FOCUS_ONLY =
  'hover:bg-transparent hover:text-current cursor-not-allowed opacity-50';

/**
 * The same, for an entry the POINTER can put focus on.
 *
 * Inside a menu Radix highlights the row under the pointer by moving the focus
 * to it and styling `focus:bg-accent`, so an entry that turned only `hover:`
 * off still lit up like a working one. An entry that declines `pointermove` is
 * not one of these — Radix then never focuses it from the pointer (measured
 * 2026-09-18 on the block menu's comment row: `data-highlighted` null,
 * `activeElement` elsewhere, background `rgba(0, 0, 0, 0)` with the pointer
 * over it), and cancelling `:focus` there takes the keyboard's only indicator
 * away with nothing gained.
 */
export const UNAVAILABLE =
  `${UNAVAILABLE_KEYBOARD_FOCUS_ONLY} focus:bg-transparent focus:text-current`;
