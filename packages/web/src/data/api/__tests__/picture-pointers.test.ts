// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@web/data/api/request', () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPatch: vi.fn(),
  apiPut: vi.fn(),
  apiDelete: vi.fn(),
}));

import { apiPut } from '@web/data/api/request';
import { projectsApi } from '@web/data/api/projects';
import { studiosApi } from '@web/data/api/studios';

beforeEach(() => {
  vi.clearAllMocks();
});

// A cover or an avatar is an uploaded asset; these calls only point the project
// or the studio at it.
describe('pointing at an uploaded picture', () => {
  it('sets a project cover by asset id', async () => {
    vi.mocked(apiPut).mockResolvedValue({ id: 'p1' });

    await projectsApi.setCover('p1', 'asset-1');

    expect(vi.mocked(apiPut)).toHaveBeenCalledWith('/projects/p1/cover', {
      asset_id: 'asset-1',
    });
  });

  it('sets a studio avatar by asset id', async () => {
    vi.mocked(apiPut).mockResolvedValue({ id: 'st1' });

    await studiosApi.setAvatar('acme', 'asset-2');

    expect(vi.mocked(apiPut)).toHaveBeenCalledWith('/studio/acme/avatar', {
      asset_id: 'asset-2',
    });
  });

  it('no longer uploads avatar bytes directly', () => {
    expect('uploadAvatar' in studiosApi).toBe(false);
  });
});
