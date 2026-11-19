// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Ledger repair through the ingest presentation route over the real store and R2
 * (inner#1306, test plan §89 rewrite of §77 R01–R03; frames-split design §3.5
 * server/worker→ingest, §7.4 arbitration, §5.2 ledgerOnly repair).
 *
 * The route is the ingest DO's own HTTP surface. A read never repairs; the
 * accept entry is the one admission entry for repair (§7.4 「重试与受理走同一受理入口」):
 * with a selected version whose ledger failed transiently it makes the new job the
 * writer of that toolInputId without a new carrier, keeps a content failure, and
 * two concurrent repairs make one writer. The request carries the fields §3.5
 * fixes (storageKey, sourceFingerprint, action, jobId, deadline, limits, the basic
 * and standard-4 prices, the target policy) plus the admission policy; the
 * response is the ingest snapshot (§3.5 response row, §5.1 step 6): source
 * binding, selected bundle, preparation and the L state of the selected
 * toolInputId in the §10.1 wire states, with no full array. Writer facts are
 * read from the store itself.
 */

import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { videoPresentationIngestSnapshotSchema } from '@breatic/shared';
import { videoPresentationRoute, type VideoPresentationEnv } from '@ingest/video-presentation-route.js';
import { admission, bundle, H, planned, POLICY, source, T, withStore, type Admission } from './helpers/machine-store.js';

/** The decided S6c snapshot (§3.5 response row); declared here until the shared type carries it. */
interface Snapshot {
  sourceBinding: { storageKey: string; sourceFingerprint: string };
  presentation: Record<string, unknown> | null;
  preparation: { targetPolicyVersion: number; jobId: string; stage: string; failure: string | null } | null;
  ledger: { state: string; receipt: Record<string, unknown> | null; failure: string | null } | null;
}

/**
 * The route environment whose DO surface reaches the real store of one key.
 * @param key - The storage key.
 * @returns The environment.
 */
function routeEnv(key: string): VideoPresentationEnv {
  return {
    INGEST_SHARED_SECRET: 'test-ingest-secret', BUCKET: env.BUCKET,
    MEDIA: { idFromName: (name: string) => name, get: () => ({
      acceptPresentation: (value: Admission) => withStore(key, (store) => store.accept(value)),
      readPresentation: (storageKey: string, sourceFingerprint: string) => withStore(key, (store) => store.read(storageKey, sourceFingerprint)),
    }) },
  } as unknown as VideoPresentationEnv;
}

/**
 * Post one request to the route and parse the snapshot.
 * @param key - The storage key.
 * @param body - The request body.
 * @returns The snapshot.
 */
async function post(key: string, body: Record<string, unknown>): Promise<Snapshot> {
  const response = await videoPresentationRoute(new Request('https://ingest.example.test/video-presentation', {
    method: 'POST', headers: { 'x-ingest-secret': 'test-ingest-secret', 'content-type': 'application/json' }, body: JSON.stringify(body),
  }), routeEnv(key));
  expect(response.status).toBe(200);
  return videoPresentationIngestSnapshotSchema.parse(await response.json()) as unknown as Snapshot;
}

/**
 * A repair accept body for a new job.
 * @param key - The storage key.
 * @param jobId - The new job.
 * @returns The body.
 */
function acceptBody(key: string, jobId: string): Record<string, unknown> {
  const value = admission(key, jobId);
  return {
    action: 'accept', storageKey: key, sourceFingerprint: H, jobId, deadlineAt: value.deadlineAt, original: value.original, contentType: value.contentType,
    repair: true, limits: value.limits, pricing: value.pricing, targetPolicyVersion: value.targetPolicyVersion, actorUserId: value.actorUserId, projectId: value.projectId,
    publicBaseURL: value.publicBaseURL, policy: POLICY, encoding: value.encoding, probe: value.probe,
  };
}

/**
 * A source whose version e of T is selected and whose ledger of T failed with the code.
 * @param code - The ledger failure code.
 * @returns The storage key.
 */
async function selectedWithFailedLedger(code: string): Promise<string> {
  const key = await source();
  await withStore(key, async (store) => {
    const a = await planned(store, key, 'job-a', 'identity');
    await store.failLedger(a, T, code);
    expect((await store.report(a, { kind: 'verified', bundle: await bundle(key, 'e'.repeat(64)) })).selected).toEqual({ kind: 'ready', version: { versionId: 'e'.repeat(64), toolInputId: T } });
  });
  return key;
}

/**
 * A read body with the target policy (§3.5 「freeze/read/repair都传目标policy」).
 * @param key - The storage key.
 * @returns The body.
 */
function readBody(key: string): Record<string, unknown> {
  return { action: 'read', storageKey: key, sourceFingerprint: H, targetPolicyVersion: 1 };
}

const E = 'e'.repeat(64);

describe('ledger repair through the presentation route (inner#1306 §7.4, §5.2)', () => {
  it('R01 a read leaves a transient ledger failure as it is; the repair accept makes the new job the writer of the selected toolInputId', async () => {
    const key = await selectedWithFailedLedger('source_ledger_invalid');
    const read = await post(key, readBody(key));
    expect(read).not.toHaveProperty('ledgers');
    expect(read.sourceBinding).toEqual({ storageKey: key, sourceFingerprint: H });
    expect(read.presentation).toMatchObject({ versionId: E, toolInputId: T });
    expect(read.ledger).toEqual({ state: 'failed', receipt: null, failure: 'source_ledger_invalid' });
    expect(await post(key, readBody(key))).toEqual(read);
    const accepted = await post(key, acceptBody(key, 'route-retry'));
    expect(accepted.ledger).toEqual({ state: 'pending', receipt: null, failure: null });
    expect(accepted.presentation).toEqual(read.presentation);
    expect((await withStore(key, (store) => store.read(key, H))).ledgers[T]).toEqual({ kind: 'pending', writer: 'route-retry', writerArchived: false, waiters: [] });
  });

  it('R02 the repair accept keeps a content ledger failure and makes no writer', async () => {
    const key = await selectedWithFailedLedger('unsupported_rate');
    const accepted = await post(key, acceptBody(key, 'content-route-retry'));
    expect(accepted.ledger).toEqual({ state: 'failed', receipt: null, failure: 'unsupported_rate' });
    expect(accepted.presentation).toMatchObject({ versionId: E, toolInputId: T });
    const view = await withStore(key, (store) => store.read(key, H));
    expect(view.ledgers[T]).toEqual({ kind: 'failed-content', code: 'unsupported_rate' });
    expect(view.selected).toEqual({ kind: 'ready', version: { versionId: E, toolInputId: T } });
  });

  it('R03 two concurrent repair accepts make one writer', async () => {
    const key = await selectedWithFailedLedger('expired');
    const [a, b] = await Promise.all([post(key, acceptBody(key, 'route-a')), post(key, acceptBody(key, 'route-b'))]);
    expect([a.ledger, b.ledger]).toEqual([{ state: 'pending', receipt: null, failure: null }, { state: 'pending', receipt: null, failure: null }]);
    const writer = ((await withStore(key, (store) => store.read(key, H))).ledgers[T] as { writer?: string }).writer;
    expect(['route-a', 'route-b']).toContain(writer);
  });
});
