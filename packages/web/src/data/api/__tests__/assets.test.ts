// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The api layer already unwraps the `{ data }` envelope, so these mocks
// resolve directly to the inner object a caller sees.
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

describe('assetsApi.requestUploadTicket', () => {
  it('sends what the server signs a ticket from', async () => {
    vi.mocked(apiPost).mockResolvedValue({
      ticket: 'signed',
      storageKey: 'image/2026-08-31/x.png',
      uploadUrl: 'https://ingest.example.com',
      kind: 'image',
      partSize: 5 * 1024 * 1024,
      totalParts: 1,
    });

    await assetsApi.requestUploadTicket({
      filename: 'photo.png',
      contentType: 'image/png',
      projectId: 'p1',
      size: 1234,
      hash: 'a'.repeat(64),
      leaseGen: 6,
      nodeId: 'n1',
      spaceId: 's1',
    });

    expect(vi.mocked(apiPost)).toHaveBeenCalledWith('/assets/upload-ticket', {
      filename: 'photo.png',
      content_type: 'image/png',
      project_id: 'p1',
      size: 1234,
      client_hash: 'a'.repeat(64),
      lease_gen: 6,
      node_id: 'n1',
      space_id: 's1',
    });
  });

  // A focus crop has no node. Sending the keys as undefined would fail the
  // server's uuid check on a field the request does not mean to carry.
  it('leaves out the context a crop does not have', async () => {
    vi.mocked(apiPost).mockResolvedValue({ alreadyExists: true, fileUrl: 'u', kind: 'image' });

    await assetsApi.requestUploadTicket({
      filename: 'crop.png',
      contentType: 'image/png',
      projectId: 'p1',
      size: 10,
      hash: 'b'.repeat(64),
      leaseGen: 0,
      derived: true,
    });

    const sent = vi.mocked(apiPost).mock.calls[0]?.[1] as Record<string, unknown>;
    expect(Object.keys(sent)).not.toContain('node_id');
    expect(Object.keys(sent)).not.toContain('space_id');
    expect(sent.derived).toBe(true);
  });

  it('hands back a dedup hit as it came', async () => {
    vi.mocked(apiPost).mockResolvedValue({
      alreadyExists: true,
      fileUrl: 'https://cdn/x.png',
      kind: 'image',
    });

    const res = await assetsApi.requestUploadTicket({
      filename: 'photo.png',
      contentType: 'image/png',
      projectId: 'p1',
      size: 1234,
      hash: 'a'.repeat(64),
      leaseGen: 6,
    });

    expect(res).toEqual({
      alreadyExists: true,
      fileUrl: 'https://cdn/x.png',
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

