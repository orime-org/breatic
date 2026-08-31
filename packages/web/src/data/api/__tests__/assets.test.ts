// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

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

  it('ALWAYS sends the hash — there is no hashless presign any more (#1826 §0 rule 4)', async () => {
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
      hash: 'a'.repeat(64),
    });

    const params = vi.mocked(apiGet).mock.calls[0]![1] as {
      params: Record<string, unknown>;
    };
    // The old contract omitted `hash` when hashing degraded, letting the upload
    // proceed untracked. That degrade is retired: the caller refuses to upload
    // without a hash and the server 400s a hashless presign, so the parameter
    // is always on the wire.
    expect(params.params['hash']).toBe('a'.repeat(64));
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
      hash: 'a'.repeat(64),
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

describe('assetsApi.reportUploaded — cover reference + derived flag (#1824)', () => {
  it('rides the cover HASH on a regular video report — cover_key is retired (#1826 §4.5)', async () => {
    vi.mocked(apiPost).mockResolvedValue({ ok: true });

    await assetsApi.reportUploaded({
      projectId: 'p1',
      kind: 'video',
      key: 'video/2026-07-25/clip.mp4',
      hash: 'a'.repeat(64),
      nodeId: 'n1',
      spaceId: 's1',
      coverHash: 'd'.repeat(64),
      metadata: { filename: 'clip.mp4', size: 10, mimeType: 'video/mp4' },
    });

    const body = vi.mocked(apiPost).mock.calls[0]![1] as Record<string, unknown>;
    expect(body.cover_hash).toBe('d'.repeat(64));
    // cover_key no longer exists on the wire (retired with the tenant-neutral key).
    expect('cover_key' in body).toBe(false);
  });

  it('maps a cover source to the wire — a first-class cover asset (#1826 §4.5)', async () => {
    vi.mocked(apiPost).mockResolvedValue({ ok: true });

    await assetsApi.reportUploaded({
      projectId: 'p1',
      kind: 'image',
      key: 'image/2026-07-25/cover.jpg',
      source: 'cover',
      derived: true,
    });

    expect(vi.mocked(apiPost)).toHaveBeenCalledWith(
      '/assets/uploaded',
      expect.objectContaining({ source: 'cover', derived: true }),
    );
  });

  it('maps coverHash to the snake_case cover_hash wire field (dedup video path)', async () => {
    vi.mocked(apiPost).mockResolvedValue({ ok: true });

    await assetsApi.reportUploaded({
      projectId: 'p1',
      kind: 'video',
      dedup: true,
      hash: 'b'.repeat(64),
      coverHash: 'c'.repeat(64),
    });

    expect(vi.mocked(apiPost)).toHaveBeenCalledWith(
      '/assets/uploaded',
      expect.objectContaining({ cover_hash: 'c'.repeat(64) }),
    );
  });

  it('sends derived:true for a byproduct report (cover / crop), and omits it otherwise', async () => {
    vi.mocked(apiPost).mockResolvedValue({ ok: true });

    // A derived byproduct (a cover / crop) carries the flag so the server
    // registers it in the ledger but does NOT announce a feed row (model A).
    await assetsApi.reportUploaded({
      projectId: 'p1',
      kind: 'image',
      key: 'u1/p1/image/clip-cover.jpg',
      derived: true,
    });
    const derivedBody = vi.mocked(apiPost).mock.calls[0]![1] as Record<
      string,
      unknown
    >;
    expect(derivedBody.derived).toBe(true);

    // A real upload never sends the flag → the server emits its feed row.
    vi.mocked(apiPost).mockClear();
    await assetsApi.reportUploaded({
      projectId: 'p1',
      kind: 'video',
      key: 'u1/p1/video/clip.mp4',
    });
    const plainBody = vi.mocked(apiPost).mock.calls[0]![1] as Record<
      string,
      unknown
    >;
    expect('derived' in plainBody).toBe(false);
    expect('cover_key' in plainBody).toBe(false);
    expect('cover_hash' in plainBody).toBe(false);
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

