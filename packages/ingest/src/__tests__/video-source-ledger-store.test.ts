// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Ledger capability beside the selected bundle over real storage and R2
 * (inner#1306, test plan §89 rewrite of the source-ledger store cases;
 * frames-split design §3.2 item 1, §7.2, §7.4).
 *
 * Kept from the earlier cases: budgets are frozen at admission and a replay does
 * not widen them, a claim checks every original identity field, and only one
 * writer holds a claim. Recast: P and L are independent facts, so a ready P does
 * not finish L and an L failure does not change P (§7.4 "L与载体互不等待").
 */

import { describe, expect, it } from 'vitest';
import { LEDGER_LIMITS } from './helpers/source-ledger-fixture.js';
import { admission, bundle, DECLARATION, H, ledgerCase, NOW, PLAN, source, T, withStore } from './helpers/machine-store.js';

describe('ledger capability and the selected bundle (inner#1306 §7.4)', () => {
  it('freezes the ledger budgets of the first admission; a replay with larger budgets does not widen them', async () => {
    const key = await source();
    await withStore(key, async (store) => {
      const small = admission(key, 'job-a');
      small.limits = { ...small.limits!, sourceLedger: { ...LEDGER_LIMITS, maxBytes: DECLARATION.byteLength - 1 } };
      await store.accept(small);
      await store.accept(admission(key, 'job-a'));
      const { token } = await store.prepare({ storageKey: key, sourceFingerprint: H, jobId: 'job-a', deadlineAt: small.deadlineAt }, NOW);
      const identity = { storageKey: key, sourceFingerprint: H, jobId: 'job-a', deadlineAt: small.deadlineAt, token: token! };
      await store.planPresentation(identity, { route: 'encode', toolInputId: T, planSha256: PLAN });
      expect(await store.claimSourceLedger(identity, T, DECLARATION)).toBeNull();
    });
  });

  it.each(['jobId', 'sourceFingerprint', 'deadlineAt', 'token'] as const)('checks the original %s before granting a ledger claim', async (field) => {
    const { key, identity } = await ledgerCase();
    await withStore(key, async (store) => {
      const altered = { ...identity, [field]: field === 'deadlineAt' ? identity.deadlineAt + 1 : field === 'sourceFingerprint' ? 'f'.repeat(64) : `${identity[field]}-other` };
      expect(await store.claimSourceLedger(altered, T, DECLARATION)).toBeNull();
      expect(await store.claimSourceLedger(identity, T, DECLARATION)).not.toBeNull();
    });
  });

  it('a ready P does not make its ledger ready: L stays pending until its own commit', async () => {
    const key = await source();
    await withStore(key, async (store) => {
      await store.accept(admission(key, 'job-a'));
      const { token } = await store.prepare({ storageKey: key, sourceFingerprint: H, jobId: 'job-a', deadlineAt: admission(key, 'job-a').deadlineAt }, NOW);
      const identity = { storageKey: key, sourceFingerprint: H, jobId: 'job-a', deadlineAt: admission(key, 'job-a').deadlineAt, token: token! };
      await store.planPresentation(identity, { route: 'identity', toolInputId: T, planSha256: PLAN });
      const view = await store.report(identity, { kind: 'verified', bundle: await bundle(key, 'e'.repeat(64)) });
      expect(view.selected.kind).toBe('ready');
      expect(view.ledgers[T]).toEqual({ kind: 'pending', writer: 'job-a', writerArchived: false, waiters: [] });
    });
  });

  it('a ledger failure does not change a ready P', async () => {
    const key = await source();
    await withStore(key, async (store) => {
      await store.accept(admission(key, 'job-a'));
      const { token } = await store.prepare({ storageKey: key, sourceFingerprint: H, jobId: 'job-a', deadlineAt: admission(key, 'job-a').deadlineAt }, NOW);
      const identity = { storageKey: key, sourceFingerprint: H, jobId: 'job-a', deadlineAt: admission(key, 'job-a').deadlineAt, token: token! };
      await store.planPresentation(identity, { route: 'identity', toolInputId: T, planSha256: PLAN });
      await store.report(identity, { kind: 'verified', bundle: await bundle(key, 'e'.repeat(64)) });
      await store.failLedger(identity, T, 'invalid_edit');
      const view = await store.read(key, H);
      expect(view.selected).toEqual({ kind: 'ready', version: { versionId: 'e'.repeat(64), toolInputId: T } });
      expect(view.ledgers[T]).toEqual({ kind: 'failed-content', code: 'invalid_edit' });
    });
  });
});
