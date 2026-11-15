// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Where the tab learns which region a Studio or Project lives in (inner#1955):
 * the switcher's list names every Studio's region, and a Studio's Project list
 * puts its Projects in that Studio's region.
 */

import { describe, expect, it, vi } from 'vitest';

const apiGet = vi.hoisted(() => vi.fn());
vi.mock('@web/data/api/request', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@web/data/api/request')>()),
  apiGet,
}));

import { studiosApi } from '@web/data/api/studios';
import { projectRegionOf, studioRegionOf } from '@web/data/api/regions';

describe('region memory', () => {
  it('learns each Studio of the switcher list under its id and slug', async () => {
    apiGet.mockResolvedValueOnce([{ id: 's-1', slug: 'lumen-sg', region: 'sg' }, { id: 's-2', slug: 'home', region: null }]);

    await studiosApi.listUserStudios();

    expect([studioRegionOf('s-1'), studioRegionOf('lumen-sg'), studioRegionOf('s-2'), studioRegionOf('home')]).toEqual(['sg', 'sg', null, null]);
  });

  it('puts the Projects a Studio lists in the region of that Studio', async () => {
    apiGet.mockResolvedValueOnce([{ id: 's-3', slug: 'far-sg', region: 'sg' }]);
    await studiosApi.listUserStudios();
    apiGet.mockResolvedValueOnce({ items: [{ id: 'p-1' }, { id: 'p-2' }], nextCursor: null, total: 2 });

    await studiosApi.listProjects('far-sg', { archived: false, sort: 'last_opened' as never, cursor: undefined });

    expect([projectRegionOf('p-1'), projectRegionOf('p-2')]).toEqual(['sg', 'sg']);
  });

  it('learns nothing about the Projects of a Studio whose region it does not know', async () => {
    apiGet.mockResolvedValueOnce({ items: [{ id: 'p-9' }], nextCursor: null, total: 1 });

    await studiosApi.listProjects('unknown-handle', { archived: false, sort: 'last_opened' as never, cursor: undefined });

    expect(projectRegionOf('p-9')).toBeUndefined();
  });
});
