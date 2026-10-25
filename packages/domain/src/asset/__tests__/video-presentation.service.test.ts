// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StudioAssetEntity } from '@breatic/shared';
import type * as coreModule from '@breatic/core';
import { resolveVideoPresentation, repairVideoPresentation, ensureVideoPresentation, runVideoPresentation } from '../video-presentation.service.js';

const { loadProjectRole, findLiveByStorageKey, findById, keyFromUrl, publicUrl } = vi.hoisted(() => ({
  loadProjectRole: vi.fn(), findLiveByStorageKey: vi.fn(), findById: vi.fn(), keyFromUrl: vi.fn(), publicUrl: vi.fn(),
}));
const { videoPresentationAtIngest, queueAdd, fillMediaNumbers, createUsageRecorder, recordServiceCall, settle } = vi.hoisted(() => ({
  videoPresentationAtIngest: vi.fn(), queueAdd: vi.fn(), fillMediaNumbers: vi.fn(), createUsageRecorder: vi.fn(), recordServiceCall: vi.fn(), settle: vi.fn(),
}));
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
vi.mock('@domain/asset/asset.repo.js', async (original) => ({ ...await original<Record<string, unknown>>(), findLiveByStorageKey, findById, fillMediaNumbers }));
vi.mock('@domain/credit/usage-recorder.js', async (original) => ({ ...await original<Record<string, unknown>>(), createUsageRecorder }));

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
  createUsageRecorder.mockReturnValue({ recordServiceCall, settle });
  settle.mockResolvedValue(0);
});

describe('platform presentation queue consumption (inner#1306 §6.20)', () => {
  const job = { assetId: asset.id, sourceFingerprint: asset.contentHash, jobId: 'accepted-native', deadlineAt: 1900000000000 };
  const presentation = { schemaVersion: 1 as const, sourceFingerprint: asset.contentHash, original: { width: 48, height: 64, duration: 2 },
    state: 'native' as const, attempt: { jobId: job.jobId, deadlineAt: job.deadlineAt } };
  const attempt = { jobId: job.jobId, deadlineAt: job.deadlineAt, status: 'completed' as const, usage: { wallMs: 1000, cpuUsec: 10000 } };

  it('runs only the fixed accepted identity and fills unknown registry measurements from trusted display geometry', async () => {
    videoPresentationAtIngest.mockResolvedValue({ presentation, attempt: { ...attempt, usageRecorded: true } });
    expect(await runVideoPresentation(job)).toEqual({ status: 'ready', usageRecorded: true, usagePending: false });
    expect(videoPresentationAtIngest).toHaveBeenCalledWith(expect.any(String), expect.any(String), {
      action: 'run', storageKey: asset.storageKey, sourceFingerprint: asset.contentHash, jobId: job.jobId, deadlineAt: job.deadlineAt,
    });
    expect(fillMediaNumbers).toHaveBeenCalledWith(asset.id, { width: 48, height: 64, durationSeconds: 2 });
    expect(createUsageRecorder).not.toHaveBeenCalled();
  });

  it('records measured container expense once under the original platform-funded actor before acknowledging it', async () => {
    videoPresentationAtIngest.mockResolvedValue({ presentation, attempt, usageFact: { jobId: job.jobId, actorUserId: input.userId,
      projectId: null, usage: attempt.usage, pricing: { containerClass: 'MediaContainer', size: { vcpu: 0.25, memory_gib: 1, disk_gb: 4 },
        prices: { vcpu_second_usd: 0.00001, memory_gib_second_usd: 0.00001, disk_gb_second_usd: 0.00001 } } } });
    expect(await runVideoPresentation(job)).toEqual({ status: 'ready', usageRecorded: true, usagePending: false });
    expect(createUsageRecorder).toHaveBeenCalledWith(expect.objectContaining({ operationKey: `video-presentation:${job.jobId}`,
      feature: 'mini_tool', actorUserId: input.userId, projectId: null, multiplier: 0 }));
    expect(recordServiceCall).toHaveBeenCalledWith(expect.objectContaining({ source: 'container', service: 'video-presentation', provider: 'cloudflare', costUsd: expect.any(Number), costSource: 'computed' }));
    expect(settle.mock.invocationCallOrder[0]).toBeLessThan(videoPresentationAtIngest.mock.invocationCallOrder[1]!);
    expect(videoPresentationAtIngest).toHaveBeenLastCalledWith(expect.any(String), expect.any(String), expect.objectContaining({ action: 'ack_usage', jobId: job.jobId, deadlineAt: job.deadlineAt }));
  });

  it('retains ready content while an unreceived expense fact requires queue recovery', async () => {
    videoPresentationAtIngest.mockResolvedValue({ presentation, attempt: { ...attempt, usage: null } });
    expect(await runVideoPresentation(job)).toEqual({ status: 'ready', usageRecorded: false, usagePending: true });
    expect(createUsageRecorder).not.toHaveBeenCalled();
  });

  it('expires an elapsed original deadline instead of starting fresh compute', async () => {
    videoPresentationAtIngest.mockResolvedValue({ presentation: null, attempt: { ...attempt, deadlineAt: 1, status: 'failed', error: 'expired' } });
    await runVideoPresentation({ ...job, deadlineAt: 1 });
    expect(videoPresentationAtIngest).toHaveBeenCalledWith(expect.any(String), expect.any(String), expect.objectContaining({ action: 'expire', deadlineAt: 1 }));
  });

  it('does not execute a stale source hash', async () => {
    expect(await runVideoPresentation({ ...job, sourceFingerprint: 'b'.repeat(64) })).toEqual({ status: 'stale', usageRecorded: false, usagePending: false });
    expect(videoPresentationAtIngest).not.toHaveBeenCalled();
  });
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
