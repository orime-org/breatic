// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The presentation boundary over the real store (inner#1306 test plan §77,
 * cases R). Design §10.2: E1 is the presentation admission and the panel retry
 * (E7) goes through that same admission entry, so a `failed` transient ledger
 * becomes `pending` only through `accept`; a `read` never admits. The media
 * container cannot start in workerd, so `MEDIA` hands the route the same real
 * storage owner the store tests use.
 */

import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { VideoPresentationIngestSnapshot } from '@breatic/shared';
import { videoPresentationRoute, type VideoPresentationEnv } from '@ingest/video-presentation-route.js';
import { fixture, ORIGINAL, type LedgerFixture } from './helpers/source-ledger-fixture.js';

const opaque = { codecName: 'vp9', pixelFormat: 'yuv420p', pixelAlpha: 0 as const, alphaMode: null, formatName: 'matroska,webm', videoStreamIndex: 0 };

/**
 * The route's environment, with the container namespace answering through the real store.
 * @param value - The fixture whose storage owner serves the key.
 * @returns The route environment.
 * @throws {never} Never.
 */
function routeEnv(value: LedgerFixture): VideoPresentationEnv {
  const owner = value.owner;
  return {
    INGEST_SHARED_SECRET: 'test-ingest-secret', BUCKET: env.BUCKET,
    MEDIA: { idFromName: (name: string) => name, get: () => ({
      acceptPresentation: (admission: Parameters<typeof owner.accept>[0]) => owner.accept(admission),
      readPresentation: (storageKey: string, sourceFingerprint: string) => owner.read(storageKey, sourceFingerprint),
    }) },
  } as unknown as VideoPresentationEnv;
}

/**
 * Post one presentation operation through the real route.
 * @param value - The fixture.
 * @param body - The operation body.
 * @returns The parsed snapshot.
 * @throws {Error} When the route does not answer 200.
 */
async function post(value: LedgerFixture, body: Record<string, unknown>): Promise<VideoPresentationIngestSnapshot> {
  const response = await videoPresentationRoute(new Request('https://ingest.example.test/video-presentation', {
    method: 'POST', headers: { 'x-ingest-secret': 'test-ingest-secret', 'content-type': 'application/json' }, body: JSON.stringify(body),
  }), routeEnv(value));
  expect(response.status).toBe(200);
  return response.json<VideoPresentationIngestSnapshot>();
}

/**
 * An accept body for the fixture's source under a new job.
 * @param value - The fixture.
 * @param jobId - The proposed job.
 * @returns The request body.
 * @throws {never} Never.
 */
function acceptBody(value: LedgerFixture, jobId: string): Record<string, unknown> {
  const { admission } = value;
  return { action: 'accept', storageKey: admission.storageKey, sourceFingerprint: admission.sourceFingerprint, jobId, deadlineAt: admission.deadlineAt,
    original: admission.original, contentType: admission.contentType, repair: true, limits: admission.limits, pricing: admission.pricing,
    actorUserId: admission.actorUserId, projectId: admission.projectId, packedURL: admission.packedURL, manifestURL: admission.manifestURL,
    sourceLedgerURL: admission.sourceLedgerURL, sourceLedgerTableURL: admission.sourceLedgerTableURL };
}

/**
 * Settle the fixture with a ready native presentation and a failed ledger.
 * @param value - The fixture.
 * @param code - The ledger failure code.
 * @returns Nothing.
 * @throws {Error} When a report is refused.
 */
async function failLedger(value: LedgerFixture, code: string): Promise<void> {
  expect(await value.owner.report({ ...value.identity, kind: 'probe', classification: 'confirmed_opaque', original: ORIGINAL, evidence: opaque })).toBe(true);
  expect(await value.owner.report({ ...value.identity, kind: 'source_ledger_failed', error: code })).toBe(true);
  expect(await value.owner.report({ ...value.identity, kind: 'finished', usage: { wallMs: 10, cpuUsec: 1 } })).toBe(true);
}

describe('ledger retry through the presentation boundary (inner#1306 §77)', () => {
  it('R01 a read leaves a transient ledger failure as it is; the accept entry moves it to pending under a new job', async () => {
    const value = await fixture();
    await failLedger(value, 'source_ledger_invalid');
    const read = await post(value, { action: 'read', storageKey: value.admission.storageKey, sourceFingerprint: value.identity.sourceFingerprint });
    expect(read.sourceLedger).toMatchObject({ state: 'failed', schemaVersion: 2, errorCode: 'source_ledger_invalid' });
    expect(await post(value, { action: 'read', storageKey: value.admission.storageKey, sourceFingerprint: value.identity.sourceFingerprint })).toEqual(read);
    const accepted = await post(value, acceptBody(value, 'route-retry'));
    expect(accepted.sourceLedger).toEqual({ state: 'pending', schemaVersion: 2, sourceFingerprint: value.identity.sourceFingerprint, producerVersion: 2,
      attempt: { jobId: 'route-retry', deadlineAt: value.identity.deadlineAt } });
    expect(accepted.presentation).toEqual(read.presentation);
  });

  it('R02 the accept entry keeps a content ledger failure and starts no job', async () => {
    const value = await fixture();
    await failLedger(value, 'unsupported_rate');
    const read = await post(value, { action: 'read', storageKey: value.admission.storageKey, sourceFingerprint: value.identity.sourceFingerprint });
    expect(read.sourceLedger).toMatchObject({ state: 'failed', schemaVersion: 2, errorCode: 'unsupported_rate' });
    expect(await post(value, acceptBody(value, 'content-route-retry'))).toEqual(read);
  });

  it('R03 two concurrent accepts for the same fingerprint start one producer job', async () => {
    const value = await fixture();
    await failLedger(value, 'expired');
    const [a, b] = await Promise.all([post(value, acceptBody(value, 'route-a')), post(value, acceptBody(value, 'route-b'))]);
    expect(a.sourceLedger).toMatchObject({ state: 'pending', schemaVersion: 2 });
    expect(b).toEqual(a);
    expect(['route-a', 'route-b']).toContain(a.attempt?.jobId);
  });
});
