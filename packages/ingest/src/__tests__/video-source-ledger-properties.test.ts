// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Ledger instance invariants across random event sequences over the real store
 * (inner#1306, test plan §89 rewrite; frames-split design §7.4 invariants and
 * arbitration; the same model as the pure LP01 property).
 *
 * After every event: a pending instance has exactly one writer that is not
 * among its waiters; it turned ready only through a commit by its writer at that
 * moment; candidate codes are never stored; a failure from a job that is not the
 * writer changes nothing; and P never changes because of ledger events.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { admission, D, DECLARATION, H, PLAN, putLedger, source, T, withStore, type Identity, type Instance, type MachineStore } from './helpers/machine-store.js';

type Step = { kind: 'admit'; job: string } | { kind: 'plan' } | { kind: 'write'; job: string } | { kind: 'fail-ledger'; job: string; code: string } | { kind: 'fail'; code: string };
const CANDIDATE_CODES = ['too_long', 'packed_over_cap', 'packed_clock_mismatch'];

/**
 * The pending writer of an instance, if any.
 * @param instance - The instance.
 * @returns The writer.
 */
function writerOf(instance: Instance | undefined): string | null {
  return instance?.kind === 'pending' ? instance.writer : null;
}

describe('ledger instance invariants over the store (inner#1306 §7.4)', () => {
  it('one writer, ready only from the writer\'s commit, candidate codes never stored, foreign failures ignored, P untouched (property)', async () => {
    const step: fc.Arbitrary<Step> = fc.oneof(
      fc.record({ kind: fc.constant('admit' as const), job: fc.constantFrom('job-a', 'job-b', 'job-c') }),
      fc.constant({ kind: 'plan' as const }),
      fc.record({ kind: fc.constant('write' as const), job: fc.constantFrom('job-a', 'job-b', 'job-c') }),
      fc.record({ kind: fc.constant('fail-ledger' as const), job: fc.constantFrom('job-a', 'job-b', 'job-c'), code: fc.constantFrom('resource_exhausted', 'invalid_edit', 'too_long', 'packed_over_cap') }),
      fc.record({ kind: fc.constant('fail' as const), code: fc.constantFrom('expired', 'too_long') }),
    );
    await fc.assert(fc.asyncProperty(fc.array(step, { minLength: 1, maxLength: 12 }), async (steps) => {
      const key = await source();
      await withStore(key, async (store: MachineStore) => {
        const tokens = new Map<string, Identity>();
        let current: string | null = null;
        for (const item of [{ kind: 'admit', job: 'job-a' } as Step, ...steps]) {
          const before = (await store.read(key, H)).ledgers[T];
          if (item.kind === 'admit') {
            await store.accept(admission(key, item.job));
            const { token } = await store.prepare({ storageKey: key, sourceFingerprint: H, jobId: item.job, deadlineAt: D }, Date.now());
            if (token !== null) { tokens.set(item.job, { storageKey: key, sourceFingerprint: H, jobId: item.job, deadlineAt: D, token }); current = item.job; }
          } else if (item.kind === 'plan' && current !== null && tokens.has(current)) {
            await store.planPresentation(tokens.get(current)!, { route: 'encode', toolInputId: T, planSha256: PLAN });
          } else if (item.kind === 'write' && tokens.has(item.job)) {
            const identity = tokens.get(item.job)!;
            const claim = await store.claimSourceLedger(identity, T, DECLARATION);
            if (claim !== null) {
              expect(writerOf(before)).toBe(item.job);
              await store.commitLedger(identity, T, claim.owner, await putLedger(claim, item.job));
            }
          } else if (item.kind === 'fail-ledger' && tokens.has(item.job)) {
            await store.failLedger(tokens.get(item.job)!, T, item.code);
            if (writerOf(before) !== item.job) expect((await store.read(key, H)).ledgers[T]).toEqual(before);
          } else if (item.kind === 'fail' && current !== null && tokens.has(current)) {
            await store.fail(tokens.get(current)!, item.code);
          }
          const view = await store.read(key, H);
          const after = view.ledgers[T];
          if (after?.kind === 'pending') expect(after.waiters).not.toContain(after.writer);
          if (after?.kind === 'ready' && before?.kind !== 'ready') {
            expect(item.kind).toBe('write');
            expect(writerOf(before)).toBe((item as { job: string }).job);
          }
          if (after?.kind === 'failed-transient' || after?.kind === 'failed-content') expect(CANDIDATE_CODES).not.toContain(after.code);
          expect(view.selected).toEqual({ kind: 'unknown' });
        }
      });
    }), { seed: 130906, numRuns: 15 });
  });
});
