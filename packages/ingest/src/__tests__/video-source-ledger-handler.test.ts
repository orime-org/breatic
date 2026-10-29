// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The edge outbound handler that receives the producer's one ledger PUT
 * (inner#1306 test plan §77, cases H). Contract: `writeSourceLedgerPresentation`
 * is exported from `media-container.ts` beside `writeAlphaPresentation` and
 * takes the same `(request, env, ctx)`. It accepts only a PUT for
 * `videoSourceLedgerKeyFor(ctx.params.key)` whose query carries the accepted
 * identity (`jobId`, `sourceFingerprint`, `deadlineAt`, `token`) and the
 * declaration (`producerVersion=2`, `byteLength`, `tableByteLength`,
 * `tableFrameCount`), with `content-length` equal to the two lengths together.
 * A malformed request answers 400, another key 403, a refused claim 409;
 * success stores both objects and answers 200.
 */

import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { videoSourceLedgerKeyFor } from '@breatic/shared';
import * as containerModule from '@ingest/media-container.js';
import { fixture, replacement, stream, tableKeyFor, type LedgerFixture } from './helpers/source-ledger-fixture.js';

type Handler = (request: Request, environment: unknown, ctx: unknown) => Promise<Response>;

/**
 * The handler under test, read at call time so a missing export fails one case.
 * @returns The handler.
 * @throws {Error} When media-container does not export it.
 */
function handler(): Handler {
  const found = (containerModule as Record<string, unknown>).writeSourceLedgerPresentation;
  expect(typeof found).toBe('function');
  return found as Handler;
}

/**
 * Send one producer PUT for the fixture.
 * @param value - The fixture.
 * @param change - Query, header, key or body overrides.
 * @param change.query - Query parameter overrides.
 * @param change.key - The asked key, when not the ledger key.
 * @param change.contentLength - The content-length header, when not the body length.
 * @param change.body - The body, when not the fixture's.
 * @returns The handler's response.
 * @throws {Error} When the handler is missing.
 */
function send(value: LedgerFixture, change: { query?: Record<string, string>; key?: string; contentLength?: number; body?: Uint8Array } = {}): Promise<Response> {
  const body = change.body ?? value.body;
  const url = new URL(`http://source-ledger.local/${change.key ?? videoSourceLedgerKeyFor(value.admission.storageKey)}`);
  const query = { jobId: value.identity.jobId, sourceFingerprint: value.identity.sourceFingerprint, deadlineAt: String(value.identity.deadlineAt),
    token: value.identity.token, producerVersion: '2', byteLength: String(value.bytes.length), tableByteLength: String(value.tableBytes.length),
    tableFrameCount: String(value.declaration.table.frameCount), ...change.query };
  for (const [name, entry] of Object.entries(query)) url.searchParams.set(name, entry);
  const request = new Request(url, { method: 'PUT', body: stream(body), headers: { 'content-length': String(change.contentLength ?? body.length) }, duplex: 'half' } as RequestInit);
  const environment = { BUCKET: env.BUCKET, MEDIA: { idFromName: (name: string) => name, get: () => value.owner } };
  return handler()(request, environment, { params: { key: value.admission.storageKey } });
}

/**
 * Whether neither object was stored.
 * @param value - The fixture.
 * @returns Nothing when both keys are empty.
 * @throws {Error} When either object exists.
 */
async function nothingStored(value: LedgerFixture): Promise<void> {
  expect(await env.BUCKET.head(videoSourceLedgerKeyFor(value.admission.storageKey))).toBeNull();
  expect(await env.BUCKET.head(tableKeyFor(value.admission.storageKey))).toBeNull();
}

describe('edge handler for the one ledger PUT (inner#1306 §77)', () => {
  it('H01 stores both objects and commits the ready ledger', async () => {
    const value = await fixture();
    expect((await send(value)).status).toBe(200);
    expect(new Uint8Array(await (await env.BUCKET.get(videoSourceLedgerKeyFor(value.admission.storageKey)))!.arrayBuffer())).toEqual(value.bytes);
    expect(new Uint8Array(await (await env.BUCKET.get(tableKeyFor(value.admission.storageKey)))!.arrayBuffer())).toEqual(value.tableBytes);
    expect((await value.owner.snapshotFor(value.identity)).sourceLedger?.state).toBe('ready');
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
  ])('H02 refuses %s with 400 and stores nothing', async (_name, change) => {
    const value = await fixture();
    expect((await send(value, change)).status).toBe(400);
    await nothingStored(value);
    expect((await value.owner.snapshotFor(value.identity)).sourceLedger?.state).toBe('pending');
  });

  it('H03 refuses another key with 403', async () => {
    const value = await fixture();
    expect((await send(value, { key: `${value.admission.storageKey}.other.json` })).status).toBe(403);
    await nothingStored(value);
  });

  it.each([['a wrong token', 'token'], ['an unknown job', 'jobId']] as const)('H04 refuses %s with 409 and stores nothing', async (_name, field) => {
    const value = await fixture();
    expect((await send(value, { query: { [field]: 'not-the-accepted-one' } })).status).toBe(409);
    await nothingStored(value);
  });

  it('H04 refuses the superseded job with 409 and leaves the current job pending', async () => {
    const value = await fixture();
    const current = await replacement(value);
    const before = await current.owner.snapshotFor(current.identity);
    expect((await send(value)).status).toBe(409);
    await nothingStored(value);
    expect(await current.owner.snapshotFor(current.identity)).toEqual(before);
  });
});
