// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// `assetsApi.presign` wraps `apiGet`, which already unwraps the `{ data }`
// envelope, so the mock resolves directly to the inner presign object.
vi.mock('@web/data/api/request', () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
}));

import { apiGet, apiPost } from '@web/data/api/request';
import { assetsApi } from '@web/data/api/assets';

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('assetsApi.presign — aligned to the backend presign contract', () => {
  it('sends snake_case query params incl. the declared size and optional hash', async () => {
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
      size: 1234,
      hash: 'a'.repeat(64),
    });

    expect(vi.mocked(apiGet)).toHaveBeenCalledWith('/assets/presign', {
      params: {
        filename: 'photo.png',
        content_type: 'image/png',
        project_id: 'p1',
        size: 1234,
        hash: 'a'.repeat(64),
      },
    });
  });

  it('omits the hash param when hashing degraded to null', async () => {
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
      size: 10,
      hash: null,
    });

    const params = vi.mocked(apiGet).mock.calls[0]![1] as {
      params: Record<string, unknown>;
    };
    expect('hash' in params.params).toBe(false);
  });

  it('returns the normal shape { uploadUrl, fileUrl, key, kind }', async () => {
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
      size: 10,
    });

    expect(result).toEqual({
      uploadUrl: 'https://put',
      fileUrl: 'https://public/photo.png',
      key: 'proj/photo.png',
      kind: 'image',
    });
  });

  it('passes a dedup hit { alreadyExists, fileUrl, kind } through unchanged', async () => {
    vi.mocked(apiGet).mockResolvedValue({
      alreadyExists: true,
      fileUrl: 'https://public/photo.png',
      kind: 'image',
    });

    const result = await assetsApi.presign({
      filename: 'photo.png',
      contentType: 'image/png',
      projectId: 'p1',
      size: 10,
      hash: 'a'.repeat(64),
    });

    expect(result).toEqual({
      alreadyExists: true,
      fileUrl: 'https://public/photo.png',
      kind: 'image',
    });
  });
});

describe('assetsApi.fetchUploadConfig — session-cached knobs', () => {
  it('fetches once and serves later calls from the cache', async () => {
    assetsApi.resetUploadConfigCache();
    vi.mocked(apiGet).mockResolvedValue({
      maxUploadBytes: 2147483648,
      clientMaxAttempts: 3,
      clientRetryBaseDelayMs: 1000,
      clientRequestTimeoutMs: 30000,
      clientPutMinBytesPerSec: 65536,
    });

    const first = await assetsApi.fetchUploadConfig();
    const second = await assetsApi.fetchUploadConfig();

    expect(first.maxUploadBytes).toBe(2147483648);
    expect(second).toBe(first);
    expect(vi.mocked(apiGet)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(apiGet)).toHaveBeenCalledWith('/assets/upload-config');
  });

  it('does not cache a failure (next call retries the fetch)', async () => {
    assetsApi.resetUploadConfigCache();
    vi.mocked(apiGet)
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValueOnce({
        maxUploadBytes: 1,
        clientMaxAttempts: 3,
        clientRetryBaseDelayMs: 1000,
        clientRequestTimeoutMs: 30000,
        clientPutMinBytesPerSec: 65536,
      });

    await expect(assetsApi.fetchUploadConfig()).rejects.toThrow('down');
    await expect(assetsApi.fetchUploadConfig()).resolves.toMatchObject({
      maxUploadBytes: 1,
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

describe('assetsApi.reportDeleted — batch chunking (adversarial round-4)', () => {
  it('splits entries into <=100-entry batches (server .max(100))', async () => {
    vi.mocked(apiPost).mockResolvedValue({ ok: true });
    const entries = Array.from({ length: 230 }, (_, i) => ({
      fileUrl: `https://cdn/a${i}.png`,
      kind: 'image',
    }));
    await assetsApi.reportDeleted({ projectId: 'p1', entries });
    expect(vi.mocked(apiPost)).toHaveBeenCalledTimes(3);
    const sizes = vi
      .mocked(apiPost)
      .mock.calls.map(
        (c) => (c[1] as { entries: unknown[] }).entries.length,
      );
    expect(sizes).toEqual([100, 100, 30]);
  });
});

