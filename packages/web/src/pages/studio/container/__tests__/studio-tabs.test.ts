// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';

import {
  STUDIO_TABS,
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
