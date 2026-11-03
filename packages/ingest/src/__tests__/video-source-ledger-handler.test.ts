// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

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
import { videoSourceLedgerKeyFor } from '@breatic/shared';
import * as containerModule from '@ingest/media-container.js';
import { stream, tableKeyFor } from './helpers/source-ledger-fixture.js';
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
  const url = new URL(`http://source-ledger.local/${change.key ?? videoSourceLedgerKeyFor(value.key)}`);
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
  expect(await env.BUCKET.head(videoSourceLedgerKeyFor(value.key))).toBeNull();
  expect(await env.BUCKET.head(tableKeyFor(value.key))).toBeNull();
}

describe('edge handler for the one ledger PUT (inner#1306 §77, §7.4)', () => {
  it('H01 stores both objects and commits the ready ledger of the named toolInputId', async () => {
    const value = await ledgerCase();
    expect((await send(value)).status).toBe(200);
    expect(new Uint8Array(await (await env.BUCKET.get(videoSourceLedgerKeyFor(value.key)))!.arrayBuffer())).toEqual(FULL);
    expect(new Uint8Array(await (await env.BUCKET.get(tableKeyFor(value.key)))!.arrayBuffer())).toEqual(TABLE);
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

  it.each([['a wrong token', 'token'], ['an unknown job', 'jobId'], ['another toolInputId', 'toolInputId']] as const)('H04 refuses %s with 409 and stores nothing', async (_name, field) => {
    const value = await ledgerCase();
    expect((await send(value, { query: { [field]: field === 'toolInputId' ? 'e'.repeat(64) : 'not-the-accepted-one' } })).status).toBe(409);
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
