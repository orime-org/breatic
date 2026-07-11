// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type { ProjectSpace } from '@web/data/yjs/project-meta';

/**
 * Resolves which Space the page should show as active. The active tab is
 * LOCAL-ONLY state (user 2026-07-11): it used to live in the shared per-user
 * Yjs subtree, which two machines on the same account both live-subscribe
 * to — machine A clicking a tab flipped machine B's active tab and remounted
 * B's running space body. Opening a project therefore starts with no local
 * choice and shows the FIRST open tab; a local choice wins while its tab is
 * still open; a stale choice (tab closed on another machine / space deleted)
 * falls back to the first open tab.
 * @param openTabs - The user's open tabs, resolved against the live spaces.
 * @param localActiveId - This window's own active-tab choice (null = none yet).
 * @returns The Space to render, or undefined when no tabs are open.
 */
export function resolveEffectiveActiveSpace(
  openTabs: ReadonlyArray<ProjectSpace>,
  localActiveId: string | null,
): ProjectSpace | undefined {
  return openTabs.find((s) => s.id === localActiveId) ?? openTabs[0];
}
