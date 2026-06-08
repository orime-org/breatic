// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type { StudioType } from '@web/pages/studio/shared/studio-types';

/** The six studio container tabs (spec §6.1; Works added at the 3rd position). */
export type StudioTabKey =
  | 'projects'
  | 'collections'
  | 'works'
  | 'members'
  | 'credits'
  | 'settings';

/** A studio container tab: routing key + i18n label + team-only flag. */
export interface StudioTabDef {
  key: StudioTabKey;
  /** i18n key for the tab label. */
  labelKey: string;
  /**
   * Reserved for future team-only tabs. None today — personal studios show
   * all tabs, including a read-only Members tab (decision A, 2026-06-08).
   */
  teamOnly: boolean;
}

/**
 * All tabs in fixed spec order (spec §6.1): projects → collections → works →
 * members → credits → settings. Works sits at the 3rd position (not the end);
 * it is non-team-only, so personal studios keep it.
 */
export const STUDIO_TABS: readonly StudioTabDef[] = [
  { key: 'projects', labelKey: 'studio.container.tabs.projects', teamOnly: false },
  { key: 'collections', labelKey: 'studio.container.tabs.collections', teamOnly: false },
  { key: 'works', labelKey: 'studio.container.tabs.works', teamOnly: false },
  { key: 'members', labelKey: 'studio.container.tabs.members', teamOnly: false },
  { key: 'credits', labelKey: 'studio.container.tabs.credits', teamOnly: false },
  { key: 'settings', labelKey: 'studio.container.tabs.settings', teamOnly: false },
];

/**
 * The tabs visible for a given studio type. Personal studios now show all 6
 * tabs too — their Members tab is read-only (decision A, 2026-06-08); no team-only
 * tab remains, but the `teamOnly` filter is kept for future team-only tabs.
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
