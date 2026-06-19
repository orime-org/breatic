// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// `assetsApi.presign` wraps `apiGet`, which already unwraps the `{ data }`
// envelope, so the mock resolves directly to the inner presign object.
vi.mock('@web/data/api/request', () => ({
  apiGet: vi.fn(),
}));

import { apiGet } from '@web/data/api/request';
import { assetsApi } from '@web/data/api/assets';

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('assetsApi.presign — aligned to the backend presign contract', () => {
  it('sends snake_case query params (filename / content_type / project_id)', async () => {
    vi.mocked(apiGet).mockResolvedValue({
      uploadUrl: 'https://put',
      fileUrl: 'https://public',
      key: 'k',
      kind: 'image',
    });

    await assetsApi.presign({
      filename: 'photo.png',
      contentType: 'image/png',
      projectId: 'p1',
    });

    expect(vi.mocked(apiGet)).toHaveBeenCalledWith('/assets/presign', {
      params: {
        filename: 'photo.png',
        content_type: 'image/png',
        project_id: 'p1',
      },
    });
  });

  it('returns the backend shape { uploadUrl, fileUrl, key, kind }', async () => {
    vi.mocked(apiGet).mockResolvedValue({
      uploadUrl: 'https://put',
      fileUrl: 'https://public/photo.png',
      key: 'proj/photo.png',
      kind: 'image',
    });

    const result = await assetsApi.presign({
      filename: 'photo.png',
      contentType: 'image/png',
      projectId: 'p1',
    });

    expect(result).toEqual({
      uploadUrl: 'https://put',
      fileUrl: 'https://public/photo.png',
      key: 'proj/photo.png',
      kind: 'image',
    });
  });
});

describe('assetsApi.putFile — direct PUT to the presigned URL', () => {
  it('PUTs the file with its content type + same-origin credentials', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);
    const file = new File(['x'], 'photo.png', { type: 'image/png' });

    await assetsApi.putFile('https://put', file);

    expect(fetchMock).toHaveBeenCalledWith('https://put', {
      method: 'PUT',
      body: file,
      headers: { 'Content-Type': 'image/png' },
      credentials: 'same-origin',
    });
  });

  it('throws when the storage responds non-ok', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 403 }),
    );
    const file = new File(['x'], 'photo.png', { type: 'image/png' });

    await expect(assetsApi.putFile('https://put', file)).rejects.toThrow(/403/);
  });
});
