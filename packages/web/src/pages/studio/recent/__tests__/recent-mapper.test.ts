// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';

import type { RecentFeedItem } from '@web/data/api/studios';
import { toRecentItemView } from '@web/pages/studio/recent/recent-mapper';

const WIRE: RecentFeedItem = {
  projectId: 'p-123',
  name: 'My Project',
  slug: 'my-project',
  thumbnailUrl: 'https://cdn/x.png',
  studioId: 's-9',
  studioName: 'Acme Studio',
  myRole: 'editor',
  lastOpenedAt: '2026-06-05T05:40:00.000Z',
};

describe('toRecentItemView', () => {
  it('maps a wire row to the card view model (projectId → id, kind = project)', () => {
    const view = toRecentItemView(WIRE);
    expect(view).toEqual({
      id: 'p-123',
      kind: 'project',
      slug: 'my-project',
      name: 'My Project',
      thumbnailUrl: 'https://cdn/x.png',
      lastOpenedAt: '2026-06-05T05:40:00.000Z',
      studioId: 's-9',
      studioName: 'Acme Studio',
      myRole: 'editor',
    });
  });

  it('defaults a null wire role (open-baseline, no membership row) to viewer', () => {
    const view = toRecentItemView({ ...WIRE, myRole: null });
    expect(view.myRole).toBe('viewer');
  });

  it('carries a null thumbnail through unchanged', () => {
    const view = toRecentItemView({ ...WIRE, thumbnailUrl: null });
    expect(view.thumbnailUrl).toBeNull();
  });
});
