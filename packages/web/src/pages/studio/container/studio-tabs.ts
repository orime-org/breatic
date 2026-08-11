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
 * The tab a studio opens at when its address names none. Projects is the
 * studio's reason to exist, so it is what `/studio/{slug}` means.
 */
export const DEFAULT_STUDIO_TAB: StudioTabKey = 'projects';

/**
 * Whether a URL segment names one of the tabs.
 *
 * Asked of `STUDIO_TABS` rather than of a second list written out here: a tab
 * added to that list becomes addressable in the same edit, and a tab removed
 * from it stops being addressable in the same edit. Two lists would drift, and
 * the drift would show up as a URL that resolves to nothing.
 *
 * Nothing is corrected on the way in — not case, not surrounding whitespace,
 * not a trailing slash. A URL is an exact address; repairing one quietly makes
 * both spellings valid forever and there is then no way to take the wrong one
 * back.
 * @param value - The `:tab` route parameter, absent when the address has none.
 * @returns Whether the segment names a tab.
 */
export function isStudioTabKey(value: string | undefined): value is StudioTabKey {
  return STUDIO_TABS.some((tab) => tab.key === value);
}

/**
 * The tab an address names, or the default when it names none or names
 * something that is not a tab.
 *
 * This answers "which tab do I render". It deliberately cannot tell an absent
 * segment from a wrong one — both render Projects — so a caller that needs to
 * distinguish them (to redirect away from a wrong address while leaving a bare
 * one alone) asks {@link isStudioTabKey} instead.
 * @param value - The `:tab` route parameter, absent when the address has none.
 * @returns The tab to render.
 */
export function studioTabFromParam(value: string | undefined): StudioTabKey {
  return isStudioTabKey(value) ? value : DEFAULT_STUDIO_TAB;
}

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
