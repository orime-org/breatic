// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { act } from '@testing-library/react';

/**
 * Mutates the canvas viewport transform and flushes the follow hook's
 * MutationObserver (microtask) + its rAF-coalesced resize dispatch, so a test
 * can assert that an open canvas popover repositioned (useFollowCanvasViewport).
 * Shared by the ModelPicker / ImageModeToggle follow tests (#1796) — the mode /
 * ratio / camera / model pickers all wire the same hook.
 * @param viewport - The `.react-flow__viewport` element under test.
 * @param transform - The new inline `transform` value to apply.
 * @returns A promise resolving after the coalesced dispatch has run.
 */
export async function panCanvasViewport(
  viewport: HTMLElement,
  transform: string,
): Promise<void> {
  await act(async () => {
    viewport.style.transform = transform;
    // MutationObserver callbacks are microtask-scheduled; the hook then coalesces
    // its resize dispatch to the next animation frame.
    await Promise.resolve();
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
  });
}
