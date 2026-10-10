// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The attribute on the element that holds a Space's content and takes the
 * keyboard from a script or a click, never from Tab: the canvas container, or
 * the document body scroller.
 */
export const SPACE_FOCUS_ROOT = 'data-space-focus-root';

/**
 * The content container of a Space on the page.
 * @param spaceId - The Space.
 * @returns The container, or null while the Space shows none (not mounted, or
 *   a document still loading or unavailable).
 */
export function spaceFocusRoot(spaceId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    `[data-space-outlet="${CSS.escape(spaceId)}"] [${SPACE_FOCUS_ROOT}]`,
  );
}
