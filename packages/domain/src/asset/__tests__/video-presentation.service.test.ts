// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Domain presentation admission and the web→server response (inner#1306 test
 * plan §90 E1; frames-split design §5.1 steps 1 and 6, §3.5, §7.12, §7.6).
 *
 * The domain sends the S6c ingest request (both container prices frozen
 * together, the target policy version on every read and accept, the retry caps
 * from configuration), consumes the S6c snapshot and answers the response that
 * mirrors it. A user-run prep inherits that run's deadline; a standalone read or
 * repair fixes its own two hours. S6e E2 (§90 E2-1, E2-9): the accept also
 * freezes the encoding parameters; the queue carries only the job identity, D
 * lives in the DO admission record, and the staged job with its usage recording
 * is the worker's (`packages/worker/src/handlers/__tests__/video-presentation.test.ts`).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type StudioAssetEntity } from '@breatic/shared';
import { budgetDeadlineFrom, getMiniToolsConfig } from '@breatic/core';
import type * as coreModule from '@breatic/core';
import { resolveVideoPresentation, repairVideoPresentation, ensureVideoPresentation } from '../video-presentation.service.js';
import { videoEncoderRates } from '../video-encoder-rates.js';

const { loadProjectRole, findLiveByStorageKey, findById, keyFromUrl, publicUrl } = vi.hoisted(() => ({
  loadProjectRole: vi.fn(), findLiveByStorageKey: vi.fn(), findById: vi.fn(), keyFromUrl: vi.fn(), publicUrl: vi.fn(),
}));
const { videoPresentationAtIngest, queueAdd, fillMediaNumbers, createUsageRecorder, recordServiceCall, settle, selectPin } = vi.hoisted(() => ({
  videoPresentationAtIngest: vi.fn(), queueAdd: vi.fn(), fillMediaNumbers: vi.fn(), createUsageRecorder: vi.fn(), recordServiceCall: vi.fn(), settle: vi.fn(), selectPin: vi.fn(),
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
vi.mock('@domain/presentation/presentation-pin.service.js', async (original) => ({ ...await original<Record<string, unknown>>(), select: selectPin }));
vi.mock('@domain/credit/usage-recorder.js', async (original) => ({ ...await original<Record<string, unknown>>(), createUsageRecorder }));

const canonicalURL = 'https://assets.example.test/video/canonical.webm';
const input = { projectId: '49646d44-2e1a-4184-b8bd-57cef3b9b47c', userId: '6061c056-f758-47c1-9527-8495ecba60e3', canonicalURL };
const H = 'a'.repeat(64);
const T = 'c'.repeat(64);
const PLAN = 'd'.repeat(64);
const asset: StudioAssetEntity = {
  id: '21de0c40-eb00-4bc0-ab81-d32f709b3b14', studioId: 'ed45d52f-1149-4058-8a94-c983a9ff32d9',
  contentHash: H, storageKey: 'video/canonical.webm', fileUrl: canonicalURL, sizeBytes: 1024,
  mimeType: 'video/webm', kind: 'video', source: 'upload', producedByUserId: input.userId,
  generationTaskId: null, width: null, height: null, durationSeconds: null, createdAt: new Date('2026-10-24T00:00:00Z'), deletedAt: null,
};
const registered = { assetId: asset.id, contentHash: H, canonicalURL, kind: 'video', mediaInfo: { width: null, height: null, duration: null, mimeType: asset.mimeType } };
const ingestBinding = { storageKey: asset.storageKey, sourceFingerprint: H };
const bundle = {
  schemaVersion: 1, sourceFingerprint: H, versionId: 'e'.repeat(64), toolInputId: T, planSha256: PLAN, policyVersion: 1, producerVersion: 'd'.repeat(64), profileVersion: 'd'.repeat(64),
  original: { width: 64, height: 48, duration: 2.125 },
  display: { width: 64, height: 48, fps: { numerator: 8, denominator: 1 }, frameCount: 17, gridStart: { numerator: 0, denominator: 1 }, realFrameCount: 17, leadFrames: 0, holdFrames: 0 },
  plan: { gridRulesVersion: 1, grid: { fps: { numerator: 8, denominator: 1 }, gridStart: { numerator: 0, denominator: 1 }, leadFrames: 0, gridEnd: null, singleFrameDurationMs: 5000 },
    toolSource: 'original', audioTrack: null, display: { width: 64, height: 48 }, color: { matrix: 'bt709', toneMap: 'none' }, framePngBitDepth: 8 },
  playback: { kind: 'native', carrier: { storageKey: asset.storageKey, url: canonicalURL, etag: 'e1', size: 4096, sha256: 'f'.repeat(64), contentType: 'video/webm' }, displayRect: null },
  toolSource: { edit: null, keyframes: { earliestKeyframeTime: 0, maxKeyframeInterval: 1, allKeyframes: false }, sourceDecodeKey: 'sdr_8bit' },
};

interface Sent { action: string; jobId?: string; deadlineAt?: number; targetPolicyVersion?: number; repair?: boolean;
  pricing?: { basic: Record<string, unknown>; standard4: Record<string, unknown> }; policy?: { chunkRetries: number } }

/**
 * Every request the domain sent to ingest.
 * @returns The requests in order.
 */
function sent(): Sent[] {
  return videoPresentationAtIngest.mock.calls.map((call) => call[2] as Sent);
}

/**
 * The accept request the domain sent.
 * @returns It.
 */
function acceptSent(): Sent {
  const found = sent().find((request) => request.action === 'accept');
  expect(found).toBeDefined();
  return found!;
}

/**
 * A preparation in the snapshot shape for the job ingest accepted.
 * @param jobId - The accepted job.
 * @param stage - Its real stage, null before it starts.
 * @param failure - Its failure code.
 * @returns The preparation.
 */
function prep(jobId: string, stage: string | null = null, failure: string | null = null): Record<string, unknown> {
  return { targetPolicyVersion: 1, jobId, stage, failure };
}

/**
 * An S6c ingest snapshot.
 * @param fields - The fields that differ from nothing admitted.
 * @returns The snapshot.
 */
function snapshot(fields: Record<string, unknown> = {}): Record<string, unknown> {
  return { sourceBinding: ingestBinding, presentation: null, preparation: null, readmit: false, ...fields };
}

/**
 * Answer a read with one snapshot and an accept with the job the domain proposed, unless given.
 * @param read - The read answer.
 * @param accepted - The accept answer; defaults to the proposed job, not started.
 */
function ingest(read: Record<string, unknown>, accepted?: Record<string, unknown>): void {
  videoPresentationAtIngest.mockImplementation(async (_url: string, _secret: string, request: Sent) => request.action === 'accept'
    ? accepted ?? snapshot({ preparation: prep(request.jobId!) }) : read);
}

beforeEach(() => {
  vi.clearAllMocks();
  loadProjectRole.mockResolvedValue('viewer');
  keyFromUrl.mockReturnValue(asset.storageKey);
  publicUrl.mockImplementation((key: string) => `https://assets.example.test/${key}`);
  findLiveByStorageKey.mockResolvedValue(asset);
  findById.mockResolvedValue(asset);
  ingest(snapshot());
  queueAdd.mockResolvedValue(undefined);
  createUsageRecorder.mockReturnValue({ recordServiceCall, settle });
  settle.mockResolvedValue(0);
  selectPin.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('registered presentation source authorization (inner#1306 §3.5 web→server)', () => {
  it('AU01 checks membership before consulting a source or presentation', async () => {
    loadProjectRole.mockResolvedValue(null);
    await expect(resolveVideoPresentation(input)).rejects.toMatchObject({ statusCode: 404 });
    expect(loadProjectRole).toHaveBeenCalledWith(input.userId, input.projectId);
    expect(keyFromUrl).not.toHaveBeenCalled();
    expect(findLiveByStorageKey).not.toHaveBeenCalled();
  });

  it('AU02 checks membership before consulting an explicit repair source', async () => {
    loadProjectRole.mockResolvedValue(null);
    await expect(repairVideoPresentation({ ...input, sourceFingerprint: H, requestId: 'repair-press' })).rejects.toMatchObject({ statusCode: 404 });
    expect(findLiveByStorageKey).not.toHaveBeenCalled();
  });

  it.each([
    ['an external URL', null, asset],
    ['an unregistered address', asset.storageKey, null],
    ['a registered image', asset.storageKey, { ...asset, kind: 'image' }],
  ])('AU03 rejects %s instead of inferring a video from its extension', async (_name, key, row) => {
    keyFromUrl.mockReturnValue(key);
    findLiveByStorageKey.mockResolvedValue(row);
    await expect(resolveVideoPresentation(input)).rejects.toMatchObject({ statusCode: 422 });
  });

  it('AU04 reports the current registry identity when the repair fingerprint is stale', async () => {
    publicUrl.mockReturnValue(canonicalURL);
    await expect(repairVideoPresentation({ ...input, sourceFingerprint: 'b'.repeat(64), requestId: 'repair-press' }))
      .rejects.toMatchObject({ statusCode: 409, currentSourceBinding: registered });
  });

  it.each([null, { ...asset, deletedAt: new Date() }, { ...asset, kind: 'image' }])('AU05 does not admit automatic work for a gone or non-video row', async (row) => {
    findById.mockResolvedValue(row);
    expect(await ensureVideoPresentation({ assetId: asset.id })).toBe(null);
    expect(videoPresentationAtIngest).not.toHaveBeenCalled();
  });
});

describe('the S6c admission request (inner#1306 §3.5 server/worker→ingest, §5.1 step 1)', () => {
  it('A01 freezes the basic and the standard-4 prices together', async () => {
    await ensureVideoPresentation({ assetId: asset.id });
    const config = getMiniToolsConfig();
    const basicClass = config.presentation.container_class;
    const standard4Class = config.encoding.encoder.container_class;
    const size = (name: string): Record<string, number> => {
      const spec = config.classes[name]!;
      return { vcpu: spec.vcpu, memory_gib: spec.memory_gib, disk_gb: spec.disk_gb };
    };
    expect(acceptSent().pricing).toEqual({
      basic: { containerClass: basicClass, size: size(basicClass), prices: { ...config.prices } },
      standard4: { containerClass: standard4Class, size: size(standard4Class), prices: { ...config.prices } },
    });
  });

  it('A02 freezes the chunk retry cap from configuration', async () => {
    const core = await import('@breatic/core');
    const settings = getMiniToolsConfig();
    const spy = vi.spyOn(core, 'getMiniToolsConfig').mockReturnValue({ ...settings, encoding: { ...settings.encoding, chunk_retries: 5 } });
    try {
      await ensureVideoPresentation({ assetId: asset.id });
    } finally { spy.mockRestore(); }
    expect(acceptSent().policy).toEqual({ chunkRetries: 5 });
  });

  it('A03 sends the configured presentation.policy_version as the target on the read and on the accept it leads to', async () => {
    const core = await import('@breatic/core');
    const settings = getMiniToolsConfig();
    const spy = vi.spyOn(core, 'getMiniToolsConfig').mockReturnValue({ ...settings,
      presentation: { ...settings.presentation, policy_version: 7 } });
    try {
      await resolveVideoPresentation(input);
    } finally { spy.mockRestore(); }
    const [read, accept] = sent();
    expect(read).toMatchObject({ action: 'read', storageKey: asset.storageKey, sourceFingerprint: H, targetPolicyVersion: 7 });
    expect(accept).toMatchObject({ action: 'accept', targetPolicyVersion: 7 });
  });

  it('A05 freezes the encoding parameters from configuration on the accept (E2-1)', async () => {
    await ensureVideoPresentation({ assetId: asset.id });
    const config = getMiniToolsConfig();
    const encoder = config.encoding.encoder;
    // §93 D7-1 (design §5.4 上限行): the AAC rate of the dispatched copy's estimate is configured (audio seconds per second)
    // and frozen with the other encoder rates.
    const aacRate = (encoder as unknown as Record<string, unknown>).aac_encode_seconds_per_second;
    expect(aacRate, 'encoding.encoder.aac_encode_seconds_per_second is configured').toBeGreaterThan(0);
    expect((acceptSent() as unknown as Record<string, unknown>).encoding).toEqual({
      chunkShare: config.encoding.chunk_share, maxParallelChunks: config.encoding.max_parallel_chunks,
      // The rate table the estimate reads (frames-split §5.4 estimate row): source decode keys, edit tiers and the tone map.
      encoder: { ...videoEncoderRates(config), aacEncodeSecondsPerSecond: aacRate },
      edit: { crf: config.presentation.edit.crf, preset: config.presentation.edit.preset, proresProfile: config.presentation.edit.prores_profile,
        bytesPerPixel: config.presentation.edit.bytes_per_pixel, maxEditBytes: config.presentation.max_edit_bytes },
      carrier: { maxShortSide: config.presentation.carrier.max_short_side, color: config.presentation.carrier.color },
    });
  });

  it('A07 freezes the probe sample count, the single-frame duration and the rate cap from configuration on the accept (frames-split §5.1 step 2, §4.1)', async () => {
    const core = await import('@breatic/core');
    const settings = getMiniToolsConfig();
    const spy = vi.spyOn(core, 'getMiniToolsConfig').mockReturnValue({ ...settings,
      presentation: { ...settings.presentation, probe_sample_frames: 3, single_frame_duration_ms: 4000, max_fps: 120 } });
    try {
      await ensureVideoPresentation({ assetId: asset.id });
      expect((acceptSent() as unknown as Record<string, unknown>).probe).toEqual({ sampleFrames: 3, singleFrameDurationMs: 4000, maxFps: 120 });
    } finally { spy.mockRestore(); }
  });

  it('A06 sends the storage public base once and no per-object URL (inner 1c3a5892 §3.5 server/worker→ingest)', async () => {
    await ensureVideoPresentation({ assetId: asset.id });
    const accept = acceptSent() as unknown as Record<string, unknown>;
    const sourceURL = publicUrl(asset.storageKey) as string;
    expect(accept.publicBaseURL).toBe(sourceURL.slice(0, sourceURL.length - `/${asset.storageKey}`.length));
    for (const retired of ['packedURL', 'manifestURL', 'sourceLedgerURL', 'sourceLedgerTableURL']) expect(retired in accept).toBe(false);
  });

  it('A04 keeps the registered facts: unknown measurements stay null and a known width is retained', async () => {
    findById.mockResolvedValue({ ...asset, width: 95 });
    await ensureVideoPresentation({ assetId: asset.id });
    expect(acceptSent()).toMatchObject({ original: null, registeredMetadata: { width: 95, height: null, duration: null } });
  });
});

describe('deadlines fixed once at admission (inner#1306 §5.1 step 1)', () => {
  it('D01 a prep triggered inside a user run inherits that run\'s deadline; the queue carries only the job identity (E2-9)', async () => {
    const parent = 1900000000000;
    await ensureVideoPresentation({ assetId: asset.id, parentDeadlineAt: parent });
    const accept = acceptSent();
    expect(accept).toMatchObject({ deadlineAt: parent });
    expect(queueAdd).toHaveBeenCalledWith('prepare', { assetId: asset.id, sourceFingerprint: H, jobId: accept.jobId }, expect.objectContaining({ jobId: accept.jobId }));
  });

  it('D02 a standalone read admission fixes its own two hours', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-03T08:00:00Z'));
    await resolveVideoPresentation(input);
    expect(acceptSent().deadlineAt).toBe(budgetDeadlineFrom(Date.now()));
  });

  it('D03 a repair fixes its own two hours', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-03T08:00:00Z'));
    await repairVideoPresentation({ ...input, sourceFingerprint: H, requestId: 'repair-press' });
    expect(acceptSent()).toMatchObject({ repair: true, deadlineAt: budgetDeadlineFrom(Date.now()) });
  });
});

describe('read: admit once, otherwise answer the snapshot as it is (inner#1306 §5.1 step 1, §7.1, §7.12)', () => {
  it('R01 admits a source with nothing selected and no preparation, and answers the accepted work', async () => {
    const got = await resolveVideoPresentation(input);
    const accept = acceptSent();
    expect(accept.repair).not.toBe(true);
    expect(got).toEqual({ sourceBinding: registered, presentation: null, preparation: prep(accept.jobId!), pollAfterMs: 5000 });
    expect(queueAdd).toHaveBeenCalledWith('prepare', expect.objectContaining({ jobId: accept.jobId }), expect.objectContaining({ jobId: accept.jobId }));
  });

  it('R02 does not admit again while target work is in flight, and keeps it queued', async () => {
    ingest(snapshot({ preparation: prep('in-flight', 'encode') }));
    const got = await resolveVideoPresentation(input);
    expect(sent().map((request) => request.action)).toEqual(['read']);
    expect(got).toMatchObject({ preparation: prep('in-flight', 'encode'), pollAfterMs: 5000 });
    expect(queueAdd).toHaveBeenCalledWith('prepare', { assetId: asset.id, sourceFingerprint: H, jobId: 'in-flight' }, expect.objectContaining({ jobId: 'in-flight' }));
  });

  it('R03 a failed target preparation with nothing selected is answered as it is: no admission, no queue, no polling', async () => {
    ingest(snapshot({ preparation: prep('failed-job', 'plan', 'too_long') }));
    const got = await resolveVideoPresentation(input);
    expect(sent().map((request) => request.action)).toEqual(['read']);
    expect(queueAdd).not.toHaveBeenCalled();
    expect(got).toMatchObject({ presentation: null, preparation: prep('failed-job', 'plan', 'too_long'), pollAfterMs: null });
  });

  // frames-split §7.12: a selected version carries its grid, so it is answered as it is.
  it('R04 a selected version is answered as it is without admission', async () => {
    ingest(snapshot({ presentation: bundle }));
    const got = await resolveVideoPresentation(input);
    expect(sent().map((request) => request.action)).toEqual(['read']);
    expect(got.presentation).toEqual(bundle);
  });
});

// frames-split §7.15 pinned row and single-writer row: the discovery read is a write point of Mv, redone by versionId so that
// a selected pin row a stale worker sync left on another version follows the selected bundle P again.
describe('the discovery read keeps the selected pin on P (inner#1306 §7.15 Mv)', () => {
  it('SP01 a read that answers a selected version moves the selected pin onto it, with its objects', async () => {
    ingest(snapshot({ presentation: bundle }));
    await resolveVideoPresentation(input);
    expect(selectPin).toHaveBeenCalledWith({ canonicalKey: asset.storageKey, toolInputId: T, versionId: bundle.versionId, objectKeys: [bundle.playback.carrier.storageKey] });
  });

  it('SP02 a repair that answers a selected version moves the selected pin onto it', async () => {
    ingest(snapshot(), snapshot({ presentation: bundle, preparation: prep('repair-job', 'plan') }));
    await repairVideoPresentation({ ...input, sourceFingerprint: H, requestId: 'retry-press' });
    expect(selectPin).toHaveBeenCalledWith(expect.objectContaining({ canonicalKey: asset.storageKey, versionId: bundle.versionId }));
  });

  it('SP03 a read with nothing selected touches no pin', async () => {
    ingest(snapshot({ preparation: prep('in-flight', 'plan') }));
    await resolveVideoPresentation(input);
    expect(selectPin).not.toHaveBeenCalled();
  });
});

describe('the response mirrors the snapshot (inner#1306 §3.5 web→server, §5.1 step 6, §7.12)', () => {
  it('M01 maps every field with one name per concept and nothing else', async () => {
    ingest(snapshot({ presentation: bundle, preparation: prep('next-policy', 'encode') }));
    expect(await resolveVideoPresentation(input)).toEqual({
      sourceBinding: registered, presentation: bundle, preparation: prep('next-policy', 'encode'), pollAfterMs: null,
    });
  });

  it('M02 never exposes the internal ingest binding, an attempt, a manifest, the readmit flag or a frame table', async () => {
    ingest(snapshot({ presentation: bundle, readmit: true }));
    const got = await resolveVideoPresentation(input) as unknown as Record<string, unknown>;
    expect(got.sourceBinding).toEqual(registered);
    for (const key of ['attempt', 'manifest', 'readmit', 'ledger', 'sourceLedger', 'sourceLedgerReadLimits', 'usageFact']) expect(key in got).toBe(false);
  });

  it.each([
    ['a selected version', { presentation: bundle }, null],
    ['a selected version while new target work runs', { presentation: bundle, preparation: prep('next-policy', 'encode') }, null],
    ['nothing selected and target work in flight', { preparation: prep('in-flight', 'plan') }, 5000],
    ['nothing selected and the target work failed', { preparation: prep('failed-job', 'plan', 'classification_unknown') }, null],
  ])('M03 polls with the configured interval exactly when waiting: %s', async (_name, fields, pollAfterMs) => {
    ingest(snapshot(fields));
    expect((await resolveVideoPresentation(input)).pollAfterMs).toBe(pollAfterMs);
  });

});

describe('repair returns the same response (inner#1306 §3.5 web→server repair, §7.4 one admission entry)', () => {
  it('RP01 a viewer\'s repair is an accept with repair set; preparation.jobId names the accepted job and there is no attempt field', async () => {
    const got = await repairVideoPresentation({ ...input, sourceFingerprint: H, requestId: 'repair-press' });
    const accept = acceptSent();
    expect(accept).toMatchObject({ action: 'accept', repair: true, storageKey: asset.storageKey, sourceFingerprint: H });
    expect(got).toEqual({ sourceBinding: registered, presentation: null, preparation: prep(accept.jobId!), pollAfterMs: 5000 });
  });

  it('RP02 a repair of the selected version answers it with the new work and queues the job ingest accepted', async () => {
    ingest(snapshot(), snapshot({ presentation: bundle, preparation: prep('repair-job', 'plan') }));
    const got = await repairVideoPresentation({ ...input, sourceFingerprint: H, requestId: 'retry-press' });
    expect(got).toMatchObject({ presentation: bundle, preparation: prep('repair-job', 'plan'), pollAfterMs: null });
    expect(queueAdd).toHaveBeenCalledWith('prepare', expect.objectContaining({ jobId: 'repair-job' }), expect.objectContaining({ jobId: 'repair-job' }));
  });

  it('RP03 two concurrent repairs queue the one job ingest accepted, never their own proposed ids', async () => {
    const accepted = snapshot({ preparation: prep('repair-job', 'plan') });
    ingest(snapshot(), accepted);
    const [a, b] = await Promise.all([
      repairVideoPresentation({ ...input, sourceFingerprint: H, requestId: 'press-a' }),
      repairVideoPresentation({ ...input, sourceFingerprint: H, requestId: 'press-b' }),
    ]);
    expect(a.preparation).toEqual(b.preparation);
    expect(new Set(queueAdd.mock.calls.map(([, job]) => (job as { jobId: string }).jobId))).toEqual(new Set(['repair-job']));
  });

  it('RP04 the job id is derived from the press key on the server: queue-safe for any key, the same for the same press', async () => {
    await repairVideoPresentation({ ...input, sourceFingerprint: H, requestId: 'press:with:colons' });
    const first = acceptSent().jobId!;
    vi.clearAllMocks();
    await repairVideoPresentation({ ...input, sourceFingerprint: H, requestId: 'press:with:colons' });
    const replay = acceptSent().jobId!;
    vi.clearAllMocks();
    await repairVideoPresentation({ ...input, sourceFingerprint: H, requestId: 'another-press' });
    expect(first).toMatch(/^video-presentation-[0-9a-f]{32}$/);
    expect(replay).toBe(first);
    expect(acceptSent().jobId).not.toBe(first);
  });

  it('RP05 a queue refusal after ingest accepted the proposed job fails that candidate at ingest and rethrows', async () => {
    const refusal = new Error('queue refused');
    queueAdd.mockRejectedValue(refusal);
    await expect(repairVideoPresentation({ ...input, sourceFingerprint: H, requestId: 'repair-press' })).rejects.toBe(refusal);
    const accept = acceptSent();
    expect(sent().at(-1)).toEqual({ action: 'fail', storageKey: asset.storageKey, sourceFingerprint: H, jobId: accept.jobId, deadlineAt: accept.deadlineAt, code: 'presentation_failed' });
  });

  it('RP06 a queue refusal for a job ingest already held does not fail it', async () => {
    const refusal = new Error('queue refused');
    queueAdd.mockRejectedValue(refusal);
    ingest(snapshot(), snapshot({ preparation: prep('repair-job', 'plan') }));
    await expect(repairVideoPresentation({ ...input, sourceFingerprint: H, requestId: 'repair-press' })).rejects.toBe(refusal);
    expect(sent().map((request) => request.action)).toEqual(['accept']);
  });
});

describe('queueing and recovery after admission (inner#1306 §5.1 step 1, §7.1.1 recovery waits for usage)', () => {
  it('Q01 a failed preparation whose usage is not yet recorded is queued for recovery', async () => {
    ingest(snapshot({ preparation: prep('failed-job', 'plan', 'classification_unknown'), usageFact: {
      jobId: 'failed-job', actorUserId: input.userId, projectId: null, usage: { wallMs: 1, cpuUsec: null },
      pricing: { containerClass: 'MediaContainer', size: { vcpu: 0.25, memory_gib: 1, disk_gb: 4 }, prices: { vcpu_second_usd: 0, memory_gib_second_usd: 0, disk_gb_second_usd: 0 } } } }));
    await resolveVideoPresentation(input);
    expect(queueAdd).toHaveBeenCalledWith('prepare', expect.objectContaining({ jobId: 'failed-job' }), expect.objectContaining({ jobId: 'failed-job' }));
  });

  it('Q02 a failed preparation with a sub-job attempt\'s measured usage not yet recorded is queued for recovery', async () => {
    ingest(snapshot({ preparation: prep('failed-job', 'encode', 'expired'), attemptUsageOutstanding: true }));
    await resolveVideoPresentation(input);
    expect(queueAdd).toHaveBeenCalledWith('prepare', expect.objectContaining({ jobId: 'failed-job' }), expect.objectContaining({ jobId: 'failed-job' }));
  });
});

// §93 D6 (frames-split design §3.5 web→server and server/worker→ingest rows, §7.2 invalid×New): a discovery read admits on its
// own only under a condition the DO re-checks: `expect: 'first'` when nothing is selected and nothing is being prepared,
// `expect: 'readmit'` when nothing is selected and the snapshot's `readmit` is true. A user repair carries no `expect`.
describe('conditional admissions from the discovery read (§93 D6; design §3.5)', () => {
  it('DE01 nothing selected and nothing prepared: the read admits with expect first', async () => {
    ingest(snapshot());
    await resolveVideoPresentation(input);
    expect(acceptSent()).toMatchObject({ expect: 'first' });
  });

  it('DE02 nothing selected and readmit true: the read admits with expect readmit', async () => {
    ingest(snapshot({ preparation: prep('video-presentation-a', 'publish'), readmit: true }));
    await resolveVideoPresentation(input);
    expect(acceptSent()).toMatchObject({ expect: 'readmit' });
  });

  it('DE03 nothing selected, a preparation present and readmit false: the read admits nothing', async () => {
    ingest(snapshot({ preparation: prep('video-presentation-a', 'publish', 'presentation_invalid'), readmit: false }));
    await resolveVideoPresentation(input);
    expect(sent().map((request) => request.action)).toEqual(['read']);
  });

  it('DE04 a user repair admits without expect', async () => {
    ingest(snapshot());
    await repairVideoPresentation({ ...input, sourceFingerprint: H, requestId: 'repair-press' });
    expect(acceptSent()).not.toHaveProperty('expect');
  });

  it('DE05 a registration-time initialization admits without expect', async () => {
    await ensureVideoPresentation({ assetId: asset.id });
    expect(acceptSent()).not.toHaveProperty('expect');
  });
});

// §93 D6-3 (frames-split design §3.5 web→server row 「去重胜出者…按与发现读取相同的两条规则发带expect的受理」): a dedup winner
// reads the snapshot first and admits only under the first or readmit condition; a new upload's initialization admits as before.
// The flag is `conditional` (§94, procedure 3.1.6: named for what it does), since a replayed upload terminal takes the same path.
describe('the conditional admission of a dedup winner or a replayed terminal (§93 D6-3; design §3.5)', () => {
  type Ensure = (input: { assetId: string; conditional?: boolean }) => Promise<unknown>;
  const ensure = ensureVideoPresentation as unknown as Ensure;

  it('DW01 nothing selected and nothing prepared: read, then admit with expect first', async () => {
    ingest(snapshot());
    await ensure({ assetId: asset.id, conditional: true });
    expect(sent().map((request) => request.action)).toEqual(['read', 'accept']);
    expect(acceptSent()).toMatchObject({ expect: 'first' });
  });

  it('DW02 nothing selected and readmit true: read, then admit with expect readmit', async () => {
    ingest(snapshot({ preparation: prep('video-presentation-a', 'publish'), readmit: true }));
    await ensure({ assetId: asset.id, conditional: true });
    expect(sent().map((request) => request.action)).toEqual(['read', 'accept']);
    expect(acceptSent()).toMatchObject({ expect: 'readmit' });
  });

  it.each([
    ['a selected version', { presentation: bundle }],
    ['a preparation in progress', { preparation: prep('video-presentation-a', 'encode'), readmit: false }],
  ])('DW03 %s: the winner reads and admits nothing', async (_name, fields) => {
    ingest(snapshot(fields));
    await ensure({ assetId: asset.id, conditional: true });
    expect(sent().map((request) => request.action)).toEqual(['read']);
  });

  it('DW04 without the flag (a new upload) the initialization admits at once, without expect', async () => {
    await ensure({ assetId: asset.id });
    expect(sent().map((request) => request.action)).toEqual(['accept']);
    expect(acceptSent()).not.toHaveProperty('expect');
  });
});
