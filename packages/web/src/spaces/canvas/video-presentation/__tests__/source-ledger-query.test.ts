// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VideoPresentationResponse } from '@breatic/shared';
import { sourceLedgerQuery } from '../source-ledger-query';
import { PRESENTED, presentedBinding, presentedBundle, readyLedger } from '@web/test-utils/video-presentation';

// S4 replaces the temporary S3 v1-only reader contract: real query, reader,
// parser, digest and QueryClient; only the network platform is controlled.
// §95 (design §3.2, §7.4, §7.12 step 4): the selected bundle's ledger receipt names the compact object, the four fields
// {sourceFingerprint, toolInputId, planSha256, presentation} around the S1 table (`videoPresentationCompactSchema`); the
// bare table and the fingerprint-keyed `sourceLedger` are the earlier shapes (fixtures migrated, 4.4.5).
const table = { schemaVersion: 1, timescale: 1000, runs: [{ start: 2000, count: 3, step: 40, duration: 30 }] };
const compact = { sourceFingerprint: PRESENTED.fingerprint, toolInputId: PRESENTED.toolInputId, planSha256: PRESENTED.planSha256, presentation: table };
const bytes = new TextEncoder().encode(JSON.stringify(compact));
const sourceURL = 'https://assets.example.test/source.webm';
const tableURL = `${sourceURL}.compact.json`;
const binding = presentedBinding(sourceURL, { width: 96, height: 64, duration: 3, mimeType: 'video/webm' });
const bundle = presentedBundle(sourceURL);
const policy = { maxBytes: 16777216 };
const fetchMock = vi.fn<typeof fetch>();
let client: QueryClient;
let receipt: Extract<NonNullable<VideoPresentationResponse['ledger']>, { state: 'ready' }>['receipt'];
const attempt = { jobId: PRESENTED.jobId, deadlineAt: PRESENTED.deadlineAt };

/** Builds the authorized response, with the new byte-only compact policy. @throws {never} Never. */
function response(extra: Record<string, unknown> = {}): VideoPresentationResponse {
  return { sourceBinding: binding, presentation: bundle, preparation: null, pollAfterMs: null, ledger: { state: 'ready', receipt, failure: null }, sourceLedgerReadLimits: policy, ...extra } as VideoPresentationResponse;
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
  const ready = readyLedger(bundle, 3);
  if (ready.state !== 'ready') throw new Error('Expected a ready ledger');
  receipt = { ...ready.receipt, table: { ...ready.receipt.table, url: tableURL, size: bytes.length, frameCount: 3, sha256: Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('') } };
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
    ['fingerprint', () => options(response({ sourceBinding: { ...binding, contentHash: 'c'.repeat(64) }, ledger: { state: 'ready', failure: null, receipt: { ...receipt, sourceFingerprint: 'c'.repeat(64) } } }))],
    ['toolInputId', () => options(response({ ledger: { state: 'ready', failure: null, receipt: { ...receipt, toolInputId: 'b'.repeat(64) } } }))],
    ['table digest', () => options(response({ ledger: { state: 'ready', failure: null, receipt: { ...receipt, table: { ...receipt.table, sha256: 'd'.repeat(64) } } } }))],
    ['table URL', () => options(response({ ledger: { state: 'ready', failure: null, receipt: { ...receipt, table: { ...receipt.table, url: 'https://assets.example.test/other.table' } } } }))],
    ['attempt', () => options(response({ ledger: { state: 'ready', failure: null, receipt: { ...receipt, attempt: { ...attempt, jobId: 'new' } } } }))],
    ['policy', () => options(response({ sourceLedgerReadLimits: { maxBytes: policy.maxBytes - 1 } }))],
  ])('W03 isolates %s with no previous table', async (_name, other) => {
    await accepts(); const changed = other(); expect(changed.queryKey).not.toEqual(options().queryKey);
    expect(client.getQueryData(changed.queryKey)).toBeUndefined();
  });
  it.each([
    ['null', () => response({ ledger: null })], ['no selected bundle', () => response({ presentation: null, ledger: null })],
    ['pending', () => response({ ledger: { state: 'pending', receipt: null, failure: null } })],
    ['failed', () => response({ ledger: { state: 'failed', receipt: null, failure: 'expired' } })],
    ['wrong source', () => response({ ledger: { state: 'ready', failure: null, receipt: { ...receipt, sourceFingerprint: 'c'.repeat(64) } } })],
    ['another toolInputId than the selected bundle', () => response({ ledger: { state: 'ready', failure: null, receipt: { ...receipt, toolInputId: 'b'.repeat(64) } } })],
    ['missing policy', () => response({ sourceLedgerReadLimits: undefined })], ['inactive', () => response()],
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
    observer.setOptions(options(response({ sourceBinding: { ...binding, canonicalURL: 'https://assets.example.test/new.webm', contentHash: 'c'.repeat(64) }, presentation: null, ledger: null })));
    expect(observer.getCurrentResult().data).toBeUndefined(); expect(fetchMock).not.toHaveBeenCalled(); unsubscribe();
  });
});
