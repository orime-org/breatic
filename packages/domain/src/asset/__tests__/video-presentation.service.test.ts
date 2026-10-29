// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as sharedModule from '@breatic/shared';
import { DeadlinePassed, VideoSourceLedgerReadRefused, videoSourceLedgerKeyFor, type StudioAssetEntity, type VideoSourceLedgerCompanion } from '@breatic/shared';
import { NotFoundError, ValidationError, getMiniToolsConfig } from '@breatic/core';
import type * as coreModule from '@breatic/core';
import { resolveVideoPresentation, repairVideoPresentation, ensureVideoPresentation, runVideoPresentation, readSourceLedger } from '../video-presentation.service.js';

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

describe('partial registered presentation measurements (inner#1306)', () => {
  it('retains a known width in internal admission while missing measurements stay null', async () => {
    findById.mockResolvedValue({ ...asset, width: 95 });
    const accepted = { jobId: 'partial-registered', deadlineAt: 1900000000000, status: 'accepted', usage: null };
    videoPresentationAtIngest.mockResolvedValue({ presentation: null, attempt: accepted });
    await ensureVideoPresentation({ assetId: asset.id });
    expect(videoPresentationAtIngest).toHaveBeenCalledWith(expect.any(String), expect.any(String), expect.objectContaining({
      action: 'accept', original: null, registeredMetadata: { width: 95, height: null, duration: null },
    }));
  });

  it('resolves a previously unknown source after registry precision projects its trusted duration', async () => {
    loadProjectRole.mockResolvedValue('viewer');
    findLiveByStorageKey.mockResolvedValue({ ...asset, width: 95, height: 63, durationSeconds: 1.323 });
    const presentation = { schemaVersion: 1, sourceFingerprint: asset.contentHash, original: { width: 95, height: 63, duration: 1.323333 },
      state: 'native', attempt: { jobId: 'unknown-first-probe', deadlineAt: 1900000000000 } };
    videoPresentationAtIngest.mockResolvedValue({ presentation, attempt: { ...presentation.attempt, status: 'completed', usage: null, usageRecorded: true } });
    expect(await resolveVideoPresentation(input)).toMatchObject({ presentation, sourceBinding: { mediaInfo: { width: 95, height: 63, duration: 1.323 } } });
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
      sourceLedgerReadLimits: { maxBytes: 16777216, maxPhysicalFrames: 100000, maxOccurrences: 100000 },
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
      sourceLedgerReadLimits: { maxBytes: 16777216, maxPhysicalFrames: 100000, maxOccurrences: 100000 },
    });
    expect(videoPresentationAtIngest).toHaveBeenCalledWith('https://ingest.example.test', 'secret', expect.objectContaining({
      action: 'accept', repair: true, storageKey: asset.storageKey, sourceFingerprint: asset.contentHash,
    }));
  });
});

// inner#1306 consumer oracle N01–N04: the presentation owner reads the stored
// source ledger for an authorized member, binding the receipt to the actual
// registered row before any external GET. The companion delivery itself is a
// controlled `fetch`; the shared reader, digest and strict parser are real.
describe('validated source ledger read (inner#1306 N01–N04)', () => {
  const companion: VideoSourceLedgerCompanion = JSON.parse('{"schemaVersion":1,"sourceFingerprint":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","producerVersion":1,"attempt":{"jobId":"accepted-source-attempt","deadlineAt":7201000},"strategy":"iso_unedited_rate_one","physical":{"streamIndex":1,"trackId":7,"sourceTimeBase":{"numerator":"1","denominator":"1000"},"frames":[{"rawDecodeOrdinal":0,"ptsTicks":"0"},{"rawDecodeOrdinal":1,"ptsTicks":"40"},{"rawDecodeOrdinal":2,"ptsTicks":"80"}]},"container":{"kind":"iso_bmff","movieTimescale":"1000","movieDurationTicks":"4000","track":{"trackId":7,"trackFlags":1,"durationMovieTicks":"4000","mediaTimescale":"1000","mediaDurationTicks":"1000000000","edits":null,"sampleTiming":{"decodeRuns":[{"sampleCount":1,"deltaTicks":"40"},{"sampleCount":1,"deltaTicks":"40"},{"sampleCount":1,"deltaTicks":"40"}],"cttsVersion":null,"compositionRuns":null,"compositionShift":null}}},"presentation":{"edits":[],"frames":[{"presentationOrdinal":0,"editOccurrence":0,"rawDecodeOrdinal":0,"sourcePtsTicks":"0","mappedPts":{"numerator":"0","denominator":"1"},"displayStart":{"numerator":"0","denominator":"1"},"displayEnd":{"numerator":"1","denominator":"25"}},{"presentationOrdinal":1,"editOccurrence":0,"rawDecodeOrdinal":1,"sourcePtsTicks":"40","mappedPts":{"numerator":"1","denominator":"25"},"displayStart":{"numerator":"1","denominator":"25"},"displayEnd":{"numerator":"2","denominator":"25"}},{"presentationOrdinal":2,"editOccurrence":0,"rawDecodeOrdinal":2,"sourcePtsTicks":"80","mappedPts":{"numerator":"2","denominator":"25"},"displayStart":{"numerator":"2","denominator":"25"},"displayEnd":{"numerator":"3","denominator":"25"}}]}}') as VideoSourceLedgerCompanion;
  const bytes = new TextEncoder().encode(JSON.stringify(companion));
  const ledgerURL = `https://assets.example.test/${asset.storageKey}.video-source-ledger.v1.json`;
  const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>();
  let receipt: Record<string, unknown>;

  /**
   * The ingest read answering with this ledger state.
   * @param sourceLedger - The state.
   */
  function stored(sourceLedger: unknown): void {
    videoPresentationAtIngest.mockResolvedValue({ presentation: null, attempt: null, sourceLedger });
  }

  /** Serve the stored bytes once. */
  function serve(body: Uint8Array = bytes): void {
    fetchMock.mockResolvedValueOnce(new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }));
  }

  beforeEach(async () => {
    publicUrl.mockImplementation((key: string) => `https://assets.example.test/${key}`);
    loadProjectRole.mockResolvedValue('viewer');
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    receipt = {
      schemaVersion: 1, sourceFingerprint: asset.contentHash, producerVersion: 1, strategy: companion.strategy, attempt: companion.attempt,
      url: ledgerURL, etag: '"opaque"', size: bytes.byteLength, sha256: Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join(''),
      contentType: 'application/json', physicalFrameCount: 3, occurrenceCount: 3,
    };
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('refuses a non-member before reading any source or companion (N01)', async () => {
    loadProjectRole.mockResolvedValue(null);
    await expect(readSourceLedger(input, Date.now() + 60_000)).rejects.toBeInstanceOf(NotFoundError);
    expect(findLiveByStorageKey).not.toHaveBeenCalled();
    expect(videoPresentationAtIngest).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('gives a viewer the registered binding and the whole validated ledger with unknown measurements (N02)', async () => {
    stored({ state: 'ready', receipt });
    serve();
    const got = await readSourceLedger(input, Date.now() + 60_000);
    expect(got.sourceBinding).toEqual(expect.objectContaining({ assetId: asset.id, contentHash: asset.contentHash, canonicalURL,
      mediaInfo: { width: null, height: null, duration: null, mimeType: asset.mimeType } }));
    expect(got.ledger).toEqual(companion);
    expect(fetchMock.mock.calls[0]![0]).toBe(ledgerURL);
    expect(videoPresentationAtIngest).toHaveBeenCalledTimes(1);
    expect(videoPresentationAtIngest).toHaveBeenCalledWith(expect.any(String), expect.any(String), {
      action: 'read', storageKey: asset.storageKey, sourceFingerprint: asset.contentHash,
    });
  });

  it.each([
    ['a deleted row', { ...asset, deletedAt: new Date() }],
    ['a non-video row', { ...asset, kind: 'image' }],
  ])('refuses %s before any companion GET (N03)', async (_name, row) => {
    findLiveByStorageKey.mockResolvedValue(row);
    stored({ state: 'ready', receipt });
    await expect(readSourceLedger(input, Date.now() + 60_000)).rejects.toBeInstanceOf(ValidationError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['another source hash', { sourceFingerprint: 'c'.repeat(64) }],
    ['a URL not derived from the registered key', { url: 'https://assets.example.test/other.video-source-ledger.v1.json' }],
  ])('refuses a receipt carrying %s before any companion GET (N03)', async (_name, foreign) => {
    stored({ state: 'ready', receipt: { ...receipt, ...foreign } });
    await expect(readSourceLedger(input, Date.now() + 60_000)).rejects.toBeInstanceOf(VideoSourceLedgerReadRefused);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['no ledger state', undefined],
    ['a null ledger', null],
    ['a pending ledger', { state: 'pending', schemaVersion: 1, sourceFingerprint: asset.contentHash, producerVersion: 1, attempt: companion.attempt }],
  ])('refuses %s without a GET or new work (N03, N04)', async (_name, sourceLedger) => {
    stored(sourceLedger);
    await expect(readSourceLedger(input, Date.now() + 60_000)).rejects.toBeInstanceOf(VideoSourceLedgerReadRefused);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(queueAdd).not.toHaveBeenCalled();
  });

  it('returns no ledger for a ready receipt whose body is malformed, and admits no work (N04)', async () => {
    stored({ state: 'ready', receipt });
    const damaged = bytes.slice();
    damaged[damaged.length - 1] = 0x20;
    serve(damaged);
    await expect(readSourceLedger(input, Date.now() + 60_000)).rejects.toBeInstanceOf(VideoSourceLedgerReadRefused);
    expect(videoPresentationAtIngest).toHaveBeenCalledTimes(1);
    expect(queueAdd).not.toHaveBeenCalled();
    expect(createUsageRecorder).not.toHaveBeenCalled();
  });

  it("reads under the caller's own deadline and does not GET once it has passed (C13)", async () => {
    stored({ state: 'ready', receipt });
    await expect(readSourceLedger(input, Date.now() - 1)).rejects.toBeInstanceOf(DeadlinePassed);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('projects the ledger state and the current read policy on the presentation response', async () => {
    stored({ state: 'ready', receipt });
    const got = await resolveVideoPresentation(input);
    expect(got.sourceLedger).toEqual({ state: 'ready', receipt });
    expect(got.sourceLedgerReadLimits).toEqual({ maxBytes: 16777216, maxPhysicalFrames: 100000, maxOccurrences: 100000 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps an older ingest answer without ledger state unknown on the response', async () => {
    stored(undefined);
    videoPresentationAtIngest.mockResolvedValue({ presentation: null, attempt: { jobId: 'a', deadlineAt: 1900000000000, status: 'running', usage: null } });
    const got = await resolveVideoPresentation(input);
    expect('sourceLedger' in got).toBe(false);
  });
});

// inner#1306 test plan §77 (D cases): every presentation admission requests the
// source ledger v2 again, with its budgets from configuration and no frame
// ceiling, and the public addresses of both stored objects derived from the
// registered key. A finished source with no ledger is admitted once more; the
// ingest store decides whether that is a ledger-only attempt.
describe('presentation admission requesting the source ledger v2 (inner#1306 §77)', () => {
  const presentation = { schemaVersion: 1 as const, sourceFingerprint: asset.contentHash, original: { width: 48, height: 64, duration: 2 },
    state: 'native' as const, attempt: { jobId: 'old', deadlineAt: 1900000000000 } };
  const completed = { jobId: 'old', deadlineAt: 1900000000000, status: 'completed' as const, usage: null, usageRecorded: true };
  const identity = { schemaVersion: 2, sourceFingerprint: asset.contentHash, producerVersion: 2, attempt: { jobId: 'old', deadlineAt: 1900000000000 } };
  const ledgerOnly = { presentation, attempt: { jobId: 'ledger-only', deadlineAt: 1900000000000, status: 'accepted', usage: null },
    sourceLedger: { state: 'pending', ...identity, attempt: { jobId: 'ledger-only', deadlineAt: 1900000000000 } } };

  /**
   * The registered key of the compact presentation table, read at call time so a missing export fails one case.
   * @param key - Registered storage key.
   * @returns The table key.
   */
  function tableKeyFor(key: string): string {
    const derive = (sharedModule as Record<string, unknown>).videoSourceLedgerTableKeyFor;
    expect(typeof derive).toBe('function');
    return (derive as (value: string) => string)(key);
  }

  /**
   * Answer an ingest read with this finished source and an accept with a ledger-only attempt.
   * @param read - The snapshot a read answers.
   */
  function ingestAnswers(read: Record<string, unknown>): void {
    videoPresentationAtIngest.mockImplementation(async (_url: string, _secret: string, request: { action: string }) => request.action === 'read' ? read : ledgerOnly);
  }

  beforeEach(() => {
    loadProjectRole.mockResolvedValue('viewer');
    publicUrl.mockImplementation((key: string) => `https://assets.example.test/${key}`);
  });

  it('D01 requests the ledger with its six configured budgets, no frame ceiling and both URLs derived from the registered key', async () => {
    videoPresentationAtIngest.mockResolvedValue({ presentation: null, attempt: { jobId: 'new', deadlineAt: 1900000000000, status: 'accepted', usage: null } });
    await ensureVideoPresentation({ assetId: asset.id });
    const settings = getMiniToolsConfig().presentation;
    const ledger = settings.source_ledger;
    const request = videoPresentationAtIngest.mock.calls[0]![2] as { action: string; limits: Record<string, unknown>; sourceLedgerURL?: string; sourceLedgerTableURL?: string };
    expect(request.action).toBe('accept');
    expect(request.limits.maxSourceBytes).toBe(settings.max_source_bytes);
    expect(request.limits.sourceLedger).toEqual({
      maxBytes: ledger.max_bytes, probeStdoutBytes: ledger.probe_stdout_bytes, metadataBytes: ledger.metadata_bytes,
      isoBoxCount: ledger.iso_box_count, matroskaElementCount: ledger.matroska_element_count, matroskaMaxBlocks: ledger.matroska_max_blocks,
    });
    expect(request.sourceLedgerURL).toBe(`https://assets.example.test/${videoSourceLedgerKeyFor(asset.storageKey)}`);
    expect(request.sourceLedgerTableURL).toBe(`https://assets.example.test/${tableKeyFor(asset.storageKey)}`);
  });

  it.each([
    ['no ledger state', undefined],
    ['a null ledger', null],
  ])('D02 admits a finished, already ready source with %s once more on read', async (_name, sourceLedger) => {
    ingestAnswers({ presentation, attempt: completed, ...(sourceLedger === undefined ? {} : { sourceLedger }) });
    const got = await resolveVideoPresentation(input);
    expect(videoPresentationAtIngest).toHaveBeenCalledWith(expect.any(String), expect.any(String), expect.objectContaining({ action: 'accept' }));
    expect(got.sourceLedger).toEqual(ledgerOnly.sourceLedger);
    expect(got.presentation).toEqual(presentation);
  });

  it.each([
    ['pending', { state: 'pending', ...identity }],
    ['ready', { state: 'ready', receipt: { ...identity, url: `https://assets.example.test/${asset.storageKey}.ledger.json`, etag: '"e"', size: 912,
      sha256: 'b'.repeat(64), contentType: 'application/json', table: { url: `https://assets.example.test/${asset.storageKey}.table.json`, sha256: 'c'.repeat(64), size: 81, frameCount: 17 } } }],
    ['content-failed', { state: 'failed', ...identity, errorCode: 'unsupported_rate' }],
  ])('D03 leaves a finished source with a %s ledger as it is and projects that state', async (_name, sourceLedger) => {
    ingestAnswers({ presentation, attempt: completed, sourceLedger });
    const got = await resolveVideoPresentation(input);
    expect(got.sourceLedger).toEqual(sourceLedger);
    expect(videoPresentationAtIngest).toHaveBeenCalledTimes(1);
    expect(queueAdd).not.toHaveBeenCalled();
  });

  it('D04 does not admit again while the original work is still running', async () => {
    videoPresentationAtIngest.mockResolvedValue({ presentation: null, attempt: { jobId: 'run', deadlineAt: 1900000000000, status: 'running', usage: null } });
    await resolveVideoPresentation(input);
    expect(videoPresentationAtIngest).toHaveBeenCalledTimes(1);
    expect(queueAdd).toHaveBeenCalledTimes(1);
  });

  it.todo('D05 a read of a finished source whose ledger failed transiently: design §2 says the next admission re-produces it and §10.2 shows the panel a retry button, but leaves open whether an ordinary read admits by itself or only the retry does');
  it.todo('D06 the retry (E7) entry point: design §10.2 says retry and admission share one admission entry, but names no server route or domain function for the panel retry');
});
