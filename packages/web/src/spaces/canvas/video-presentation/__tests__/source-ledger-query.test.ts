// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VideoPresentationResponse, VideoSourceLedgerReceiptV2 } from '@breatic/shared';
import { sourceLedgerQuery } from '../source-ledger-query';

// S4 replaces the temporary S3 v1-only reader contract: real query, reader,
// parser, digest and QueryClient; only the network platform is controlled.
const table = { schemaVersion: 1, timescale: 1000, runs: [{ start: 2000, count: 3, step: 40, duration: 30 }] };
const bytes = new TextEncoder().encode(JSON.stringify(table));
const tableURL = 'https://assets.example.test/source.presentation-table.json';
const binding = { assetId: '21de0c40-eb00-4bc0-ab81-d32f709b3b14', contentHash: 'a'.repeat(64), canonicalURL: 'https://assets.example.test/source.webm', kind: 'video' as const, mediaInfo: { width: 96, height: 64, duration: 3, mimeType: 'video/webm' } };
const policy = { maxBytes: 16777216 };
const attempt = { jobId: 'accepted-source-attempt', deadlineAt: 1 };
const fetchMock = vi.fn<typeof fetch>();
let client: QueryClient;
let receipt: VideoSourceLedgerReceiptV2;

/** Builds the authorized response, with the new byte-only compact policy. @throws {never} Never. */
function response(extra: Record<string, unknown> = {}): VideoPresentationResponse {
  return { sourceBinding: binding, presentation: { schemaVersion: 1, sourceFingerprint: binding.contentHash, state: 'native', original: { width: 96, height: 64, duration: 3 } }, preparation: null, pollAfterMs: null, sourceLedger: { state: 'ready', receipt }, sourceLedgerReadLimits: policy, ...extra } as VideoPresentationResponse;
}
/** Describes the actual consumer query. @throws {never} Never. */
function options(value = response(), projectId = 'project-a', active = true): ReturnType<typeof sourceLedgerQuery> { return sourceLedgerQuery({ projectId, response: value, active }); }
/** Serves the compact table once. @throws {Error} When constructing a response fails. */
function serve(): void { fetchMock.mockResolvedValueOnce(new Response(bytes, { headers: { 'content-type': 'application/json' } })); }
/** Guards refusal cases against a reader that refuses everything. @throws {Error} When a valid compact read is refused. */
async function accepts(): Promise<void> { serve(); expect(await client.fetchQuery(options())).toEqual(table); fetchMock.mockClear(); }

beforeEach(async () => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  receipt = { schemaVersion: 2, sourceFingerprint: binding.contentHash, producerVersion: 2, attempt, url: 'https://assets.example.test/source.full-ledger.json', etag: 'opaque', size: 9000, sha256: 'b'.repeat(64), contentType: 'application/json',
    table: { url: tableURL, size: bytes.length, frameCount: 3, sha256: Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('') } };
  fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { client.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('S4 authorized compact-table query', () => {
  it('W01 enables a current v2 receipt and reads ONLY its compact URL, never the full ledger', async () => {
    expect(options().enabled).toBe(true); serve();
    expect(await client.fetchQuery(options())).toEqual(table);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([tableURL]);
    expect(client.getQueryData(options().queryKey)).toEqual(table);
  });
  it('W02 sends exactly one compact GET for simultaneous consumers', async () => {
    serve(); await Promise.all([client.fetchQuery(options()), client.fetchQuery(options())]);
    expect(fetchMock).toHaveBeenCalledTimes(1); expect(fetchMock.mock.calls[0]?.[0]).toBe(tableURL);
  });
  it.each([
    ['project', () => options(response(), 'project-b')],
    ['source', () => options(response({ sourceBinding: { ...binding, canonicalURL: 'https://assets.example.test/other.webm' } }))],
    ['fingerprint', () => options(response({ sourceBinding: { ...binding, contentHash: 'c'.repeat(64) }, sourceLedger: { state: 'ready', receipt: { ...receipt, sourceFingerprint: 'c'.repeat(64) } } }))],
    ['table digest', () => options(response({ sourceLedger: { state: 'ready', receipt: { ...receipt, table: { ...receipt.table, sha256: 'd'.repeat(64) } } } }))],
    ['table URL', () => options(response({ sourceLedger: { state: 'ready', receipt: { ...receipt, table: { ...receipt.table, url: 'https://assets.example.test/other.table' } } } }))],
    ['attempt', () => options(response({ sourceLedger: { state: 'ready', receipt: { ...receipt, attempt: { ...attempt, jobId: 'new' } } } }))],
    ['policy', () => options(response({ sourceLedgerReadLimits: { maxBytes: policy.maxBytes - 1 } }))],
  ])('W03 isolates %s with no previous table', async (_name, other) => {
    await accepts(); const changed = other(); expect(changed.queryKey).not.toEqual(options().queryKey);
    expect(client.getQueryData(changed.queryKey)).toBeUndefined();
  });
  it.each([
    ['absent', () => response({ sourceLedger: undefined })], ['null', () => response({ sourceLedger: null })],
    ['pending', () => response({ sourceLedger: { state: 'pending', schemaVersion: 2, producerVersion: 2, sourceFingerprint: binding.contentHash, attempt } })],
    ['failed', () => response({ sourceLedger: { state: 'failed', schemaVersion: 2, producerVersion: 2, sourceFingerprint: binding.contentHash, attempt, errorCode: 'expired' } })],
    ['wrong source', () => response({ sourceLedger: { state: 'ready', receipt: { ...receipt, sourceFingerprint: 'c'.repeat(64) } } })],
    ['missing policy', () => response({ sourceLedgerReadLimits: undefined })], ['inactive', () => response()],
    ['v1 receipt', () => { const { table: _table, ...old } = receipt; return response({ sourceLedger: { state: 'ready', receipt: { ...old, schemaVersion: 1, producerVersion: 1, strategy: 'iso_unedited_rate_one' } } }); }],
  ])('W04 does not read %s', async (name, value) => {
    await accepts();
    const query = options(value(), 'project-a', name !== 'inactive'); expect(query.enabled).toBe(false);
    const observer = new QueryObserver(client, query); const unsubscribe = observer.subscribe(() => undefined);
    await Promise.resolve(); expect(fetchMock).not.toHaveBeenCalled(); unsubscribe();
  });
  it('W05 a validation error exposes no table and can retry the same current receipt', async () => {
    await accepts(); client.clear();
    const damaged = bytes.slice(); damaged[0] = 0x20;
    fetchMock.mockResolvedValueOnce(new Response(damaged, { headers: { 'content-type': 'application/json' } }));
    await expect(client.fetchQuery(options())).rejects.toMatchObject({ reason: 'digest' });
    expect(client.getQueryData(options().queryKey)).toBeUndefined();
    serve(); expect(await client.fetchQuery(options())).toEqual(table);
  });
  it('W06 cancels the actual shared read when the source query is abandoned', async () => {
    await accepts(); client.clear();
    fetchMock.mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))));
    const query = options(); const pending = client.fetchQuery(query).catch((error: unknown) => error);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    await client.cancelQueries({ queryKey: query.queryKey }); await pending;
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(client.getQueryData(query.queryKey)).toBeUndefined();
  });
  it('W07 source replacement cannot inherit a previously completed table', async () => {
    await accepts(); const observer = new QueryObserver(client, options()); const unsubscribe = observer.subscribe(() => undefined);
    observer.setOptions(options(response({ sourceBinding: { ...binding, canonicalURL: 'https://assets.example.test/new.webm', contentHash: 'c'.repeat(64) }, sourceLedger: null })));
    expect(observer.getCurrentResult().data).toBeUndefined(); expect(fetchMock).not.toHaveBeenCalled(); unsubscribe();
  });
});
