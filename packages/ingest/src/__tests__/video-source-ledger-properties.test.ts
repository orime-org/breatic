// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Fact-A invariants from inner#1306 design §10.2, over actual DO storage and R2.
 * The model uses literal transition rules, independently of the production classifier.
 */

import { env } from 'cloudflare:test';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { VideoSourceLedgerStateV2 } from '@breatic/shared';
import { bytesFor, fixture, ORIGINAL, putClaim, receipt, tableKeyFor, type LedgerFixture } from './helpers/source-ledger-fixture.js';

const opaque = { codecName: 'vp9', pixelFormat: 'yuv420p', pixelAlpha: 0 as const, alphaMode: null, formatName: 'matroska,webm', videoStreamIndex: 0 };
// Design §10.6: limits frozen at admission (`resource_limit`) are content; real exhaustion (`resource_exhausted`) is transient.
const events = ['admit', 'produce', 'invalidate', 'expired', 'resource_exhausted', 'resource_limit', 'unsupported_rate', 'no_presented_frames'] as const;

/** Make playback ready while the independently owned ledger remains pending. @throws {Error} When the real store refuses the probe. */
async function playbackReady(value: LedgerFixture): Promise<void> {
  expect(await value.owner.report({ ...value.identity, kind: 'probe', classification: 'confirmed_opaque', original: ORIGINAL, evidence: opaque })).toBe(true);
}

/** Finish one producer with fixed measured usage. @throws {Error} When the real store refuses the report. */
async function finish(value: LedgerFixture): Promise<void> {
  expect(await value.owner.report({ ...value.identity, kind: 'finished', usage: { wallMs: 100, cpuUsec: 1 } })).toBe(true);
}

/** Prepare an admitted retry and bind its bytes to its new identity. @throws {Error} When preparation fails. */
async function prepareRetry(value: LedgerFixture, jobId: string): Promise<LedgerFixture> {
  const admission = { ...value.admission, jobId };
  const prepared = await value.owner.prepare(admission);
  expect(prepared.admission?.jobId).toBe(jobId);
  expect(prepared.token).toEqual(expect.any(String));
  const identity = { ...value.identity, jobId, token: prepared.token! };
  const bytes = bytesFor(identity);
  return { ...value, admission, identity, bytes, declaration: { ...value.declaration, byteLength: bytes.length } };
}

/** Model a new pending ledger under the accepted producer. @throws {never} No IO is performed. */
function pending(value: LedgerFixture): VideoSourceLedgerStateV2 {
  return { state: 'pending', schemaVersion: 2, producerVersion: 2, sourceFingerprint: value.identity.sourceFingerprint,
    attempt: { jobId: value.identity.jobId, deadlineAt: value.identity.deadlineAt } };
}

/** Assert source ownership and the playback-independent expected ledger after every event. @throws {Error} When an invariant fails. */
async function assertFacts(value: LedgerFixture, expected: VideoSourceLedgerStateV2, presentation: unknown): Promise<void> {
  const actual = await value.owner.read(value.admission.storageKey, value.identity.sourceFingerprint);
  expect(actual.sourceLedger).toEqual(expected);
  expect(actual.presentation).toEqual(presentation);
  if (actual.sourceLedger?.state === 'ready') {
    expect(actual.sourceLedger.receipt.sourceFingerprint).toBe(value.identity.sourceFingerprint);
    expect(actual.sourceLedger.receipt.table.url).toBe(value.admission.sourceLedgerTableURL);
  } else {
    expect(actual.sourceLedger?.sourceFingerprint).toBe(value.identity.sourceFingerprint);
    expect(actual.sourceLedger?.attempt.jobId).toBe(actual.attempt?.jobId);
  }
}

describe('source ledger state properties (inner#1306 fact A)', () => {
  it('preserves the transition model and playback across arbitrary ledger event sequences', async () => {
    await fc.assert(fc.asyncProperty(fc.array(fc.constantFrom(...events), { minLength: 1, maxLength: 16 }), async (sequence) => {
      let value = await fixture();
      await playbackReady(value);
      const presentation = (await value.owner.read(value.admission.storageKey, value.identity.sourceFingerprint)).presentation;
      expect(presentation?.state).toBe('native');
      let expected = pending(value);
      for (const [index, event] of sequence.entries()) {
        if (event === 'admit') {
          const nextJob = `${value.identity.jobId}-retry-${index}`;
          const retryable = expected.state === 'failed' && ['expired', 'resource_exhausted', 'source_ledger_missing'].includes(expected.errorCode);
          const accepted = await value.owner.accept({ ...value.admission, jobId: nextJob });
          expect(accepted.attempt?.jobId).toBe(retryable ? nextJob : value.identity.jobId);
          if (retryable) {
            const prior = value;
            value = await prepareRetry(value, nextJob);
            expected = pending(value);
            expect(await prior.owner.report({ ...prior.identity, kind: 'source_ledger_failed', error: 'unsupported_rate' })).toBe(false);
          }
        } else if (event === 'produce') {
          if (expected.state === 'pending') {
            const claim = await value.owner.claimSourceLedger(value.identity, value.declaration);
            expect(claim).not.toBeNull();
            const measured = await putClaim(value, claim!);
            expect(await value.owner.completeSourceLedger(value.identity, claim!.owner, measured)).toBe(true);
            expected = { state: 'ready', receipt: await receipt(value, measured) };
            await finish(value);
          }
        } else if (event === 'invalidate') {
          if (expected.state === 'ready') {
            await env.BUCKET.delete(tableKeyFor(value.admission.storageKey));
            expected = { state: 'failed', schemaVersion: 2, producerVersion: 2, sourceFingerprint: value.identity.sourceFingerprint,
              attempt: expected.receipt.attempt, errorCode: 'source_ledger_missing' };
          }
        } else {
          expect(await value.owner.report({ ...value.identity, kind: 'source_ledger_failed', error: event })).toBe(true);
          if (expected.state === 'pending') expected = { ...expected, state: 'failed', errorCode: event };
          await finish(value);
        }
        await assertFacts(value, expected, presentation);
      }
    }), { numRuns: 20, examples: [
      [['expired', 'admit', 'produce', 'expired', 'invalidate', 'admit', 'produce']],
      [['unsupported_rate', 'admit', 'resource_limit', 'produce']],
      [['no_presented_frames', 'admit']],
    ] });
  });

  it('shares one accepted retry and one write claim across arbitrary concurrent callers', async () => {
    await fc.assert(fc.asyncProperty(fc.integer({ min: 2, max: 6 }), async (count) => {
      const value = await fixture();
      await playbackReady(value);
      expect(await value.owner.report({ ...value.identity, kind: 'source_ledger_failed', error: 'expired' })).toBe(true);
      await finish(value);
      const jobs = Array.from({ length: count }, (_, index) => `${value.identity.jobId}-${index}`);
      const accepted = await Promise.all(jobs.map(jobId => value.owner.accept({ ...value.admission, jobId })));
      const winner = accepted[0]!.attempt!.jobId;
      expect(jobs).toContain(winner);
      for (const answer of accepted) {
        expect(answer).toEqual(accepted[0]);
        expect(answer.sourceLedger).toMatchObject({ state: 'pending', attempt: { jobId: winner } });
      }
      for (const loser of jobs.filter(jobId => jobId !== winner)) {
        expect((await value.owner.prepare({ ...value.admission, jobId: loser })).admission).toBeNull();
      }
      const current = await prepareRetry(value, winner);
      const claims = await Promise.all(jobs.map(() => current.owner.claimSourceLedger(current.identity, current.declaration)));
      expect(claims.filter(claim => claim !== null)).toHaveLength(1);
    }), { numRuns: 8 });
  });

  it('refuses superseded producer facts after arbitrary source replacements', async () => {
    await fc.assert(fc.asyncProperty(fc.array(fc.constantFrom('a', 'b', 'c', 'd'), { minLength: 2, maxLength: 6 }), async (sources) => {
      let value = await fixture();
      const retired: LedgerFixture['identity'][] = [];
      for (const [index, prefix] of sources.entries()) {
        const admission = { ...value.admission, jobId: `${value.identity.jobId}-source-${index}`, sourceFingerprint: prefix.repeat(64) };
        if (admission.sourceFingerprint === value.identity.sourceFingerprint) {
          await value.owner.fail(value.identity, 'expired');
        }
        retired.push(value.identity);
        const accepted = await value.owner.accept(admission);
        expect(accepted.attempt?.jobId).toBe(admission.jobId);
        const prepared = await value.owner.prepare(admission);
        expect(prepared.token).toEqual(expect.any(String));
        value = { ...value, admission, identity: { sourceFingerprint: admission.sourceFingerprint, jobId: admission.jobId,
          deadlineAt: admission.deadlineAt, token: prepared.token! } };
        for (const old of retired) {
          expect(await value.owner.report({ ...old, kind: 'source_ledger_failed', error: 'unsupported_rate' })).toBe(false);
          expect(await value.owner.claimSourceLedger(old, value.declaration)).toBeNull();
        }
        const read = await value.owner.read(admission.storageKey, admission.sourceFingerprint);
        expect(read.sourceLedger).toEqual(pending(value));
      }
    }), { numRuns: 10 });
  });
});
