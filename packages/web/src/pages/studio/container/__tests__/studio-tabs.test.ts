// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';

import {
  DEFAULT_STUDIO_TAB,
  isStudioTabKey,
  STUDIO_TABS,
  studioTabFromParam,
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
    const keys = visibleStudioTabs('team').map((tab) => tab.key);
    expect(keys).toContain('works');
    expect(keys).toContain('members');
    expect(keys).toHaveLength(6);
  });

  it('shows all 6 tabs for a personal studio (Members now read-only, A 方案)', () => {
    const keys = visibleStudioTabs('personal').map((tab) => tab.key);
    expect(keys).toContain('works');
    expect(keys).toContain('members');
    expect(keys).toHaveLength(6);
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
    expect(studioTabFromParam('Settings')).toBe(DEFAULT_STUDIO_TAB);
    expect(studioTabFromParam(' settings')).toBe(DEFAULT_STUDIO_TAB);
    expect(studioTabFromParam('settings/')).toBe(DEFAULT_STUDIO_TAB);
  });

  it('reports whether the segment was a real tab, so the caller can redirect', () => {
    // The fallback alone cannot tell "no segment" from "a wrong segment":
    // the first is a normal visit to /studio/{slug}, the second is an address
    // that should not stay in the bar. This is the question that separates
    // them, and it is asked of the same list.
    expect(isStudioTabKey('settings')).toBe(true);
    expect(isStudioTabKey(undefined)).toBe(false);
    expect(isStudioTabKey('nonsense')).toBe(false);
  });
});
