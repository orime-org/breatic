// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type { StudioType } from '@web/pages/studio/shared/studio-types';

/** The five studio container tabs (spec §2.2). */
export type StudioTabKey =
  | 'projects'
  | 'collections'
  | 'members'
  | 'credits'
  | 'settings';

/** A studio container tab: routing key + i18n label + team-only flag. */
export interface StudioTabDef {
  key: StudioTabKey;
  /** i18n key for the tab label. */
  labelKey: string;
  /** Members is only shown for team studios (spec §2.2). */
  teamOnly: boolean;
}

/** All tabs in fixed spec order: projects → collections → members → credits → settings. */
export const STUDIO_TABS: readonly StudioTabDef[] = [
  { key: 'projects', labelKey: 'studio.container.tabs.projects', teamOnly: false },
  { key: 'collections', labelKey: 'studio.container.tabs.collections', teamOnly: false },
  { key: 'members', labelKey: 'studio.container.tabs.members', teamOnly: true },
  { key: 'credits', labelKey: 'studio.container.tabs.credits', teamOnly: false },
  { key: 'settings', labelKey: 'studio.container.tabs.settings', teamOnly: false },
];

/**
 * The tabs visible for a given studio type — personal studios drop the
 * team-only Members tab (spec §2.2), leaving 4 tabs.
 * @param studioType whether the studio is personal or team.
 * @returns the ordered list of visible tabs.
 */
export function visibleStudioTabs(
  studioType: StudioType,
): readonly StudioTabDef[] {
  return studioType === 'team'
    ? STUDIO_TABS
    : STUDIO_TABS.filter((tab) => !tab.teamOnly);
}
