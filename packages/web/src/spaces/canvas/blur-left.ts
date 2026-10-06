// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { canvasRootOf } from '@web/spaces/canvas/canvas-context';

/**
 * Runs `leave` if a blur on a box that ends on blur was the reader leaving it.
 *
 * Two blurs are not. Leaving the browser: the whole document loses focus, and
 * coming back should find the box as it was — `relatedTarget` cannot tell that
 * apart from a press on something unfocusable, so the question is whether the
 * document has focus at all. And the box's Space being hidden by a switch of
 * Space (inner#1235 A13, A14): Chrome fires that blur while the Space is still
 * on screen, so it is asked once the commit doing the hiding has run. The
 * question goes to the Space, found by its id: a box in a popover is not
 * inside its Space's outlet, and a box can leave the page while its Space
 * stays (its node deleted or scrolled out of view), which is leaving it.
 * @param spaceId - The Space the box belongs to.
 * @param leave - What the box does when the reader leaves it.
 */
export function whenBlurLeaves(spaceId: string, leave: () => void): void {
  if (!document.hasFocus()) return;
  const space = canvasRootOf(spaceId);
  queueMicrotask(() => {
    if (space instanceof Element && getComputedStyle(space).display === 'none') return;
    leave();
  });
}
