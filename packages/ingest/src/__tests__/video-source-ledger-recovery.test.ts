// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Physical checks of a ready ledger and the L' H2 recovery over real storage and
 * R2 (inner#1306, test plan §89 rewrite of H01–H10; frames-split design §7.3,
 * §7.4 Check and L').
 *
 * A ready instance whose stored objects no longer carry the committed bytes,
 * digest or claim owner turns failed-transient on read; an old measurement after
 * a real external replacement is refused. An archived job's completed stream is
 * recorded beside the current instance and attached only when the current work
 * is terminal, no writer is active, nothing current is ready, and the
 * toolInputId and plan are the same.
 */

import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { fullKeyFor } from './helpers/source-ledger-fixture.js';
import { admission, D, DECLARATION, expectedReceipt, FULL, H, ledgerCase, NOW, PLAN, produceLedger, putLedger, T, withStore, type Identity, type MachineStore } from './helpers/machine-store.js';

/**
 * Admit, start and plan job b for T.
 * @param store - The store.
 * @param key - The source key.
 * @returns Job b.
 */
async function jobB(store: MachineStore, key: string): Promise<Identity> {
  await store.accept(admission(key, 'job-b'));
  const { token } = await store.prepare({ storageKey: key, sourceFingerprint: H, jobId: 'job-b', deadlineAt: D }, NOW);
  const b = { storageKey: key, sourceFingerprint: H, jobId: 'job-b', deadlineAt: D, token: token! };
  expect((await store.planPresentation(b, { route: 'encode', toolInputId: T, planSha256: PLAN })).writer).toBe(true);
  return b;
}

describe('ready ledger checks and L\' recovery (inner#1306 §7.4)', () => {
  it('a ready ledger whose identical bytes now carry a foreign claim owner reads as failed-transient invalid', async () => {
    const { key, identity } = await ledgerCase();
    await withStore(key, (store) => produceLedger(store, identity));
    await env.BUCKET.put(fullKeyFor(key, T), FULL, { httpMetadata: { contentType: 'application/json' }, customMetadata: { sourceLedgerJobId: 'job-a', sourceLedgerClaimOwner: 'foreign' } });
    expect((await withStore(key, (store) => store.read(key, H))).ledgers[T]).toEqual({ kind: 'failed-transient', code: 'source_ledger_invalid' });
  });

  it('a ready ledger whose same-size bytes changed reads as failed-transient invalid', async () => {
    const { key, identity } = await ledgerCase();
    await withStore(key, (store) => produceLedger(store, identity));
    const changed = new Uint8Array(FULL.length).fill(32);
    await env.BUCKET.put(fullKeyFor(key, T), changed, { httpMetadata: { contentType: 'application/json' } });
    expect((await withStore(key, (store) => store.read(key, H))).ledgers[T]).toEqual({ kind: 'failed-transient', code: 'source_ledger_invalid' });
  });

  it('refuses an old measurement after a real external replacement of the full object', async () => {
    const { key, identity } = await ledgerCase();
    await withStore(key, async (store) => {
      const claim = (await store.claimSourceLedger(identity, T, DECLARATION))!;
      const measured = await putLedger(claim, 'job-a');
      // Same length and metadata, one byte flipped: miniflare's R2 etag is the content MD5, so identical bytes would not differ (§7.3).
      const changed = FULL.slice();
      changed[changed.length - 1]! ^= 1;
      const replaced = await env.BUCKET.put(fullKeyFor(key, T), changed, { httpMetadata: { contentType: 'application/json' }, customMetadata: { sourceLedgerJobId: 'job-a', sourceLedgerClaimOwner: claim.owner } });
      expect(replaced.etag).not.toBe(measured.etag);
      expect(await store.commitLedger(identity, T, claim.owner, measured)).toBe(false);
      expect((await store.read(key, H)).ledgers[T]!.kind).toBe('pending');
    });
  });

  it('attaches an archived job\'s completed receipt once the current work is terminal with no writer and nothing ready', async () => {
    const { key, identity: a } = await ledgerCase();
    await withStore(key, async (store) => {
      const claim = (await store.claimSourceLedger(a, T, DECLARATION))!;
      const measured = await putLedger(claim, 'job-a');
      const b = await jobB(store, key);
      expect(await store.commitLedger(a, T, claim.owner, measured)).toBe(false);
      expect((await store.read(key, H)).ledgers[T]).toMatchObject({ kind: 'pending', writer: 'job-b' });
      await store.failLedger(b, T, 'resource_exhausted');
      await store.fail(b, 'expired');
      expect((await store.read(key, H)).ledgers[T]).toEqual({ kind: 'ready', receipt: await expectedReceipt(key, 'job-a', measured) });
    });
  });

  it('does not attach an archived receipt while the current work is still running', async () => {
    const { key, identity: a } = await ledgerCase();
    await withStore(key, async (store) => {
      const claim = (await store.claimSourceLedger(a, T, DECLARATION))!;
      const measured = await putLedger(claim, 'job-a');
      const b = await jobB(store, key);
      await store.commitLedger(a, T, claim.owner, measured);
      await store.failLedger(b, T, 'resource_exhausted');
      expect((await store.read(key, H)).ledgers[T]).toEqual({ kind: 'failed-transient', code: 'resource_exhausted' });
    });
  });
});
