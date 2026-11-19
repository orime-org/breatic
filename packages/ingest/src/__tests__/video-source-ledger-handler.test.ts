// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The edge handler of the one ledger PUT over real R2 and the real store
 * (inner#1306, test plan §89 rewrite; §77 H01–H04; frames-split design §3.5,
 * §7.4).
 *
 * Unchanged: one PUT stores both objects and commits; malformed declarations are
 * 400 with nothing stored; another key is 403; a wrong token or job is 409. The
 * query now names the toolInputId and planSha256 the write belongs to, and the
 * write reaches the store through `claimSourceLedger`, `commitLedger` and
 * `releaseSourceLedger` of that toolInputId; a job that is no longer the writer
 * is refused with 409.
 */

import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import * as containerModule from '@ingest/media-container.js';
import { fullKeyFor, stream, tableKeyFor } from './helpers/source-ledger-fixture.js';
import { admission, D, DECLARATION, FULL, H, LEDGER_BODY, ledgerCase, ledgerPort, NOW, PLAN, T, TABLE, withStore, type LedgerCase } from './helpers/machine-store.js';

type Handler = (request: Request, environment: unknown, ctx: unknown) => Promise<Response>;

/**
 * The production handler, failing when it is not exported.
 * @returns The handler.
 */
function handler(): Handler {
  const found = (containerModule as Record<string, unknown>).writeSourceLedgerPresentation;
  expect(typeof found).toBe('function');
  return found as Handler;
}

/**
 * Send the one PUT of a case.
 * @param value - The case.
 * @param change - What to change.
 * @param change.query - Query overrides.
 * @param change.key - Another target key.
 * @param change.contentLength - Another content length.
 * @returns The response.
 */
function send(value: LedgerCase, change: { query?: Record<string, string>; key?: string; contentLength?: number } = {}): Promise<Response> {
  const url = new URL(`http://source-ledger.local/${change.key ?? fullKeyFor(value.key, T)}`);
  const query = {
    jobId: value.identity.jobId, sourceFingerprint: H, deadlineAt: String(value.identity.deadlineAt), token: value.identity.token,
    toolInputId: T, planSha256: PLAN, producerVersion: '2', byteLength: String(FULL.length), tableByteLength: String(TABLE.length),
    tableFrameCount: String(DECLARATION.table.frameCount), ...change.query,
  };
  for (const [name, entry] of Object.entries(query)) url.searchParams.set(name, entry);
  const request = new Request(url, { method: 'PUT', body: stream(LEDGER_BODY), headers: { 'content-length': String(change.contentLength ?? LEDGER_BODY.length) }, duplex: 'half' } as RequestInit);
  const environment = { BUCKET: env.BUCKET, MEDIA: { idFromName: (name: string) => name, get: () => ledgerPort(value.key) } };
  return handler()(request, environment, { params: { key: value.key } });
}

/**
 * Assert that neither object was stored.
 * @param value - The case.
 */
async function nothingStored(value: LedgerCase): Promise<void> {
  expect(await env.BUCKET.head(fullKeyFor(value.key, T))).toBeNull();
  expect(await env.BUCKET.head(tableKeyFor(value.key, T))).toBeNull();
}

describe('edge handler for the one ledger PUT (inner#1306 §77, §7.4)', () => {
  it('H01 stores both objects and commits the ready ledger of the named toolInputId', async () => {
    const value = await ledgerCase();
    expect((await send(value)).status).toBe(200);
    expect(new Uint8Array(await (await env.BUCKET.get(fullKeyFor(value.key, T)))!.arrayBuffer())).toEqual(FULL);
    expect(new Uint8Array(await (await env.BUCKET.get(tableKeyFor(value.key, T)))!.arrayBuffer())).toEqual(TABLE);
    expect((await withStore(value.key, (store) => store.read(value.key, H))).ledgers[T]!.kind).toBe('ready');
  });

  it.each([
    ['a content-length other than both lengths', { contentLength: 1 }],
    ['a ledger length that does not add up', { query: { byteLength: '1' } }],
    ['a zero table length', { query: { tableByteLength: '0' } }],
    ['a zero frame count', { query: { tableFrameCount: '0' } }],
    ['a fractional frame count', { query: { tableFrameCount: '1.5' } }],
    ['producer version 1', { query: { producerVersion: '1' } }],
    ['a missing token', { query: { token: '' } }],
    ['a malformed fingerprint', { query: { sourceFingerprint: 'not-a-hash' } }],
    ['a missing toolInputId', { query: { toolInputId: '' } }],
    ['a malformed planSha256', { query: { planSha256: 'not-a-hash' } }],
  ])('H02 refuses %s with 400 and stores nothing', async (_name, change) => {
    const value = await ledgerCase();
    expect((await send(value, change)).status).toBe(400);
    await nothingStored(value);
    expect((await withStore(value.key, (store) => store.read(value.key, H))).ledgers[T]!.kind).toBe('pending');
  });

  it('H03 refuses another key with 403', async () => {
    const value = await ledgerCase();
    expect((await send(value, { key: `${value.key}.other.json` })).status).toBe(403);
    await nothingStored(value);
  });

  // S6e E4-7 (design §5.1 step 5): the write path names the full ledger key of the query's toolInputId.
  it.each([
    ['the toolInputId-less legacy key', (key: string): string => `${key}.video-source-ledger.v1.json`],
    ['the key of another toolInputId than the query names', (key: string): string => fullKeyFor(key, 'e'.repeat(64))],
    ['the compact table key of the toolInputId', (key: string): string => tableKeyFor(key, T)],
  ] as const)('H03 refuses %s with 403', async (_name, keyOf) => {
    const value = await ledgerCase();
    expect((await send(value, { key: keyOf(value.key) })).status).toBe(403);
    await nothingStored(value);
  });

  it.each([['a wrong token', 'token'], ['an unknown job', 'jobId'], ['another toolInputId', 'toolInputId']] as const)('H04 refuses %s with 409 and stores nothing', async (_name, field) => {
    const value = await ledgerCase();
    // S6e E4-7: the path of another toolInputId's write is that toolInputId's own key, so the refusal is the claim's.
    const change = field === 'toolInputId' ? { key: fullKeyFor(value.key, 'e'.repeat(64)), query: { toolInputId: 'e'.repeat(64) } } : { query: { [field]: 'not-the-accepted-one' } };
    expect((await send(value, change)).status).toBe(409);
    await nothingStored(value);
  });

  it('H04 refuses a job that is no longer the writer with 409 and leaves the current writer pending', async () => {
    const value = await ledgerCase();
    await withStore(value.key, async (store) => {
      await store.accept(admission(value.key, 'job-b'));
      const { token } = await store.prepare({ storageKey: value.key, sourceFingerprint: H, jobId: 'job-b', deadlineAt: D }, NOW);
      await store.planPresentation({ storageKey: value.key, sourceFingerprint: H, jobId: 'job-b', deadlineAt: D, token: token! }, { route: 'encode', toolInputId: T, planSha256: PLAN });
    });
    expect((await send(value)).status).toBe(409);
    await nothingStored(value);
    expect((await withStore(value.key, (store) => store.read(value.key, H))).ledgers[T]).toMatchObject({ kind: 'pending', writer: 'job-b' });
  });
});
