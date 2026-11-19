// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The companion ledger instance of one toolInputId over real storage and R2
 * (inner#1306, test plan §89 rewrite of §77 T01–T13; frames-split design §7.4).
 *
 * The instance is keyed by toolInputId, its writer is decided at Tp, only the
 * writer's facts count, ready comes only from `commitLedger` over both measured
 * objects, failed only from `failLedger` (or a physical check), candidate codes
 * are never stored, and P never changes because of L alone.
 */

import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { fullKeyFor, tableKeyFor } from './helpers/source-ledger-fixture.js';
import { admission, D, DECLARATION, expectedReceipt, FULL, H, ledgerCase, NOW, PLAN, produceLedger, putLedger, T, T2, TABLE, withStore, type Identity, type MachineStore } from './helpers/machine-store.js';

/**
 * Admit, start and plan job b for T after job a.
 * @param store - The store.
 * @param key - The source key.
 * @returns Job b and whether it is the writer.
 */
async function jobB(store: MachineStore, key: string): Promise<{ b: Identity; writer: boolean }> {
  await store.accept(admission(key, 'job-b'));
  const { token } = await store.prepare({ storageKey: key, sourceFingerprint: H, jobId: 'job-b', deadlineAt: D }, NOW);
  const b = { storageKey: key, sourceFingerprint: H, jobId: 'job-b', deadlineAt: D, token: token! };
  return { b, writer: (await store.planPresentation(b, { route: 'encode', toolInputId: T, planSha256: PLAN })).writer };
}

describe('ledger instance per toolInputId (inner#1306 §7.4)', () => {
  it('T01 the writer\'s commit of both measured objects makes the instance ready and leaves P alone', async () => {
    const { key, identity } = await ledgerCase();
    await withStore(key, async (store) => {
      const measured = await produceLedger(store, identity);
      const view = await store.read(key, H);
      expect(view.ledgers[T]).toEqual({ kind: 'ready', receipt: await expectedReceipt(key, 'job-a', measured) });
      expect(view.selected).toEqual({ kind: 'unknown' });
    });
  });

  it.each(['table-missing', 'table-size', 'table-owner', 'table-mime', 'table-etag', 'ledger-missing'] as const)('T02 a commit is refused when %s, and the instance stays pending', async (defect) => {
    const { key, identity } = await ledgerCase();
    await withStore(key, async (store) => {
      const claim = (await store.claimSourceLedger(identity, T, DECLARATION))!;
      const measured = await putLedger(claim, 'job-a');
      const metadata = { httpMetadata: { contentType: 'application/json' }, customMetadata: { sourceLedgerJobId: 'job-a', sourceLedgerClaimOwner: claim.owner } };
      if (defect === 'table-missing') await env.BUCKET.delete(tableKeyFor(key, T));
      if (defect === 'table-size') await env.BUCKET.put(tableKeyFor(key, T), new Uint8Array([...TABLE, 32]), metadata);
      if (defect === 'table-owner') await env.BUCKET.put(tableKeyFor(key, T), TABLE, { ...metadata, customMetadata: { ...metadata.customMetadata, sourceLedgerClaimOwner: 'someone-else' } });
      if (defect === 'table-mime') await env.BUCKET.put(tableKeyFor(key, T), TABLE, { ...metadata, httpMetadata: { contentType: 'text/plain' } });
      if (defect === 'table-etag') {
        // Same length and metadata, one byte flipped: miniflare's R2 etag is the content MD5, so identical bytes would not differ (§7.3).
        const changed = TABLE.slice();
        changed[changed.length - 1]! ^= 1;
        expect((await env.BUCKET.put(tableKeyFor(key, T), changed, metadata)).etag).not.toBe(measured.table.etag);
      }
      if (defect === 'ledger-missing') await env.BUCKET.delete(fullKeyFor(key, T));
      expect(await store.commitLedger(identity, T, claim.owner, measured)).toBe(false);
      expect((await store.read(key, H)).ledgers[T]).toEqual({ kind: 'pending', writer: 'job-a', writerArchived: false, waiters: [] });
    });
  });

  it.each([['missing', 'source_ledger_missing'], ['replaced', 'source_ledger_invalid']] as const)('T03 a ready instance whose table is %s reads as failed-transient %s, P unchanged', async (change, code) => {
    const { key, identity } = await ledgerCase();
    await withStore(key, (store) => produceLedger(store, identity));
    if (change === 'missing') await env.BUCKET.delete(tableKeyFor(key, T));
    else await env.BUCKET.put(tableKeyFor(key, T), TABLE, { httpMetadata: { contentType: 'application/json' } });
    const view = await withStore(key, (store) => store.read(key, H));
    expect(view.ledgers[T]).toEqual({ kind: 'failed-transient', code });
    expect(view.selected).toEqual({ kind: 'unknown' });
  });

  it('T04 after a transient failure the next admitted job becomes the writer at its Tp', async () => {
    const { key, identity } = await ledgerCase();
    await withStore(key, async (store) => {
      await store.failLedger(identity, T, 'resource_exhausted');
      expect((await store.read(key, H)).ledgers[T]).toEqual({ kind: 'failed-transient', code: 'resource_exhausted' });
      expect((await jobB(store, key)).writer).toBe(true);
      expect((await store.read(key, H)).ledgers[T]).toEqual({ kind: 'pending', writer: 'job-b', writerArchived: false, waiters: [] });
    });
  });

  it('T05 after a content failure a later job does not write and its candidate fails with that code', async () => {
    const { key, identity } = await ledgerCase();
    await withStore(key, async (store) => {
      await store.failLedger(identity, T, 'invalid_edit');
      expect((await jobB(store, key)).writer).toBe(false);
      const view = await store.read(key, H);
      expect(view.ledgers[T]).toEqual({ kind: 'failed-content', code: 'invalid_edit' });
      expect(view.candidate).toMatchObject({ jobId: 'job-b', state: 'failed', failure: 'invalid_edit' });
    });
  });

  it('T07 the writer\'s expiry is a transient failure', async () => {
    const { key, identity } = await ledgerCase();
    await withStore(key, async (store) => {
      await store.failLedger(identity, T, 'expired');
      expect((await store.read(key, H)).ledgers[T]).toEqual({ kind: 'failed-transient', code: 'expired' });
    });
  });

  it('T08 a ready instance is reused by a later job without a new writer or receipt', async () => {
    const { key, identity } = await ledgerCase();
    await withStore(key, async (store) => {
      const measured = await produceLedger(store, identity);
      expect((await jobB(store, key)).writer).toBe(false);
      expect((await store.read(key, H)).ledgers[T]).toEqual({ kind: 'ready', receipt: await expectedReceipt(key, 'job-a', measured) });
    });
  });

  it('T10 once a later job writes, the superseded job\'s commit is refused', async () => {
    const { key, identity } = await ledgerCase();
    await withStore(key, async (store) => {
      const claim = (await store.claimSourceLedger(identity, T, DECLARATION))!;
      const measured = await putLedger(claim, 'job-a');
      expect((await jobB(store, key)).writer).toBe(true);
      expect(await store.commitLedger(identity, T, claim.owner, measured)).toBe(false);
      expect((await store.read(key, H)).ledgers[T]).toMatchObject({ kind: 'pending', writer: 'job-b' });
    });
  });

  it('T11 two concurrent admissions after a transient failure leave one current job', async () => {
    const { key, identity } = await ledgerCase();
    await withStore(key, async (store) => {
      await store.failLedger(identity, T, 'resource_exhausted');
      const views = await Promise.all([store.accept(admission(key, 'job-b')), store.accept(admission(key, 'job-b'))]);
      expect(views.map((view) => view.candidate.jobId)).toEqual(['job-b', 'job-b']);
      expect((await store.read(key, H)).archive.map((record) => record.jobId)).toEqual(['job-a']);
    });
  });

  it('T12 another toolInputId is another instance and leaves T as it is', async () => {
    const { key, identity } = await ledgerCase();
    await withStore(key, async (store) => {
      await store.accept(admission(key, 'job-b'));
      const { token } = await store.prepare({ storageKey: key, sourceFingerprint: H, jobId: 'job-b', deadlineAt: D }, NOW);
      const b = { ...identity, jobId: 'job-b', token: token! };
      expect((await store.planPresentation(b, { route: 'encode', toolInputId: T2, planSha256: 'e'.repeat(64) })).writer).toBe(true);
      const view = await store.read(key, H);
      expect(view.ledgers[T2]).toEqual({ kind: 'pending', writer: 'job-b', writerArchived: false, waiters: [] });
      expect(view.ledgers[T]).toEqual({ kind: 'pending', writer: 'job-a', writerArchived: true, waiters: [] });
    });
  });

  it('T13 without a plan there is no instance: claims, commits and failures are refused', async () => {
    const { key } = await ledgerCase();
    await withStore(key, async (store) => {
      await store.accept(admission(key, 'job-b'));
      const { token } = await store.prepare({ storageKey: key, sourceFingerprint: H, jobId: 'job-b', deadlineAt: D }, NOW);
      const b = { storageKey: key, sourceFingerprint: H, jobId: 'job-b', deadlineAt: D, token: token! };
      expect(await store.claimSourceLedger(b, T2, DECLARATION)).toBeNull();
      expect(await store.failLedger(b, T2, 'invalid_edit')).toBe(false);
      expect((await store.read(key, H)).ledgers[T2]).toBeUndefined();
    });
  });

  // S6e E4-7 (design §5.1 step 5, §7.15 registry rows 14/15): full and compact are stored per toolInputId, so a frozen
  // execution that pinned L(T) still reads the bytes it froze after another plan of the same source writes L(T2).
  it('T14 the ledger of another toolInputId is written to its own objects and leaves the ready L(T) bytes and receipt as they were', async () => {
    const { key, identity } = await ledgerCase();
    await withStore(key, async (store) => {
      const measuredT = await produceLedger(store, identity);
      const receiptT = await expectedReceipt(key, 'job-a', measuredT);
      await store.accept(admission(key, 'job-b'));
      const { token } = await store.prepare({ storageKey: key, sourceFingerprint: H, jobId: 'job-b', deadlineAt: D }, NOW);
      const b = { ...identity, jobId: 'job-b', token: token! };
      expect((await store.planPresentation(b, { route: 'encode', toolInputId: T2, planSha256: 'e'.repeat(64) })).writer).toBe(true);
      const claim = (await store.claimSourceLedger(b, T2, DECLARATION))!;
      expect(claim).toMatchObject({ key: fullKeyFor(key, T2), priorETag: null, table: { key: tableKeyFor(key, T2), priorETag: null } });
      // Same lengths, other bytes: identical bytes would keep miniflare's MD5 etag and hide an overwrite.
      const encode = (bytes: Uint8Array): Uint8Array => new TextEncoder().encode(new TextDecoder().decode(bytes).replaceAll(T, T2));
      const measuredT2 = await putLedger(claim, 'job-b', { table: encode(TABLE), full: encode(FULL) });
      expect(await store.commitLedger(b, T2, claim.owner, measuredT2)).toBe(true);
      expect((await env.BUCKET.head(fullKeyFor(key, T)))!.etag).toBe(measuredT.etag);
      expect((await env.BUCKET.head(tableKeyFor(key, T)))!.etag).toBe(measuredT.table.etag);
      const view = await store.read(key, H);
      expect(view.ledgers[T]).toEqual({ kind: 'ready', receipt: receiptT });
      expect(view.ledgers[T2]).toMatchObject({ kind: 'ready', receipt: { toolInputId: T2, url: `https://assets.example.test/${fullKeyFor(key, T2)}`, table: { url: `https://assets.example.test/${tableKeyFor(key, T2)}` } } });
    });
  });

  it('T15 the ready check of L(T) reads its own objects: removing only the toolInputId-less legacy keys changes nothing', async () => {
    const { key, identity } = await ledgerCase();
    const measured = await withStore(key, (store) => produceLedger(store, identity));
    expect(fullKeyFor(key, T)).not.toBe(`${key}.video-source-ledger.v1.json`);
    await env.BUCKET.delete([`${key}.video-source-ledger.v1.json`, `${key}.video-presentation-table.v1.json`]);
    const view = await withStore(key, (store) => store.read(key, H));
    expect(view.ledgers[T]).toEqual({ kind: 'ready', receipt: await expectedReceipt(key, 'job-a', measured) });
  });
});
