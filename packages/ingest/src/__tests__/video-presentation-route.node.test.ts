// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The backend presentation boundary hands the store the whole admission the
 * backend sent, including the source ledger v2 request (inner#1306 test plan
 * §77, I01). The Durable Object and bucket are stand-ins; what is under test is
 * the mapping from the validated body to the admission.
 */

import { describe, expect, it, vi } from 'vitest';

import { videoPresentationRoute, type VideoPresentationEnv } from '@ingest/video-presentation-route.js';

const ledgerLimits = { maxBytes: 16777216, probeStdoutBytes: 67108864, metadataBytes: 16777216, isoBoxCount: 100000, matroskaElementCount: 1000000, matroskaMaxBlocks: 250000 };
const accept = {
  action: 'accept', storageKey: 'video/canonical.webm', sourceFingerprint: 'a'.repeat(64), jobId: 'video-presentation-a', deadlineAt: 1900000000000,
  original: null, contentType: 'video/webm',
  limits: { maxSourceBytes: 1, maxPackedBytes: 1, crf: 18, preset: 'medium', probeStdoutBytes: 1, analysisStdoutBytes: 1, stderrTailBytes: 1, sourceLedger: ledgerLimits },
  // S6c (design §3.5, §5.1): both prices frozen at admission, the target policy and the frozen retry caps.
  pricing: {
    basic: { containerClass: 'MediaContainer', size: { vcpu: 0.25, memory_gib: 1, disk_gb: 4 }, prices: { vcpu_second_usd: 0, memory_gib_second_usd: 0, disk_gb_second_usd: 0 } },
    standard4: { containerClass: 'MiniToolContainerStd4', size: { vcpu: 4, memory_gib: 12, disk_gb: 20 }, prices: { vcpu_second_usd: 0, memory_gib_second_usd: 0, disk_gb_second_usd: 0 } },
  },
  targetPolicyVersion: 1, policy: { chunkRetries: 3, maxAutoRepairs: 3 },
  // S6d D1 (§91 D-6): the probe's sample count and the plan's single-frame duration are frozen at admission.
  probe: { sampleFrames: 1, singleFrameDurationMs: 5000, identityFormats: [{ container: 'mp4', videoCodec: 'h264', profiles: ['Constrained Baseline', 'Baseline', 'Main', 'High'], pixFmt: 'yuv420p', bitDepth: 8, audioCodecs: ['aac', 'none'], rotation: 0, sar: '1:1', matrixTagged: true }] },
  // S6e E2-1: the encoding parameters are frozen at admission.
  encoding: {
    chunkShare: 0.5, maxParallelChunks: 8,
    encoder: { startSeconds: 3, encodePixelsPerSecond: 248000000, decodeConvertPixelsPerSecond: { sdr_8bit: 2200000000, sdr_10bit: 1310000000, sdr_12bit: 816000000, hdr_8bit: 106000000, hdr_10bit: 102000000, hdr_12bit: 109000000, sdr_16bit: 294000000, hdr_16bit: 71900000 }, aacEncodeSecondsPerSecond: 100 },
    copyDiskMarginBytes: 33554432, carrier: { maxShortSide: 1080, color: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', range: 'tv' } },
  },
  actorUserId: '6061c056-f758-47c1-9527-8495ecba60e3', projectId: null,
  // S6e (inner 1c3a5892): one frozen public base replaces the per-object URLs.
  publicBaseURL: 'https://assets.example.test',
};

describe('presentation admission at the ingest boundary (inner#1306 §77)', () => {
  it('I01 passes the ledger budgets and the public base through to the store', async () => {
    const acceptPresentation = vi.fn(async () => ({ presentation: null, attempt: null }));
    const env = {
      INGEST_SHARED_SECRET: 'secret',
      BUCKET: { head: async () => ({ etag: 'e' }) },
      MEDIA: { idFromName: (name: string) => name, get: () => ({ acceptPresentation }) },
    } as unknown as VideoPresentationEnv;
    const response = await videoPresentationRoute(new Request('https://ingest.example.test/video-presentation', {
      method: 'POST', headers: { 'x-ingest-secret': 'secret', 'content-type': 'application/json' }, body: JSON.stringify(accept),
    }), env);
    expect(response.status).toBe(200);
    expect(acceptPresentation).toHaveBeenCalledWith(expect.objectContaining({
      limits: expect.objectContaining({ sourceLedger: ledgerLimits }),
      publicBaseURL: accept.publicBaseURL,
    }));
  });

  it('I02 passes both frozen prices, the target policy version and the retry caps through to the store (S6c, §3.5, §5.1)', async () => {
    const acceptPresentation = vi.fn(async () => ({ presentation: null, attempt: null }));
    const env = {
      INGEST_SHARED_SECRET: 'secret',
      BUCKET: { head: async () => ({ etag: 'e' }) },
      MEDIA: { idFromName: (name: string) => name, get: () => ({ acceptPresentation }) },
    } as unknown as VideoPresentationEnv;
    await videoPresentationRoute(new Request('https://ingest.example.test/video-presentation', {
      method: 'POST', headers: { 'x-ingest-secret': 'secret', 'content-type': 'application/json' }, body: JSON.stringify(accept),
    }), env);
    expect(acceptPresentation).toHaveBeenCalledWith(expect.objectContaining({
      pricing: accept.pricing, targetPolicyVersion: 1, policy: { chunkRetries: 3, maxAutoRepairs: 3 },
      probe: { sampleFrames: 1, singleFrameDurationMs: 5000, identityFormats: [{ container: 'mp4', videoCodec: 'h264', profiles: ['Constrained Baseline', 'Baseline', 'Main', 'High'], pixFmt: 'yuv420p', bitDepth: 8, audioCodecs: ['aac', 'none'], rotation: 0, sar: '1:1', matrixTagged: true }] },
    }));
  });
});

/**
 * Post one request to the route with a stand-in DO exposing the given RPCs.
 * @param body - The request.
 * @param rpc - The DO methods.
 * @returns The response.
 */
async function route(body: Record<string, unknown>, rpc: Record<string, unknown>): Promise<Response> {
  const env = {
    INGEST_SHARED_SECRET: 'secret', BUCKET: { head: async () => ({ etag: 'e' }) },
    MEDIA: { idFromName: (name: string) => name, get: () => rpc },
  } as unknown as VideoPresentationEnv;
  return videoPresentationRoute(new Request('https://ingest.example.test/video-presentation', {
    method: 'POST', headers: { 'x-ingest-secret': 'secret', 'content-type': 'application/json' }, body: JSON.stringify(body),
  }), env);
}

// inner#1306 test plan §90 E2 (interface choices E2-3, E2-4): one route, one DO RPC per action; prepare replaces run and
// fail absorbs expire. The follow-up actions carry the capability: identity, D and the token prepare granted.
describe('staged presentation actions at the ingest boundary (inner#1306 §90 E2-3, E2-4)', () => {
  const identity = { storageKey: accept.storageKey, sourceFingerprint: accept.sourceFingerprint, jobId: accept.jobId };
  const capability = { ...identity, deadlineAt: accept.deadlineAt, token: 'token-a' };
  const view = { candidate: { jobId: null }, presentation: null, targetPolicyVersion: null, ledgers: {} };

  it('RA01 prepare hands the job identity to preparePresentation and answers its result as it is', async () => {
    const answer = { prepared: true };
    const preparePresentation = vi.fn(async () => answer);
    const response = await route({ action: 'prepare', ...identity }, { preparePresentation });
    expect(response.status).toBe(200);
    expect(preparePresentation).toHaveBeenCalledWith(identity);
    expect(await response.json()).toEqual(answer);
  });

  it.each([
    ['advance_stage', 'advancePresentationStage', { stage: 'encode' }, ['encode']],
    ['report_chunk', 'reportPresentationChunk', { unit: { kind: 'presentation-chunk', chunk: 1 }, report: { kind: 'Rec', attempt: 2 } },
      [{ kind: 'presentation-chunk', chunk: 1 }, { kind: 'Rec', attempt: 2 }]],
  ] as const)('RA02 %s calls %s with the capability and answers whether it was accepted', async (action, method, fields, args) => {
    const rpc = vi.fn(async () => false);
    const response = await route({ action, ...capability, ...fields }, { [method]: rpc });
    expect(response.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith(capability, ...args);
    expect(await response.json()).toEqual({ accepted: false });
  });

  it('RA03 report calls reportPresentationFact with the capability and answers the snapshot', async () => {
    const fact = { kind: 'finished', usage: { wallMs: 1000, cpuUsec: null } };
    const reportPresentationFact = vi.fn(async () => view);
    const response = await route({ action: 'report', ...capability, fact }, { reportPresentationFact });
    expect(response.status).toBe(200);
    expect(reportPresentationFact).toHaveBeenCalledWith(capability, fact);
    expect(await response.json()).toMatchObject({ sourceBinding: { storageKey: identity.storageKey, sourceFingerprint: identity.sourceFingerprint }, presentation: null });
  });

  it('RA04 fail calls failPresentation with the identity, D and the code; expiry is fail with `expired`', async () => {
    const failPresentation = vi.fn(async () => view);
    const response = await route({ action: 'fail', ...identity, deadlineAt: accept.deadlineAt, code: 'expired' }, { failPresentation });
    expect(response.status).toBe(200);
    expect(failPresentation).toHaveBeenCalledWith({ ...identity, deadlineAt: accept.deadlineAt }, 'expired');
  });

  it.each([
    ['run', { action: 'run', ...identity, deadlineAt: accept.deadlineAt }],
    ['expire', { action: 'expire', ...identity, deadlineAt: accept.deadlineAt }],
  ])('RA05 refuses the retired %s action as an invalid request without touching the DO', async (_name, body) => {
    const preparePresentation = vi.fn();
    const failPresentation = vi.fn();
    const response = await route(body, { preparePresentation, failPresentation, expirePresentation: vi.fn() });
    expect(response.status).toBe(400);
    expect(preparePresentation).not.toHaveBeenCalled();
    expect(failPresentation).not.toHaveBeenCalled();
  });
});
