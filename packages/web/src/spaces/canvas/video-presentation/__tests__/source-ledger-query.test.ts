// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The source ledger body query (inner#1306 consumer oracle W01–W05). The
 * presentation response arrives already parsed by its own query; this one
 * reads the stored table it names through the shared reader. The real
 * QueryClient, reader, digest and parser run; only `fetch` is controlled.
 */

import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as shared from '@breatic/shared';
import type { VideoPresentationResponse, VideoSourceLedgerCompanion } from '@breatic/shared';

import { sourceLedgerQuery } from '../source-ledger-query';

const { readSpy, realRead } = vi.hoisted(() => ({ readSpy: vi.fn(), realRead: { current: undefined as unknown } }));
vi.mock('@breatic/shared', async (original) => {
  const actual = await original<typeof shared>();
  realRead.current = actual.readVideoSourceLedger;
  return { ...actual, readVideoSourceLedger: readSpy };
});

const companion = JSON.parse('{"schemaVersion":1,"sourceFingerprint":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","producerVersion":1,"attempt":{"jobId":"accepted-source-attempt","deadlineAt":7201000},"strategy":"iso_unedited_rate_one","physical":{"streamIndex":1,"trackId":7,"sourceTimeBase":{"numerator":"1","denominator":"1000"},"frames":[{"rawDecodeOrdinal":0,"ptsTicks":"0"},{"rawDecodeOrdinal":1,"ptsTicks":"40"},{"rawDecodeOrdinal":2,"ptsTicks":"80"}]},"container":{"kind":"iso_bmff","movieTimescale":"1000","movieDurationTicks":"4000","track":{"trackId":7,"trackFlags":1,"durationMovieTicks":"4000","mediaTimescale":"1000","mediaDurationTicks":"1000000000","edits":null,"sampleTiming":{"decodeRuns":[{"sampleCount":1,"deltaTicks":"40"},{"sampleCount":1,"deltaTicks":"40"},{"sampleCount":1,"deltaTicks":"40"}],"cttsVersion":null,"compositionRuns":null,"compositionShift":null}}},"presentation":{"edits":[],"frames":[{"presentationOrdinal":0,"editOccurrence":0,"rawDecodeOrdinal":0,"sourcePtsTicks":"0","mappedPts":{"numerator":"0","denominator":"1"},"displayStart":{"numerator":"0","denominator":"1"},"displayEnd":{"numerator":"1","denominator":"25"}},{"presentationOrdinal":1,"editOccurrence":0,"rawDecodeOrdinal":1,"sourcePtsTicks":"40","mappedPts":{"numerator":"1","denominator":"25"},"displayStart":{"numerator":"1","denominator":"25"},"displayEnd":{"numerator":"2","denominator":"25"}},{"presentationOrdinal":2,"editOccurrence":0,"rawDecodeOrdinal":2,"sourcePtsTicks":"80","mappedPts":{"numerator":"2","denominator":"25"},"displayStart":{"numerator":"2","denominator":"25"},"displayEnd":{"numerator":"3","denominator":"25"}}]}}') as VideoSourceLedgerCompanion;
const bytes = new TextEncoder().encode(JSON.stringify(companion));
const ledgerURL = 'https://assets.example.test/canonical.webm.video-source-ledger.v1.json';
const limits = { maxBytes: 16777216, maxPhysicalFrames: 100000, maxOccurrences: 100000 };
const binding = {
  assetId: '21de0c40-eb00-4bc0-ab81-d32f709b3b14', contentHash: 'a'.repeat(64), canonicalURL: 'https://assets.example.test/canonical.webm',
  kind: 'video' as const, mediaInfo: { width: null, height: null, duration: null, mimeType: 'video/webm' },
};
const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>();
let client: QueryClient;
let receipt: shared.VideoSourceLedgerReceipt;

/**
 * A presentation response carrying this ledger state and policy.
 * @param extra - The ledger fields.
 * @returns The response.
 */
function presentation(extra: Partial<VideoPresentationResponse> = {}): VideoPresentationResponse {
  return { sourceBinding: binding, presentation: null, preparation: null, pollAfterMs: null,
    sourceLedger: { state: 'ready', receipt }, sourceLedgerReadLimits: limits, ...extra };
}

/** Serve the stored bytes once. */
function serve(): void {
  fetchMock.mockResolvedValueOnce(new Response(bytes, { status: 200, headers: { 'content-type': 'application/json' } }));
}

beforeEach(async () => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  receipt = {
    schemaVersion: 1, sourceFingerprint: binding.contentHash, producerVersion: 1, strategy: companion.strategy, attempt: companion.attempt,
    url: ledgerURL, etag: '"opaque"', size: bytes.byteLength, sha256: Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join(''),
    contentType: 'application/json', physicalFrameCount: 3, occurrenceCount: 3,
  };
  fetchMock.mockReset();
  readSpy.mockReset().mockImplementation(realRead.current as typeof shared.readVideoSourceLedger);
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  client.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('W01 an authorized ready receipt with its policy', () => {
  it('reads the whole table from the receipt URL through the shared reader', async () => {
    serve();
    expect(await client.fetchQuery(sourceLedgerQuery({ projectId: 'project-a', response: presentation(), active: true }))).toEqual(companion);
    expect(fetchMock.mock.calls[0]![0]).toBe(ledgerURL);
    expect(readSpy).toHaveBeenCalledWith(receipt, limits, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });
});

describe('W02 the key is the receipt, the source and the policy', () => {
  /**
   * The key for a response.
   * @param response - The response.
   * @returns The query key.
   */
  const keyOf = (response: VideoPresentationResponse): readonly unknown[] =>
    sourceLedgerQuery({ projectId: 'project-a', response, active: true }).queryKey;

  it('is the same for the same receipt, and reads once for two consumers', async () => {
    serve();
    expect(keyOf(presentation())).toEqual(keyOf(presentation()));
    const options = sourceLedgerQuery({ projectId: 'project-a', response: presentation(), active: true });
    await Promise.all([client.fetchQuery(options), client.fetchQuery(options)]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['another project', () => sourceLedgerQuery({ projectId: 'project-b', response: presentation(), active: true }).queryKey],
    ['another receipt digest', () => keyOf(presentation({ sourceLedger: { state: 'ready', receipt: { ...receipt, sha256: 'c'.repeat(64) } } }))],
    ['another receipt attempt', () => keyOf(presentation({ sourceLedger: { state: 'ready', receipt: { ...receipt, attempt: { jobId: 'b', deadlineAt: 1 } } } }))],
    ['a tighter policy', () => keyOf(presentation({ sourceLedgerReadLimits: { ...limits, maxOccurrences: 3 } }))],
  ])('differs for %s, which inherits no earlier table', async (_name, other) => {
    serve();
    await client.fetchQuery(sourceLedgerQuery({ projectId: 'project-a', response: presentation(), active: true }));
    const key = other();
    expect(key).not.toEqual(keyOf(presentation()));
    expect(client.getQueryData(key)).toBeUndefined();
  });

  it('carries no frame arrays in its key', () => {
    expect(JSON.stringify(keyOf(presentation()))).not.toContain('presentationOrdinal');
  });
});

describe('W03 nothing to read', () => {
  it.each([
    ['no response yet', () => undefined],
    ['a legacy response', () => presentation({ sourceLedger: undefined, sourceLedgerReadLimits: undefined })],
    ['a ready receipt without read limits', () => presentation({ sourceLedgerReadLimits: undefined })],
    ['a null ledger', () => presentation({ sourceLedger: null })],
    ['a pending ledger', () => presentation({ sourceLedger: { state: 'pending', schemaVersion: 1, sourceFingerprint: binding.contentHash, producerVersion: 1, attempt: companion.attempt } })],
    ['a failed ledger', () => presentation({ sourceLedger: { state: 'failed', schemaVersion: 1, sourceFingerprint: binding.contentHash, producerVersion: 1, attempt: companion.attempt, errorCode: 'ledger_invalid' } })],
    ['a receipt naming another source', () => presentation({ sourceLedger: { state: 'ready', receipt: { ...receipt, sourceFingerprint: 'c'.repeat(64) } } })],
    ['an inactive Space', 'inactive' as const],
  ])('reads nothing for %s', async (_name, response) => {
    const options = sourceLedgerQuery({
      projectId: 'project-a',
      response: response === 'inactive' ? presentation() : response(),
      active: response !== 'inactive',
    });
    expect(options.enabled).toBe(false);
    const observer = new QueryObserver(client, options);
    const unsubscribe = observer.subscribe(() => undefined);
    await Promise.resolve();
    expect(observer.getCurrentResult().data).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    unsubscribe();
  });
});

describe('W04 a failed read is not a table', () => {
  it('ends in an error with no data when the body is not the stored table', async () => {
    const damaged = bytes.slice();
    damaged[damaged.length - 1] = 0x20;
    fetchMock.mockResolvedValueOnce(new Response(damaged, { status: 200, headers: { 'content-type': 'application/json' } }));
    const options = sourceLedgerQuery({ projectId: 'project-a', response: presentation(), active: true });
    await expect(client.fetchQuery(options)).rejects.toBeInstanceOf(shared.VideoSourceLedgerReadRefused);
    expect(client.getQueryData(options.queryKey)).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('W05 one read deadline from the existing default budget', () => {
  it('forms the deadline once from DEFAULT_TIMEOUT_MS and forwards the query signal', async () => {
    serve();
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    await client.fetchQuery(sourceLedgerQuery({ projectId: 'project-a', response: presentation(), active: true }));
    const options = readSpy.mock.calls[0]![2] as { deadlineAt: number; signal: AbortSignal };
    expect(options.deadlineAt).toBe(1_800_000_000_000 + shared.DEFAULT_TIMEOUT_MS);
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it('stops the read when the query is cancelled', async () => {
    fetchMock.mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
    }));
    const options = sourceLedgerQuery({ projectId: 'project-a', response: presentation(), active: true });
    const pending = client.fetchQuery(options).catch((err: unknown) => err);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await client.cancelQueries({ queryKey: options.queryKey });
    await pending;
    expect(fetchMock.mock.calls[0]![1].signal?.aborted).toBe(true);
    expect(client.getQueryData(options.queryKey)).toBeUndefined();
  });
});
