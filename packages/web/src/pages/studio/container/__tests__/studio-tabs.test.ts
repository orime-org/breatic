// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';

import {
  DEFAULT_STUDIO_TAB,
  isAddressableTabSegment,
  isTabOnThisPage,
  STUDIO_TABS,
  studioTabFromParam,
  studioTabPath,
  visibleStudioTabs,
} from '@web/pages/studio/container/studio-tabs';

describe('studio-tabs (spec §6.1 — Works tab at the 3rd position)', () => {
  it('orders the six tabs projects → collections → works → members → credits → settings', () => {
    expect(STUDIO_TABS.map((tab) => tab.key)).toEqual([
      'projects',
      'collections',
      'works',
      'members',
      'credits',
      'settings',
    ]);
  });

  it('places Works at index 2 (the 3rd position, not the end)', () => {
    expect(STUDIO_TABS[2]?.key).toBe('works');
  });

  it('marks Works as non-team-only so it shows for personal studios too', () => {
    const works = STUDIO_TABS.find((tab) => tab.key === 'works');
    expect(works?.teamOnly).toBe(false);
  });

  it('shows Works for a team studio (6 tabs, Members included)', () => {
    const keys = visibleStudioTabs('team', 'admin').map((tab) => tab.key);
    expect(keys).toContain('works');
    expect(keys).toContain('members');
    expect(keys).toHaveLength(6);
  });

  it('shows all 6 tabs for a personal studio (Members now read-only, A 方案)', () => {
    const keys = visibleStudioTabs('personal', 'admin').map((tab) => tab.key);
    expect(keys).toContain('works');
    expect(keys).toContain('members');
    expect(keys).toHaveLength(6);
  });
});

describe('visibleStudioTabs — Credits belongs to the studio admin alone', () => {
  it('keeps Credits for the admin', () => {
    for (const type of ['team', 'personal'] as const) {
      expect(
        visibleStudioTabs(type, 'admin').map((tab) => tab.key),
      ).toContain('credits');
    }
  });

  it('drops Credits for every other role, leaving the other five', () => {
    for (const role of ['maintainer', 'guest'] as const) {
      const keys = visibleStudioTabs('team', role).map((tab) => tab.key);
      expect(keys).not.toContain('credits');
      expect(keys).toHaveLength(5);
    }
  });

  it('offers a non-member nothing — that page renders no strip at all', () => {
    expect(visibleStudioTabs('team', null)).toEqual([]);
  });
});

describe('isTabOnThisPage — the strip is what decides an address is real', () => {
  it('answers for a role exactly what the strip shows it', () => {
    // Asked of the strip rather than restated, so a section that becomes
    // role-gated later stops being addressable in the same edit.
    for (const role of ['admin', 'maintainer', 'guest'] as const) {
      const shown = visibleStudioTabs('team', role).map((tab) => tab.key);
      for (const tab of STUDIO_TABS) {
        expect(isTabOnThisPage(tab.key, 'team', role)).toBe(
          shown.includes(tab.key),
        );
      }
    }
  });

  it('refuses Credits to a maintainer and grants it to the admin', () => {
    expect(isTabOnThisPage('credits', 'team', 'maintainer')).toBe(false);
    expect(isTabOnThisPage('credits', 'team', 'admin')).toBe(true);
  });
});

describe('studioTabFromParam — the URL segment is the tab', () => {
  it('accepts every key the tab list itself declares', () => {
    // Derived from STUDIO_TABS rather than restated, so a tab added to the
    // list is addressable by URL without a second edit — and a tab removed
    // from it stops being addressable in the same commit.
    for (const tab of STUDIO_TABS) {
      expect(studioTabFromParam(tab.key)).toBe(tab.key);
    }
  });

  it('falls back to projects for a name that is not a tab', () => {
    expect(studioTabFromParam('nonsense')).toBe(DEFAULT_STUDIO_TAB);
    expect(DEFAULT_STUDIO_TAB).toBe('projects');
  });

  it('falls back to projects when the segment is absent', () => {
    // `/studio/{slug}` carries no tab segment; it is the same page opened at
    // its default, not an error.
    expect(studioTabFromParam(undefined)).toBe(DEFAULT_STUDIO_TAB);
  });

  it('rejects a name that only looks like a tab', () => {
    // Case and whitespace are not corrected. A URL is an exact address, and
    // silently repairing one makes two spellings of it valid forever.
    //
    // A trailing slash is deliberately NOT among these: the router strips it
    // while matching, so `/studio/x/settings/` hands this function the same
    // `settings` as the address without one. Asserting on `'settings/'` would
    // be asserting on an input no caller can produce — green either way, and
    // green is then a claim about a rule that does not exist.
    expect(studioTabFromParam('Settings')).toBe(DEFAULT_STUDIO_TAB);
    expect(studioTabFromParam(' settings')).toBe(DEFAULT_STUDIO_TAB);
  });
});

describe('isAddressableTabSegment — the address is judged, not the name', () => {
  it('accepts every section that carries a segment of its own', () => {
    for (const tab of STUDIO_TABS) {
      if (tab.key === DEFAULT_STUDIO_TAB) continue;
      expect(isAddressableTabSegment(tab.key)).toBe(true);
    }
  });

  it('refuses the default section spelled out, which has no segment', () => {
    // `projects` is a real tab, so a name test would pass it — but the address
    // this scheme emits for the default section carries no segment at all.
    // Accepting both spellings would give one page two addresses, and the
    // strip's first link, marked as the current page, would then point at the
    // other one.
    expect(isAddressableTabSegment(DEFAULT_STUDIO_TAB)).toBe(false);
    expect(studioTabPath('acme', DEFAULT_STUDIO_TAB)).toBe('/studio/acme');
  });

  it('refuses a name that is not a section, and an absent segment', () => {
    expect(isAddressableTabSegment('nonsense')).toBe(false);
    expect(isAddressableTabSegment(undefined)).toBe(false);
  });

  it('accepts exactly what studioTabPath emits, for every section', () => {
    // The one rule this pair exists to keep: every SEGMENT this scheme writes
    // is accepted, and the default section — which writes none — is not.
    // (Accepted addresses are not thereby equal to emitted ones: a trailing
    // slash survives in the bar but never reaches the predicate. See the
    // function's own TSDoc.) Asked of the whole list so a section added later
    // cannot quietly fall on one side only.
    for (const tab of STUDIO_TABS) {
      const emitted = studioTabPath('acme', tab.key);
      const segment = emitted.split('/')[3];
      expect(isAddressableTabSegment(segment)).toBe(
        tab.key !== DEFAULT_STUDIO_TAB,
      );
    }
  });
});
