// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Which region a Studio or Project lives in (inner#1955). The directory hears
 * of a non-global region's new Project or new slug through that region's
 * outbox, a moment later; the tab that made the change already knows the
 * region and answers from it. A Project id never changes, so its region is
 * kept across page loads; a slug can move to another Studio, so a Studio's
 * region is kept only in this tab's memory and asked again on each page load.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apiGet = vi.hoisted(() => vi.fn());
vi.mock('@web/data/api/request', () => ({ apiGet }));

import { directoryApi } from '@web/data/api/directory';
import { rememberProjectRegion, studioRegionOf } from '@web/data/api/regions';

beforeEach(() => {
  apiGet.mockReset();
  window.localStorage.clear();
});

afterEach(() => window.localStorage.clear());

describe('the region of a Project', () => {
  it('answers a Project this tab created without asking, also after a reload', async () => {
    apiGet.mockRejectedValue(new Error('the directory has not heard of it yet'));

    rememberProjectRegion('p-new', 'sg');

    expect(await directoryApi.project('p-new')).toEqual({ region: 'sg' });
    expect(window.localStorage.getItem('breatic:region:project:p-new')).toBe('sg');
    expect(apiGet).not.toHaveBeenCalled();
  });
});

describe('the region of a Studio', () => {
  it('asks the directory for any other slug and keeps nothing across page loads', async () => {
    apiGet.mockResolvedValue({ region: 'sg' });

    expect(await directoryApi.studio('someone-else')).toEqual({ region: 'sg' });
    expect(apiGet).toHaveBeenCalledWith('/directory/studios/someone-else');
    // Requests acting on the slug go to the region the directory named.
    expect(studioRegionOf('someone-else')).toBe('sg');
    expect(window.localStorage.getItem('breatic:region:studio:someone-else')).toBeNull();
  });
});
