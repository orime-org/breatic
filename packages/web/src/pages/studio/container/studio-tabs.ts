// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type {
  StudioRole,
  StudioType,
} from '@web/pages/studio/shared/studio-types';

/** The six studio container tabs (spec §6.1; Works added at the 3rd position). */
export type StudioTabKey =
  | 'projects'
  | 'collections'
  | 'works'
  | 'members'
  | 'credits'
  | 'settings';

/** A studio container tab: routing key + i18n label + who it is for. */
export interface StudioTabDef {
  key: StudioTabKey;
  /** i18n key for the tab label. */
  labelKey: string;
  /**
   * Reserved for future team-only tabs. None today — personal studios show
   * all tabs, including a read-only Members tab (decision A, 2026-06-08).
   */
  teamOnly: boolean;
  /** Whether only the studio's admin gets this section. */
  adminOnly: boolean;
}

/**
 * All tabs in fixed spec order (spec §6.1): projects → collections → works →
 * members → credits → settings. Works sits at the 3rd position (not the end);
 * it is non-team-only, so personal studios keep it.
 */
export const STUDIO_TABS: readonly StudioTabDef[] = [
  { key: 'projects', labelKey: 'studio.container.tabs.projects', teamOnly: false, adminOnly: false },
  { key: 'collections', labelKey: 'studio.container.tabs.collections', teamOnly: false, adminOnly: false },
  { key: 'works', labelKey: 'studio.container.tabs.works', teamOnly: false, adminOnly: false },
  { key: 'members', labelKey: 'studio.container.tabs.members', teamOnly: false, adminOnly: false },
  { key: 'credits', labelKey: 'studio.container.tabs.credits', teamOnly: false, adminOnly: true },
  { key: 'settings', labelKey: 'studio.container.tabs.settings', teamOnly: false, adminOnly: false },
];

/**
 * The tab a studio opens at when its address names none. Projects is the
 * studio's reason to exist, so it is what `/studio/{slug}` means.
 */
export const DEFAULT_STUDIO_TAB: StudioTabKey = 'projects';

/**
 * The address of one of a studio's sections.
 *
 * One place builds these, because the product navigates to a section from
 * three: the section strip, the account menu, and the rename redirect.
 * Hand-assembling the scheme at each site is how `'settings'` becomes a bare
 * string that `StudioTabKey` never checked — the tab list stays the single
 * source of truth for what is addressable only if it is also the source of the
 * addresses.
 *
 * The redirect in `StudioContainerPage` is deliberately NOT one of them: it
 * answers an address that named no section at all, so it goes to the studio
 * rather than to a section of it, and routing it through here would be a claim
 * about which section it meant.
 *
 * The default section has ONE address, the studio's own. A spelled-out
 * `/projects` is not a second one: {@link isAddressableTabSegment} refuses it
 * and the container sends it back here, so the strip's first link can never
 * point away from the page its reader is already on.
 * @param slug - The studio.
 * @param tab - The section.
 * @returns The path to that section.
 */
export function studioTabPath(slug: string, tab: StudioTabKey): string {
  return tab === DEFAULT_STUDIO_TAB
    ? `/studio/${slug}`
    : `/studio/${slug}/${tab}`;
}

/**
 * Whether a URL segment names one of the tabs.
 *
 * Asked of `STUDIO_TABS` rather than of a second list written out here: a tab
 * added to that list becomes addressable in the same edit, and a tab removed
 * from it stops being addressable in the same edit. Two lists would drift, and
 * the drift would show up as a URL that resolves to nothing.
 *
 * Nothing is corrected on the way in — not case, and not surrounding
 * whitespace. A URL is an exact address; repairing one quietly makes both
 * spellings valid forever and there is then no way to take the wrong one back.
 * (A trailing slash never reaches here to be corrected or not: the router
 * strips it while matching, so `/studio/x/settings/` hands over the same
 * `settings` as the address without it.)
 * @param value - The `:tab` route parameter, absent when the address has none.
 * @returns Whether the segment names a tab.
 */
function isStudioTabKey(value: string | undefined): value is StudioTabKey {
  return STUDIO_TABS.some((tab) => tab.key === value);
}

/**
 * Whether a URL segment is the one this scheme would put there for its
 * section — the question a router asks, as opposed to {@link isStudioTabKey},
 * which asks the narrower one about the name alone.
 *
 * The two differ on exactly one value. `projects` is a real tab name, so the
 * name test passes it; but the default section's address carries no segment at
 * all (see {@link studioTabPath}), so `/studio/{slug}/projects` is a second
 * address for a page that has one — and standing on it means the strip's first
 * link, the one marked as the current page, points at a different URL than the
 * one in the bar.
 *
 * What this rules out is a SEGMENT we would not have written. It does not make
 * the accepted addresses equal to the emitted ones, and the gap is worth
 * naming: the router hands over `settings` for `/studio/x/settings/` as
 * readily as for `/studio/x/settings`, so a trailing slash reaches this
 * function already gone and the address keeps it. That is how every route in
 * this app behaves — `/studio/` renders the same page as `/studio` — so
 * normalising it is not this page's business to invent alone.
 * @param value - The `:tab` route parameter, absent when the address has none.
 * @returns Whether this scheme would produce a segment like it.
 */
export function isAddressableTabSegment(
  value: string | undefined,
): value is StudioTabKey {
  return isStudioTabKey(value) && value !== DEFAULT_STUDIO_TAB;
}

/**
 * The tab an address names, or the default when it names none or names
 * something that is not a tab.
 *
 * This answers "which tab do I render". It deliberately cannot tell an absent
 * segment from a wrong one — both render Projects — so a caller that needs to
 * distinguish them (to redirect away from an address this scheme would not
 * have produced, while leaving a bare one alone) asks
 * {@link isAddressableTabSegment} instead.
 * @param value - The `:tab` route parameter, absent when the address has none.
 * @returns The tab to render.
 */
export function studioTabFromParam(value: string | undefined): StudioTabKey {
  return isStudioTabKey(value) ? value : DEFAULT_STUDIO_TAB;
}

/**
 * The tabs a given viewer sees on a given studio.
 *
 * Two filters, and they answer different questions. `teamOnly` asks what kind
 * of studio this is: none is team-only today — a personal studio's Members
 * section is read-only rather than absent (decision A, 2026-06-08) — and the
 * filter is kept for a future section that is genuinely team-only.
 * `adminOnly` asks who the viewer is: Credits is the studio's money, and the
 * admin is who manages it.
 *
 * A non-member gets nothing. That is not a gate on top of the others: their
 * page renders no strip at all (the public façade), so "which sections does
 * it list" has one honest answer.
 * @param studioType whether the studio is personal or team.
 * @param role the viewer's role in this studio, `null` for a non-member.
 * @returns the ordered list of visible tabs.
 */
export function visibleStudioTabs(
  studioType: StudioType,
  role: StudioRole | null,
): readonly StudioTabDef[] {
  if (role === null) return [];
  return STUDIO_TABS.filter(
    (tab) =>
      (studioType === 'team' || !tab.teamOnly) &&
      (role === 'admin' || !tab.adminOnly),
  );
}

/**
 * Whether a section is on this viewer's page — the question the container
 * asks before rendering an address that names one.
 *
 * Asked of {@link visibleStudioTabs} rather than of a second rule written out
 * at the router: a section that becomes role-gated is hidden from the strip
 * and unreachable by URL in the same edit. Two rules would drift, and the
 * drift is a page whose address promises a section its strip does not offer —
 * or worse, one that hides the link and serves the panel to anyone who types
 * the address.
 * @param tab the section the address names.
 * @param studioType whether the studio is personal or team.
 * @param role the viewer's role in this studio, `null` for a non-member.
 * @returns whether that section is on this page.
 */
export function isTabOnThisPage(
  tab: StudioTabKey,
  studioType: StudioType,
  role: StudioRole | null,
): boolean {
  return visibleStudioTabs(studioType, role).some((def) => def.key === tab);
}
