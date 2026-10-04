// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Runs `leave` if a blur on a box that ends on blur was the reader leaving it.
 *
 * Two blurs are not. Leaving the browser: the whole document loses focus, and
 * coming back should find the box as it was — `relatedTarget` cannot tell that
 * apart from a press on something unfocusable, so the question is whether the
 * document has focus at all. And the box's Space being hidden by a switch of
 * Space, or the box taken off the page with it (inner#1235 A13, A14): Chrome
 * fires that blur while the box is still attached and visible, so it is asked
 * once the commit doing the hiding has run.
 * @param box - The element that lost focus.
 * @param leave - What the box does when the reader leaves it.
 */
export function whenBlurLeaves(box: Element, leave: () => void): void {
  if (!document.hasFocus()) return;
  queueMicrotask(() => {
    if (!box.isConnected || box.checkVisibility?.() === false) return;
    leave();
  });
}
