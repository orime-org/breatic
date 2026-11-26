// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import { describe, it, expect, expectTypeOf, vi, beforeEach, afterEach } from 'vitest';

// The api layer already unwraps the `{ data }` envelope, so these mocks
// resolve directly to the inner object a caller sees.
vi.mock('@web/data/api/request', () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
}));

import { apiGet, apiPost } from '@web/data/api/request';
import { assetsApi, type UploadConfig } from '@web/data/api/assets';

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('assetsApi.requestUploadTicket', () => {
  it('sends what the server signs a ticket from', async () => {
    vi.mocked(apiPost).mockResolvedValue({
      uploadId: 'upload-1',
      token: 'token-1',
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
      nodeId: 'n1',
      spaceId: 's1',
    });

    expect(vi.mocked(apiPost)).toHaveBeenCalledWith('/assets/upload-ticket', {
      filename: 'photo.png',
      content_type: 'image/png',
      project_id: 'p1',
      size: 1234,
      client_hash: 'a'.repeat(64),
      node_id: 'n1',
      space_id: 's1',
    }, expect.objectContaining({ timeout: 0 }));
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
      derived: true,
    });

    const sent = vi.mocked(apiPost).mock.calls[0]?.[1] as Record<string, unknown>;
    expect(Object.keys(sent)).not.toContain('node_id');
    expect(Object.keys(sent)).not.toContain('space_id');
    expect(sent.derived).toBe(true);
  });

  // A studio's avatar has no project; the ticket names the studio and says
  // what the picture is for.
  it('sends a studio target and a purpose, with no project', async () => {
    vi.mocked(apiPost).mockResolvedValue({ alreadyExists: true, assetId: 'a1', fileUrl: 'u', kind: 'image' });

    await assetsApi.requestUploadTicket({
      filename: 'avatar.png',
      contentType: 'image/png',
      studioId: 'st1',
      size: 10,
      hash: 'c'.repeat(64),
      purpose: 'studio_avatar',
    });

    expect(vi.mocked(apiPost)).toHaveBeenCalledWith('/assets/upload-ticket', {
      filename: 'avatar.png',
      content_type: 'image/png',
      studio_id: 'st1',
      size: 10,
      client_hash: 'c'.repeat(64),
      purpose: 'studio_avatar',
    }, expect.objectContaining({ timeout: 0 }));
  });

  it('sends the 3D part a picture is for and the picture it held at the start (inner#1693)', async () => {
    vi.mocked(apiPost).mockResolvedValue({ alreadyExists: true, assetId: 'a1', fileUrl: 'u', kind: 'image' });

    await assetsApi.requestUploadTicket({
      filename: 'wood.png', contentType: 'image/png', projectId: 'p1', size: 10, hash: 'h',
      spaceId: 's1', purpose: 'scene_look', objectId: 'o1', part: '3', startMap: null,
    });

    expect(vi.mocked(apiPost).mock.calls[0]?.[1]).toEqual({
      filename: 'wood.png', content_type: 'image/png', project_id: 'p1', size: 10, client_hash: 'h',
      space_id: 's1', purpose: 'scene_look', object_id: 'o1', part: '3', start_map: null,
    });
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
      uploadIdleTimeoutMs: 60000,
    });

    const first = await assetsApi.fetchUploadConfig();
    const second = await assetsApi.fetchUploadConfig();

    expect(first.maxUploadBytes).toBe(2147483648);
    expect(second).toBe(first);
    expect(vi.mocked(apiGet)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(apiGet)).toHaveBeenCalledWith('/assets/upload-config');
  });

  it('answers the cached knobs at once, and nothing before the first fetch (inner#1127 A18)', async () => {
    assetsApi.resetUploadConfigCache();
    expect(assetsApi.cachedUploadConfig()).toBeNull();
    vi.mocked(apiGet).mockResolvedValue({
      maxUploadBytes: 1,
      clientMaxAttempts: 3,
      clientRetryBaseDelayMs: 1000,
      uploadIdleTimeoutMs: 60000,
      assetUrlPrefix: 'https://cdn.example/',
    });

    await assetsApi.fetchUploadConfig();

    expect(assetsApi.cachedUploadConfig()?.assetUrlPrefix).toBe('https://cdn.example/');
  });

  it('does not cache a failure (next call retries the fetch)', async () => {
    assetsApi.resetUploadConfigCache();
    vi.mocked(apiGet)
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValueOnce({
        maxUploadBytes: 1,
        clientMaxAttempts: 3,
        clientRetryBaseDelayMs: 1000,
        uploadIdleTimeoutMs: 60000,
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


// #1580 L-05: a page learns how its upload ended from the `upload:ended` message
// (Project) or the Studio page poll; the status query and its interval are gone.
describe('the upload status query (removed)', () => {
  it('L-05 has no client call and no interval in the upload knobs', () => {
    expect(Object.keys(assetsApi)).not.toContain('fetchUploadStatus');
    expectTypeOf<UploadConfig>().not.toHaveProperty('uploadStatusPollSeconds');
  });
});

describe('assetsApi.requestUploadTicketBatch', () => {
  it('sends every file of one export in the batch form and returns the answers in order', async () => {
    vi.mocked(apiPost).mockResolvedValue({ items: [{ refused: { reason: 'storage' } }] });

    const answers = await assetsApi.requestUploadTicketBatch({
      projectId: 'p1',
      spaceId: 's1',
      source: 'mini_tool',
      toolName: 'image.grid',
      items: [{ filename: 'GRID.png', contentType: 'image/png', size: 9, hash: 'c'.repeat(64), nodeId: 'n1' }],
    });

    expect(vi.mocked(apiPost)).toHaveBeenCalledWith('/assets/upload-ticket', {
      project_id: 'p1',
      space_id: 's1',
      source: 'mini_tool',
      tool_name: 'image.grid',
      items: [{ filename: 'GRID.png', content_type: 'image/png', size: 9, client_hash: 'c'.repeat(64), node_id: 'n1' }],
    }, expect.objectContaining({ timeout: 0 }));
    expect(answers).toEqual([{ refused: { reason: 'storage' } }]);
  });
});


// inner#1595 §3.5: the server opens the upload at the ingest Worker before it
// answers, bounded by the task budget, so the page waits for that answer rather
// than giving up at the client's 30 seconds and asking again.
describe('ticket requests carry no client timeout (inner#1595)', () => {
  it('W07 asks for a single ticket with timeout 0, the body as before', async () => {
    vi.mocked(apiPost).mockResolvedValue({ alreadyExists: true, assetId: 'a1', fileUrl: 'u', kind: 'image' });

    await assetsApi.requestUploadTicket({
      filename: 'photo.png',
      contentType: 'image/png',
      projectId: 'p1',
      size: 1234,
      hash: 'a'.repeat(64),
      nodeId: 'n1',
      spaceId: 's1',
    });

    expect(vi.mocked(apiPost)).toHaveBeenCalledOnce();
    const [url, body, config] = vi.mocked(apiPost).mock.calls[0]!;
    expect(url).toBe('/assets/upload-ticket');
    expect(body).toEqual({
      filename: 'photo.png',
      content_type: 'image/png',
      project_id: 'p1',
      size: 1234,
      client_hash: 'a'.repeat(64),
      node_id: 'n1',
      space_id: 's1',
    });
    expect(config?.timeout).toBe(0);
  });

  it('W08 asks for a batch of tickets with timeout 0, the body as before', async () => {
    vi.mocked(apiPost).mockResolvedValue({ items: [] });

    await assetsApi.requestUploadTicketBatch({
      projectId: 'p1',
      spaceId: 's1',
      source: 'mini_tool',
      toolName: 'image.grid',
      items: [{ filename: 'GRID.png', contentType: 'image/png', size: 9, hash: 'c'.repeat(64), nodeId: 'n1' }],
    });

    expect(vi.mocked(apiPost)).toHaveBeenCalledOnce();
    const [, body, config] = vi.mocked(apiPost).mock.calls[0]!;
    expect(body).toEqual({
      project_id: 'p1',
      space_id: 's1',
      source: 'mini_tool',
      tool_name: 'image.grid',
      items: [{ filename: 'GRID.png', content_type: 'image/png', size: 9, client_hash: 'c'.repeat(64), node_id: 'n1' }],
    });
    expect(config?.timeout).toBe(0);
  });
});
