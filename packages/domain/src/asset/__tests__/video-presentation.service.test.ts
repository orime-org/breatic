// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StudioAssetEntity } from '@breatic/shared';
import type * as coreModule from '@breatic/core';
import { resolveVideoPresentation, repairVideoPresentation, ensureVideoPresentation } from '../video-presentation.service.js';

const { loadProjectRole, findLiveByStorageKey, findById, keyFromUrl, publicUrl } = vi.hoisted(() => ({
  loadProjectRole: vi.fn(), findLiveByStorageKey: vi.fn(), findById: vi.fn(), keyFromUrl: vi.fn(), publicUrl: vi.fn(),
}));
const { videoPresentationAtIngest, queueAdd } = vi.hoisted(() => ({ videoPresentationAtIngest: vi.fn(), queueAdd: vi.fn() }));
vi.mock('@breatic/core', async (original) => {
  const actual = await original<typeof coreModule>();
  return {
  ...actual,
  projectAuthService: { loadProjectRole },
  getStorageAdapter: async () => ({ keyFromUrl, publicUrl }),
  createQueue: () => ({ add: queueAdd }),
  defaultJobOpts: () => ({ attempts: 3 }),
  getMiniToolsConfig: () => ({ ...actual.getMiniToolsConfig(), poll_interval_ms: 5000 }),
  env: { INGEST_BASE_URL: 'https://ingest.example.test', INGEST_SHARED_SECRET: 'secret' },
};
});
vi.mock('@breatic/shared', async (original) => ({ ...await original<Record<string, unknown>>(), videoPresentationAtIngest }));
vi.mock('@domain/asset/asset.repo.js', () => ({ findLiveByStorageKey, findById }));

const canonicalURL = 'https://assets.example.test/video/canonical.webm';
const input = { projectId: '49646d44-2e1a-4184-b8bd-57cef3b9b47c', userId: '6061c056-f758-47c1-9527-8495ecba60e3', canonicalURL };
const asset: StudioAssetEntity = {
  id: '21de0c40-eb00-4bc0-ab81-d32f709b3b14', studioId: 'ed45d52f-1149-4058-8a94-c983a9ff32d9',
  contentHash: 'a'.repeat(64), storageKey: 'video/canonical.webm', fileUrl: canonicalURL, sizeBytes: 1024,
  mimeType: 'video/webm', kind: 'video', source: 'upload', producedByUserId: input.userId,
  generationTaskId: null, width: null, height: null, durationSeconds: null, createdAt: new Date('2026-10-24T00:00:00Z'), deletedAt: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  loadProjectRole.mockResolvedValue(null);
  keyFromUrl.mockReturnValue(asset.storageKey);
  publicUrl.mockReturnValue(canonicalURL);
  findLiveByStorageKey.mockResolvedValue(asset);
  findById.mockResolvedValue(asset);
  videoPresentationAtIngest.mockResolvedValue({ presentation: null, attempt: null });
  queueAdd.mockResolvedValue(undefined);
});

describe('registered presentation source authorization (inner#1306 §6.20)', () => {
  it('checks membership before consulting a source or presentation', async () => {
    await expect(resolveVideoPresentation(input)).rejects.toMatchObject({ statusCode: 404 });
    expect(loadProjectRole).toHaveBeenCalledWith(input.userId, input.projectId);
    expect(keyFromUrl).not.toHaveBeenCalled();
    expect(findLiveByStorageKey).not.toHaveBeenCalled();
  });

  it('checks membership before consulting an explicit repair source', async () => {
    await expect(repairVideoPresentation({ ...input, sourceFingerprint: asset.contentHash, requestId: 'repair-press' })).rejects.toMatchObject({ statusCode: 404 });
    expect(loadProjectRole).toHaveBeenCalledWith(input.userId, input.projectId);
    expect(findLiveByStorageKey).not.toHaveBeenCalled();
  });

  it.each([
    ['an external URL', null, asset],
    ['an unregistered address', asset.storageKey, null],
    ['a registered image', asset.storageKey, { ...asset, kind: 'image' }],
  ])('rejects %s instead of inferring a video from its extension', async (_name, key, row) => {
    loadProjectRole.mockResolvedValue('viewer');
    keyFromUrl.mockReturnValue(key);
    findLiveByStorageKey.mockResolvedValue(row);
    await expect(resolveVideoPresentation(input)).rejects.toMatchObject({ statusCode: 422 });
  });

  it('reports the current registry identity when repair fingerprint is stale', async () => {
    loadProjectRole.mockResolvedValue('viewer');
    await expect(repairVideoPresentation({ ...input, sourceFingerprint: 'b'.repeat(64), requestId: 'repair-press' }))
      .rejects.toMatchObject({ statusCode: 409, currentSourceBinding: {
        assetId: asset.id, contentHash: asset.contentHash, canonicalURL, kind: 'video',
        mediaInfo: { width: null, height: null, duration: null, mimeType: 'video/webm' },
      } });
  });

  it.each([null, { ...asset, deletedAt: new Date() }, { ...asset, kind: 'image' }])('does not queue automatic work for a gone or non-video row', async (row) => {
    findById.mockResolvedValue(row);
    expect(await ensureVideoPresentation({ assetId: asset.id })).toBe(null);
  });

  it('returns a viewer the registry SHA and canonical URL while measurements remain unknown', async () => {
    loadProjectRole.mockResolvedValue('viewer');
    const accepted = { jobId: 'accepted-first-read', deadlineAt: 1900000000000, status: 'accepted', usage: null };
    videoPresentationAtIngest.mockImplementation(async (_url: string, _secret: string, request: { action: string }) => ({
      presentation: null, attempt: request.action === 'read' ? null : accepted,
    }));
    expect(await resolveVideoPresentation(input)).toEqual({
      sourceBinding: { assetId: asset.id, contentHash: asset.contentHash, canonicalURL, kind: 'video', mediaInfo: {
        width: null, height: null, duration: null, mimeType: asset.mimeType,
      } }, presentation: null, preparation: { status: 'accepted', attempt: { jobId: accepted.jobId, deadlineAt: accepted.deadlineAt } }, pollAfterMs: 5000,
    });
    expect(queueAdd).toHaveBeenCalledWith('prepare', expect.objectContaining({
      assetId: asset.id, sourceFingerprint: asset.contentHash, jobId: accepted.jobId, deadlineAt: accepted.deadlineAt,
    }), expect.objectContaining({ jobId: accepted.jobId }));
  });

  it('inherits a parent deadline for a registered alpha result without a second budget', async () => {
    const deadlineAt = 1900000000000;
    videoPresentationAtIngest.mockResolvedValue({
      presentation: null, attempt: { jobId: 'parent-alpha', deadlineAt, status: 'accepted', usage: null },
    });
    expect(await ensureVideoPresentation({ assetId: asset.id, parentDeadlineAt: deadlineAt, knownAlpha: true }))
      .toEqual({ jobId: 'parent-alpha', deadlineAt });
    expect(videoPresentationAtIngest).toHaveBeenCalledWith('https://ingest.example.test', 'secret', expect.objectContaining({
      action: 'accept', storageKey: asset.storageKey, sourceFingerprint: asset.contentHash, deadlineAt, original: null, knownAlpha: true,
    }));
    expect(queueAdd).toHaveBeenCalledWith('prepare', expect.objectContaining({ deadlineAt }), expect.objectContaining({ jobId: 'parent-alpha' }));
  });

  it('replays the accepted attempt deadline instead of assigning a later retry deadline', async () => {
    const fixed = { jobId: 'fixed-accepted', deadlineAt: 1900000000000, status: 'running', usage: null };
    videoPresentationAtIngest.mockResolvedValue({ presentation: null, attempt: fixed });
    expect(await ensureVideoPresentation({ assetId: asset.id, parentDeadlineAt: 1900000001000 }))
      .toEqual({ jobId: fixed.jobId, deadlineAt: fixed.deadlineAt });
    expect(queueAdd).toHaveBeenCalledWith('prepare', expect.objectContaining({
      jobId: fixed.jobId, deadlineAt: fixed.deadlineAt,
    }), expect.objectContaining({ jobId: fixed.jobId }));
  });

  it('lets a viewer repair the same registered source and returns the persisted attempt', async () => {
    loadProjectRole.mockResolvedValue('viewer');
    const fixed = { jobId: 'repair-fixed', deadlineAt: 1900000000000, status: 'accepted', usage: null };
    videoPresentationAtIngest.mockResolvedValue({ presentation: null, attempt: fixed });
    expect(await repairVideoPresentation({ ...input, sourceFingerprint: asset.contentHash, requestId: 'repair-press' })).toEqual({
      sourceBinding: { assetId: asset.id, contentHash: asset.contentHash, canonicalURL, kind: 'video', mediaInfo: {
        width: null, height: null, duration: null, mimeType: asset.mimeType,
      } }, presentation: null, preparation: { status: 'accepted', attempt: { jobId: fixed.jobId, deadlineAt: fixed.deadlineAt } }, pollAfterMs: 5000, attempt: { jobId: fixed.jobId, deadlineAt: fixed.deadlineAt },
    });
    expect(videoPresentationAtIngest).toHaveBeenCalledWith('https://ingest.example.test', 'secret', expect.objectContaining({
      action: 'accept', repair: true, storageKey: asset.storageKey, sourceFingerprint: asset.contentHash,
    }));
  });
});
