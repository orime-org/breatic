// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The presentation Durable Object state machine as pure transitions (inner#1306,
 * test plan §66; frames-split design §7.1 candidate A/A', §7.1.1 chunk set, §7.2
 * selected bundle P, §7.3 R2 object roles). The companion frame table L and its
 * cases went with the frame-grid schema replacement (§3.4).
 *
 * Each section's table is one pure function, the single write point that the
 * store then persists: `advancePresentationCandidate`, `advancePresentationChunk`,
 * `advanceSelectedPresentation` and `advancePresentationObject`. A cell written 「拒」 in
 * the design returns `rejected: true` with the state unchanged; a 「保持」/「忽略」
 * cell returns the state unchanged with `rejected: false`. Expected values come
 * from the design tables only.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import * as machine from '../video-presentation-state.js';

type Route = 'encode' | 'edit' | 'reuse_edit' | 'reuse';
interface Candidate {
  state: 'none' | 'accepted' | 'building' | 'verified' | 'failed';
  archived: boolean;
  jobId: string | null;
  deadlineAt: number | null;
  route: Route | null;
  stage: string | null;
  toolInputId: string | null;
  pinned: boolean;
  failure: string | null;
  autoRepairs: number;
}
type CandidateEvent =
  | { kind: 'Ad'; jobId: string; deadlineAt: number }
  | { kind: 'St'; jobId: string; now: number }
  | { kind: 'Sg'; jobId: string; stage: string }
  | { kind: 'Ev'; jobId: string; fact: { kind: 'plan'; route: Route; toolInputId: string | null } | { kind: 'tool-input'; toolInputId: string } | { kind: 'verified' } }
  | { kind: 'Er'; jobId: string; code: string }
  | { kind: 'Ar' }
  | { kind: 'Rt'; jobId: string; deadlineAt: number };
type CandidateEffect = { kind: 'dispatch'; stage: string } | { kind: 'publish'; toolInputId: string } | { kind: 'recheck-publish'; toolInputId: string };
interface Step<T, E> { next: T; effects: E[]; rejected: boolean }

interface AttemptItem { attempt: number; jobId: string; state: 'pending' | 'done' | 'failed'; usage: number | null; usageRecorded: boolean; failure: string | null }
interface Chunk { state: 'none' | 'open' | 'done' | 'failed'; attempt: number; retries: number; failure: string | null; attempts: AttemptItem[] }
type ChunkEvent =
  | { kind: 'Sub'; retries: number }
  | { kind: 'Done'; attempt: number; usage: number }
  | { kind: 'Fail'; attempt: number; code: string; usage: number | null }
  | { kind: 'Exp' }
  | { kind: 'Rec'; attempt: number };
type ChunkEffect = { kind: 'dispatch'; jobId: string } | { kind: 'chunk-done' } | { kind: 'candidate-failed'; code: string };
type ChunkIdentity =
  | { kind: 'presentation-count'; jobId: string } | { kind: 'presentation-chunk'; jobId: string; chunk: number } | { kind: 'presentation-stitch'; jobId: string }
  | { kind: 'presentation-edit'; jobId: string; chunk: number } | { kind: 'presentation-edit-stitch'; jobId: string };

interface Version { versionId: string; toolInputId: string }
type Selection = { kind: 'unknown' } | { kind: 'ready'; version: Version } | { kind: 'invalid'; version: Version };
type SelectionEvent =
  | { kind: 'Pub'; candidate: Version; complete: boolean; current: boolean }
  | { kind: 'Chk'; proof: 'complete' | 'head-only' | 'none'; version: Version }
  | { kind: 'Bad' } | { kind: 'New' } | { kind: 'Src' } | { kind: 'Late'; version: Version };
interface SelectionStep { next: Selection; published: boolean; waiting: boolean }

type ObjectKind = 'absent' | 'writing' | 'complete' | 'measured' | 'published' | 'invalid';
interface StoredObject { kind: ObjectKind; role: 'R0' | 'other'; receipt: string | null }
type ObjectEvent =
  | { kind: 'Begin'; authorized: boolean }
  | { kind: 'Put'; won: boolean }
  | { kind: 'Measure'; matches: boolean; receipt: string }
  | { kind: 'Publish'; ok: boolean; receipt: string }
  | { kind: 'Stop'; committed: boolean | 'unknown' }
  | { kind: 'Verify'; complete: boolean; matches: boolean; receipt: string }
  | { kind: 'Replace'; receipt: string };

interface MachineApi {
  advancePresentationCandidate: (record: Candidate, event: CandidateEvent) => Step<Candidate, CandidateEffect>;
  advancePresentationChunk: (chunk: Chunk, event: ChunkEvent, identity: ChunkIdentity) => Step<Chunk, ChunkEffect>;
  presentationChunksUsageRecorded: (chunks: readonly Chunk[]) => boolean;
  advanceSelectedPresentation: (state: Selection, event: SelectionEvent) => SelectionStep;
  advancePresentationObject: (object: StoredObject, event: ObjectEvent) => { next: StoredObject; rejected: boolean };
}

const api = machine as unknown as Partial<MachineApi>;

/**
 * Read one transition from the presentation state module, failing when it does not exist yet.
 * @param name - The export name.
 * @returns The export.
 * @throws {Error} When the export is missing.
 */
function required<K extends keyof MachineApi>(name: K): MachineApi[K] {
  const value = api[name];
  expect(value, `${name} is exported from video-presentation-state`).toBeDefined();
  return value as MachineApi[K];
}

const JOB = 'job-1';
const D = 1_900_000_000_000;
const T = 'c'.repeat(64);
const T2 = 'b'.repeat(64);
// Config value (design §5.4 配置初值): encoding.chunk_retries, 3.
const CHUNK_RETRIES = 3;

const NONE: Candidate = { state: 'none', archived: false, jobId: null, deadlineAt: null, route: null, stage: null, toolInputId: null, pinned: false, failure: null, autoRepairs: 0 };
const ACCEPTED: Candidate = { ...NONE, state: 'accepted', jobId: JOB, deadlineAt: D };
const BUILDING_PLAN: Candidate = { ...ACCEPTED, state: 'building', stage: 'plan' };
const PLANNED_ENCODE: Candidate = { ...BUILDING_PLAN, route: 'encode', toolInputId: T, pinned: true };
const PLANNED_REUSE: Candidate = { ...BUILDING_PLAN, route: 'reuse', toolInputId: T, pinned: true };
const VERIFIED: Candidate = { ...PLANNED_ENCODE, state: 'verified', stage: 'stitch' };
const FAILED: Candidate = { ...PLANNED_ENCODE, state: 'failed', failure: 'too_long', pinned: false };

/**
 * Apply one candidate event.
 * @param record - The record.
 * @param event - The event.
 * @returns The step.
 */
function candidate(record: Candidate, event: CandidateEvent): Step<Candidate, CandidateEffect> {
  return required('advancePresentationCandidate')(record, event);
}

/**
 * Assert a 「拒」 cell: rejected and unchanged.
 * @param step - The step.
 * @param before - The prior state.
 */
function expectRejected<T, E>(step: Step<T, E> | { next: T; rejected: boolean }, before: T): void {
  expect(step.rejected).toBe(true);
  expect(step.next).toEqual(before);
}

/**
 * Assert a 「保持」 cell: unchanged, not rejected, no effects.
 * @param step - The step.
 * @param before - The prior state.
 */
function expectKept<T, E>(step: Step<T, E>, before: T): void {
  expect(step.rejected).toBe(false);
  expect(step.next).toEqual(before);
  expect(step.effects).toEqual([]);
}

describe('A §7.1 candidate: none and accepted rows', () => {
  it('A01 none × Ad accepts and freezes the original job and deadline', () => {
    const step = candidate(NONE, { kind: 'Ad', jobId: JOB, deadlineAt: D });
    expect(step).toEqual({ next: ACCEPTED, effects: [], rejected: false });
  });

  it.each([
    ['St', { kind: 'St', jobId: JOB, now: D - 1 }], ['Sg', { kind: 'Sg', jobId: JOB, stage: 'encode' }],
    ['Ev', { kind: 'Ev', jobId: JOB, fact: { kind: 'verified' } }],
  ] as const)('A02 none × %s is refused: there is no admission', (_, event) => {
    expectRejected(candidate(NONE, event), NONE);
  });

  it.each([
    ['Er', { kind: 'Er', jobId: JOB, code: 'expired' }], ['Ar', { kind: 'Ar' }],
  ] as const)('A03 none × %s keeps none', (_, event) => {
    expectKept(candidate(NONE, event), NONE);
  });

  it('A04 none × Rt is a new admission', () => {
    expect(candidate(NONE, { kind: 'Rt', jobId: JOB, deadlineAt: D }).next).toEqual(ACCEPTED);
  });

  it('A05 accepted × Ad of the same job replays without resetting the deadline', () => {
    expectKept(candidate(ACCEPTED, { kind: 'Ad', jobId: JOB, deadlineAt: D + 7_200_000 }), ACCEPTED);
  });

  it('A06 accepted × St starts building only while current and before the deadline', () => {
    expect(candidate(ACCEPTED, { kind: 'St', jobId: JOB, now: D - 1 })).toEqual({ next: BUILDING_PLAN, effects: [], rejected: false });
    expectRejected(candidate(ACCEPTED, { kind: 'St', jobId: JOB, now: D }), ACCEPTED);
    expectRejected(candidate({ ...ACCEPTED, archived: true }, { kind: 'St', jobId: JOB, now: D - 1 }), { ...ACCEPTED, archived: true });
    expectRejected(candidate(ACCEPTED, { kind: 'St', jobId: 'job-2', now: D - 1 }), ACCEPTED);
  });

  it('A07 accepted × Sg is refused: no stage has started', () => {
    expectRejected(candidate(ACCEPTED, { kind: 'Sg', jobId: JOB, stage: 'encode' }), ACCEPTED);
  });

  it('A07b accepted × Ev is refused: no stage is authorised before St', () => {
    expectRejected(candidate(ACCEPTED, { kind: 'Ev', jobId: JOB, fact: { kind: 'verified' } }), ACCEPTED);
    expectRejected(candidate(ACCEPTED, { kind: 'Ev', jobId: JOB, fact: { kind: 'plan', route: 'encode', toolInputId: T } }), ACCEPTED);
  });

  it('A08 accepted × Er fails with the code; × Ar archives the accepted record', () => {
    expect(candidate(ACCEPTED, { kind: 'Er', jobId: JOB, code: 'classification_unknown' }).next).toEqual({ ...ACCEPTED, state: 'failed', failure: 'classification_unknown' });
    expect(candidate(ACCEPTED, { kind: 'Ar' }).next).toEqual({ ...ACCEPTED, archived: true });
  });

});

describe('A §7.1 candidate: building row and the frozen route', () => {
  it('A10 the plan fact freezes the route and pins the toolInputId (Tp)', () => {
    const step = candidate(BUILDING_PLAN, { kind: 'Ev', jobId: JOB, fact: { kind: 'plan', route: 'encode', toolInputId: T } });
    expect(step).toEqual({ next: PLANNED_ENCODE, effects: [], rejected: false });
  });

  it('A12 Sg accepts only the next stage of the frozen route and dispatches it', () => {
    const count = candidate(PLANNED_ENCODE, { kind: 'Sg', jobId: JOB, stage: 'count' });
    expect(count).toEqual({ next: { ...PLANNED_ENCODE, stage: 'count' }, effects: [{ kind: 'dispatch', stage: 'count' }], rejected: false });
    const encode = candidate(count.next, { kind: 'Sg', jobId: JOB, stage: 'encode' });
    expect(encode).toEqual({ next: { ...PLANNED_ENCODE, stage: 'encode' }, effects: [{ kind: 'dispatch', stage: 'encode' }], rejected: false });
    const stitch = candidate(encode.next, { kind: 'Sg', jobId: JOB, stage: 'stitch' });
    expect(stitch).toEqual({ next: { ...PLANNED_ENCODE, stage: 'stitch' }, effects: [{ kind: 'dispatch', stage: 'stitch' }], rejected: false });
  });

  it.each([
    ['a skipped stage', PLANNED_ENCODE, 'encode'], ['the same stage again', { ...PLANNED_ENCODE, stage: 'count' }, 'count'],
    ['a stage of another route', PLANNED_ENCODE, 'edit'], ['a stage before the plan', BUILDING_PLAN, 'count'],
    ['an archived record', { ...PLANNED_ENCODE, archived: true, pinned: false }, 'count'],
    // publish is reached only through complete verified evidence (building × Ev), never through Sg.
    ['the publish stage', { ...PLANNED_ENCODE, stage: 'stitch' }, 'publish'], ['the publish stage of the carrier reuse route', PLANNED_REUSE, 'publish'],
  ] as const)('A13 Sg is refused for %s', (_, record, stage) => {
    expectRejected(candidate(record, { kind: 'Sg', jobId: JOB, stage }), record);
  });

  it('A14 Sg from another job is refused', () => {
    expectRejected(candidate(PLANNED_ENCODE, { kind: 'Sg', jobId: 'job-2', stage: 'count' }), PLANNED_ENCODE);
  });

  it('A15 complete verified evidence after the last work stage makes the candidate verified and submits Pub', () => {
    const atStitch = { ...PLANNED_ENCODE, stage: 'stitch' };
    expect(candidate(atStitch, { kind: 'Ev', jobId: JOB, fact: { kind: 'verified' } })).toEqual({ next: VERIFIED, effects: [{ kind: 'publish', toolInputId: T }], rejected: false });
    // The carrier reuse route has no work stage: the plan is the last stage before publish.
    expect(candidate(PLANNED_REUSE, { kind: 'Ev', jobId: JOB, fact: { kind: 'verified' } })).toEqual({ next: { ...PLANNED_REUSE, state: 'verified' }, effects: [{ kind: 'publish', toolInputId: T }], rejected: false });
  });

  it('A16 verified evidence before the work stages finish leaves the candidate building without Pub', () => {
    const step = candidate(PLANNED_ENCODE, { kind: 'Ev', jobId: JOB, fact: { kind: 'verified' } });
    expect(step.next.state).toBe('building');
    expect(step.effects).toEqual([]);
  });

  it('A17 an archived record records verified physical facts but never submits Pub', () => {
    const archived = { ...PLANNED_ENCODE, stage: 'stitch', archived: true, pinned: false };
    const step = candidate(archived, { kind: 'Ev', jobId: JOB, fact: { kind: 'verified' } });
    expect(step.next.state).toBe('verified');
    expect(step.effects).toEqual([]);
  });

  it.each([['too_long'], ['packed_over_cap'], ['packed_clock_mismatch'], ['expired']])('A18 building × Er %s fails the candidate with that code and unpins it', (code) => {
    expect(candidate(PLANNED_ENCODE, { kind: 'Er', jobId: JOB, code }).next).toEqual({ ...PLANNED_ENCODE, state: 'failed', failure: code, pinned: false });
  });

  it('A19 building × Ar archives the record and releases its pin', () => {
    expect(candidate(PLANNED_ENCODE, { kind: 'Ar' }).next).toEqual({ ...PLANNED_ENCODE, archived: true, pinned: false });
  });

});

describe('A §7.1 candidate: Rt and Ev cells', () => {
  it.each([['accepted', ACCEPTED], ['building', PLANNED_ENCODE]] as const)('A30 %s × Rt replays the active record: unchanged, no effects', (_, record) => {
    expectKept(candidate(record, { kind: 'Rt', jobId: 'job-2', deadlineAt: D + 1 }), record);
  });

  it('A32 failed × Rt leaves the original row: the retry is an independent new job', () => {
    expectKept(candidate(FAILED, { kind: 'Rt', jobId: 'job-2', deadlineAt: D + 1 }), FAILED);
  });

  it('A33 verified × the same evidence replays; different evidence is refused', () => {
    expectKept(candidate(VERIFIED, { kind: 'Ev', jobId: JOB, fact: { kind: 'verified' } }), VERIFIED);
    expectKept(candidate(VERIFIED, { kind: 'Ev', jobId: JOB, fact: { kind: 'plan', route: 'encode', toolInputId: T } }), VERIFIED);
    expectRejected(candidate(VERIFIED, { kind: 'Ev', jobId: JOB, fact: { kind: 'plan', route: 'edit', toolInputId: T } }), VERIFIED);
    expectRejected(candidate(VERIFIED, { kind: 'Ev', jobId: JOB, fact: { kind: 'plan', route: 'encode', toolInputId: T2 } }), VERIFIED);
  });

  it('A34 failed × Ev stays failed: a current record asks P to recheck its publication, an archived one never activates P', () => {
    expect(candidate(FAILED, { kind: 'Ev', jobId: JOB, fact: { kind: 'verified' } })).toEqual({ next: FAILED, effects: [{ kind: 'recheck-publish', toolInputId: T }], rejected: false });
    const archived = { ...FAILED, archived: true };
    expectKept(candidate(archived, { kind: 'Ev', jobId: JOB, fact: { kind: 'verified' } }), archived);
  });
});

describe('A §7.1 candidate: verified and failed rows', () => {
  it('A21 verified × Sg is refused; × St starts no new work', () => {
    expectRejected(candidate(VERIFIED, { kind: 'Sg', jobId: JOB, stage: 'publish' }), VERIFIED);
    const start = candidate(VERIFIED, { kind: 'St', jobId: JOB, now: D - 1 });
    expect(start.next).toEqual(VERIFIED);
    expect(start.effects).toEqual([]);
  });

  it('A22 verified × Er does not erase the verified facts', () => {
    expect(candidate(VERIFIED, { kind: 'Er', jobId: JOB, code: 'expired' }).next.state).toBe('verified');
  });

  it('A23 verified × Ar archives without selecting it back and releases the pin', () => {
    const step = candidate(VERIFIED, { kind: 'Ar' });
    expect(step.next).toEqual({ ...VERIFIED, archived: true, pinned: false });
    expect(step.effects).toEqual([]);
  });

  it('A28 failed keeps its first failure and refuses St and Sg; Ad and Rt leave the original row as it is', () => {
    expect(candidate(FAILED, { kind: 'Er', jobId: JOB, code: 'expired' }).next).toEqual(FAILED);
    expectRejected(candidate(FAILED, { kind: 'St', jobId: JOB, now: D - 1 }), FAILED);
    expectRejected(candidate(FAILED, { kind: 'Sg', jobId: JOB, stage: 'encode' }), FAILED);
    expect(candidate(FAILED, { kind: 'Ad', jobId: JOB, deadlineAt: D }).next).toEqual(FAILED);
    expect(candidate(FAILED, { kind: 'Rt', jobId: 'job-2', deadlineAt: D + 1 }).next).toEqual(FAILED);
    expect(candidate(FAILED, { kind: 'Ar' }).next).toEqual({ ...FAILED, archived: true });
  });

});

const candidateEvent: fc.Arbitrary<CandidateEvent> = fc.oneof(
  fc.record({ kind: fc.constant('Ad' as const), jobId: fc.constantFrom(JOB, 'job-2'), deadlineAt: fc.constantFrom(D, D + 1) }),
  fc.record({ kind: fc.constant('St' as const), jobId: fc.constantFrom(JOB, 'job-2'), now: fc.constantFrom(D - 1, D) }),
  fc.record({ kind: fc.constant('Sg' as const), jobId: fc.constant(JOB), stage: fc.constantFrom('plan', 'count', 'edit', 'edit_stitch', 'encode', 'stitch', 'publish') }),
  fc.record({ kind: fc.constant('Ev' as const), jobId: fc.constant(JOB), fact: fc.oneof(
    fc.constant({ kind: 'verified' as const }),
    fc.record({ kind: fc.constant('plan' as const), route: fc.constantFrom<Route>('encode', 'edit', 'reuse_edit', 'reuse'), toolInputId: fc.constantFrom(T, T2, null) }),
    fc.record({ kind: fc.constant('tool-input' as const), toolInputId: fc.constantFrom(T, T2) }),
  ) }),
  fc.record({ kind: fc.constant('Er' as const), jobId: fc.constant(JOB), code: fc.constantFrom('expired', 'too_long', 'packed_over_cap') }),
  fc.constant({ kind: 'Ar' as const }),
  fc.record({ kind: fc.constant('Rt' as const), jobId: fc.constant('job-3'), deadlineAt: fc.constant(D + 2) }),
);

describe('AP §7.1 candidate invariants (property)', () => {
  it('AP01 the job and deadline never change after admission, failed is terminal, archived never publishes, stages only move forward and failed or archived records hold no pin', () => {
    const advance = required('advancePresentationCandidate');
    const stages: Record<Route, string[]> = {
      encode: ['plan', 'count', 'encode', 'stitch', 'publish'], edit: ['plan', 'count', 'edit', 'edit_stitch', 'encode', 'stitch', 'publish'],
      reuse_edit: ['plan', 'encode', 'stitch', 'publish'], reuse: ['plan', 'publish'],
    };
    fc.assert(fc.property(fc.array(candidateEvent, { minLength: 1, maxLength: 30 }), (events) => {
      let record = NONE;
      let frozen: { jobId: string; deadlineAt: number } | null = null;
      for (const event of events) {
        const { next, effects } = advance(record, event);
        if (frozen !== null) expect({ jobId: next.jobId, deadlineAt: next.deadlineAt }).toEqual(frozen);
        else if (next.jobId !== null) frozen = { jobId: next.jobId, deadlineAt: next.deadlineAt! };
        if (record.state === 'failed') expect(next.state).toBe('failed');
        if (record.archived) expect(next.archived).toBe(true);
        if (next.archived) expect(effects.some((effect) => effect.kind === 'publish' || effect.kind === 'dispatch')).toBe(false);
        if (record.route !== null && record.stage !== null && next.stage !== null) {
          expect(next.route).toBe(record.route);
          expect(stages[record.route].indexOf(next.stage)).toBeGreaterThanOrEqual(stages[record.route].indexOf(record.stage));
        }
        if (next.state === 'failed' || next.archived) expect(next.pinned).toBe(false);
        record = next;
      }
    }), { seed: 130901, numRuns: 400 });
  });
});

const CHUNK_ID: ChunkIdentity = { kind: 'presentation-chunk', jobId: JOB, chunk: 2 };
const EMPTY_CHUNK: Chunk = { state: 'none', attempt: 0, retries: 0, failure: null, attempts: [] };

/**
 * One pending attempt item.
 * @param attempt - The attempt number.
 * @returns The item.
 */
function pendingItem(attempt: number): AttemptItem {
  return { attempt, jobId: `video-presentation:${JOB}:chunk:2:a${attempt}`, state: 'pending', usage: null, usageRecorded: false, failure: null };
}

/**
 * Apply one chunk event.
 * @param chunk - The chunk.
 * @param event - The event.
 * @returns The step.
 */
function chunk(chunk: Chunk, event: ChunkEvent): Step<Chunk, ChunkEffect> {
  return required('advancePresentationChunk')(chunk, event, CHUNK_ID);
}

const OPEN: Chunk = { state: 'open', attempt: 1, retries: 2, failure: null, attempts: [pendingItem(1)] };

describe('K §7.1.1 chunk set: chunk and attempt levels', () => {
  it('K01 none × Sub opens attempt 1 with the configured retries and dispatches its attempt-scoped job id', () => {
    expect(chunk(EMPTY_CHUNK, { kind: 'Sub', retries: 2 })).toEqual({ next: OPEN, effects: [{ kind: 'dispatch', jobId: `video-presentation:${JOB}:chunk:2:a1` }], rejected: false });
  });

  it('K01a with chunk_retries 3 a chunk is tried at most four times before it fails the candidate', () => {
    let state = chunk(EMPTY_CHUNK, { kind: 'Sub', retries: CHUNK_RETRIES }).next;
    expect(state).toMatchObject({ state: 'open', attempt: 1, retries: 3 });
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const step = chunk(state, { kind: 'Fail', attempt, code: 'resource_exhausted', usage: null });
      expect(step.effects).toEqual([{ kind: 'dispatch', jobId: `video-presentation:${JOB}:chunk:2:a${attempt + 1}` }]);
      state = step.next;
    }
    const last = chunk(state, { kind: 'Fail', attempt: 4, code: 'resource_exhausted', usage: null });
    expect(last.next).toMatchObject({ state: 'failed', attempt: 4, retries: 0, failure: 'resource_exhausted' });
    expect(last.effects).toEqual([{ kind: 'candidate-failed', code: 'resource_exhausted' }]);
  });

  it('K02 none × Done or Fail is refused; × Exp keeps none', () => {
    expectRejected(chunk(EMPTY_CHUNK, { kind: 'Done', attempt: 1, usage: 5 }), EMPTY_CHUNK);
    expectRejected(chunk(EMPTY_CHUNK, { kind: 'Fail', attempt: 1, code: 'chunk_failed', usage: null }), EMPTY_CHUNK);
    expectKept(chunk(EMPTY_CHUNK, { kind: 'Exp' }), EMPTY_CHUNK);
  });

  it('K03 open × Sub is idempotent and creates no attempt', () => {
    expectKept(chunk(OPEN, { kind: 'Sub', retries: 2 }), OPEN);
  });

  it('K04 open × the latest attempt done completes the chunk and records receipt usage', () => {
    expect(chunk(OPEN, { kind: 'Done', attempt: 1, usage: 12 })).toEqual({
      next: { ...OPEN, state: 'done', attempts: [{ ...pendingItem(1), state: 'done', usage: 12 }] }, effects: [{ kind: 'chunk-done' }], rejected: false,
    });
  });

  it('K05 open × the latest attempt failed with retries left opens the next attempt under a new job id', () => {
    expect(chunk(OPEN, { kind: 'Fail', attempt: 1, code: 'resource_exhausted', usage: 3 })).toEqual({
      next: { state: 'open', attempt: 2, retries: 1, failure: null, attempts: [{ ...pendingItem(1), state: 'failed', usage: 3, failure: 'resource_exhausted' }, pendingItem(2)] },
      effects: [{ kind: 'dispatch', jobId: `video-presentation:${JOB}:chunk:2:a2` }], rejected: false,
    });
  });

  it('K06 open × the latest attempt failed with no retries left fails the chunk and the candidate with the underlying code', () => {
    const last: Chunk = { ...OPEN, retries: 0 };
    expect(chunk(last, { kind: 'Fail', attempt: 1, code: 'invalid_edit', usage: null })).toEqual({
      next: { ...last, state: 'failed', failure: 'invalid_edit', attempts: [{ ...pendingItem(1), state: 'failed', failure: 'invalid_edit' }] },
      effects: [{ kind: 'candidate-failed', code: 'invalid_edit' }], rejected: false,
    });
  });

  it('K07 open × Exp fails the chunk as expired with every in-flight attempt, without failing the candidate', () => {
    const step = chunk(OPEN, { kind: 'Exp' });
    expect(step.next.state).toBe('failed');
    expect(step.next.failure).toBe('expired');
    expect(step.next.attempts).toEqual([{ ...pendingItem(1), state: 'failed', failure: 'expired' }]);
    // The candidate expires through its own Er, not through this chunk event.
    expect(step.effects).toEqual([]);
  });

  it('K08 a late completion of an older failed attempt records its usage, keeps the item failed and leaves the chunk', () => {
    const second: Chunk = { state: 'open', attempt: 2, retries: 1, failure: null, attempts: [{ ...pendingItem(1), state: 'failed', failure: 'resource_exhausted' }, pendingItem(2)] };
    const late = chunk(second, { kind: 'Done', attempt: 1, usage: 9 });
    expect(late.next.state).toBe('open');
    expect(late.next.attempt).toBe(2);
    expect(late.next.attempts[0]).toEqual({ ...pendingItem(1), state: 'failed', failure: 'resource_exhausted', usage: 9 });
    expect(late.next.attempts[1]).toEqual(pendingItem(2));
    expect(late.effects).toEqual([]);
  });

  it('K09 done keeps a late failure of its latest attempt from failing it', () => {
    const done: Chunk = { ...OPEN, state: 'done', attempts: [{ ...pendingItem(1), state: 'done', usage: 12 }] };
    expectKept(chunk(done, { kind: 'Sub', retries: 2 }), done);
    expectRejected(chunk(done, { kind: 'Fail', attempt: 1, code: 'chunk_failed', usage: null }), done);
    expectKept(chunk(done, { kind: 'Exp' }), done);
  });

  it('K10 failed refuses Sub; a late completion records usage only, the item and chunk stay failed and the candidate is not touched', () => {
    const failed: Chunk = { ...OPEN, retries: 0, state: 'failed', failure: 'invalid_edit', attempts: [{ ...pendingItem(1), state: 'failed', failure: 'invalid_edit' }] };
    expectRejected(chunk(failed, { kind: 'Sub', retries: 2 }), failed);
    const late = chunk(failed, { kind: 'Done', attempt: 1, usage: 4 });
    expect(late.next).toEqual({ ...failed, attempts: [{ ...failed.attempts[0]!, usage: 4 }] });
    expect(late.effects).toEqual([]);
  });

  it('K11 Rec marks recorded usage on a done or measured failed attempt and is refused on a pending one', () => {
    const done: Chunk = { ...OPEN, state: 'done', attempts: [{ ...pendingItem(1), state: 'done', usage: 12 }] };
    expect(chunk(done, { kind: 'Rec', attempt: 1 }).next.attempts[0]!.usageRecorded).toBe(true);
    const failedWithUsage: Chunk = { state: 'open', attempt: 2, retries: 1, failure: null, attempts: [{ ...pendingItem(1), state: 'failed', usage: 3, failure: 'resource_exhausted' }, pendingItem(2)] };
    expect(chunk(failedWithUsage, { kind: 'Rec', attempt: 1 }).next.attempts[0]!.usageRecorded).toBe(true);
    expectRejected(chunk(OPEN, { kind: 'Rec', attempt: 1 }), OPEN);
  });

  it('K12 the main job counts usage as recorded only when every attempt with usage is recorded', () => {
    const recorded = required('presentationChunksUsageRecorded');
    const a: Chunk = { ...OPEN, state: 'done', attempts: [{ ...pendingItem(1), state: 'done', usage: 12, usageRecorded: true }] };
    const b: Chunk = { state: 'done', attempt: 2, retries: 1, failure: null, attempts: [{ ...pendingItem(1), state: 'failed', usage: 3, failure: 'resource_exhausted' }, { ...pendingItem(2), state: 'done', usage: 7, usageRecorded: true }] };
    expect(recorded([a])).toBe(true);
    expect(recorded([a, b])).toBe(false);
    expect(recorded([a, { ...b, attempts: [{ ...b.attempts[0]!, usageRecorded: true }, b.attempts[1]!] }])).toBe(true);
    // An attempt without usage has nothing to record.
    expect(recorded([{ ...OPEN, state: 'failed', failure: 'expired', attempts: [{ ...pendingItem(1), state: 'failed', failure: 'expired' }] }])).toBe(true);
  });

  it.each([
    [{ kind: 'presentation-stitch', jobId: JOB } as const, `video-presentation:${JOB}:stitch:a1`],
    [{ kind: 'presentation-count', jobId: JOB } as const, `video-presentation:${JOB}:count:a1`],
    [{ kind: 'presentation-edit', jobId: JOB, chunk: 0 } as const, `video-presentation:${JOB}:edit:0:a1`],
    [{ kind: 'presentation-edit-stitch', jobId: JOB } as const, `video-presentation:${JOB}:edit-stitch:a1`],
  ])('K13 the %o unit dispatches attempt 1 as %s', (identity, jobId) => {
    expect(required('advancePresentationChunk')(EMPTY_CHUNK, { kind: 'Sub', retries: 1 }, identity).effects).toEqual([{ kind: 'dispatch', jobId }]);
  });
});

describe('KP §7.1.1 chunk invariants (property)', () => {
  it('KP01 the chunk fails only when its latest attempt fails with no retries left, attempt job ids never repeat and old attempts never move the chunk', () => {
    const advance = required('advancePresentationChunk');
    const event: fc.Arbitrary<ChunkEvent> = fc.oneof(
      fc.record({ kind: fc.constant('Done' as const), attempt: fc.integer({ min: 1, max: 6 }), usage: fc.integer({ min: 0, max: 9 }) }),
      fc.record({ kind: fc.constant('Fail' as const), attempt: fc.integer({ min: 1, max: 6 }), code: fc.constantFrom('resource_exhausted', 'invalid_edit'), usage: fc.option(fc.integer({ min: 0, max: 9 }), { nil: null }) }),
      fc.record({ kind: fc.constant('Rec' as const), attempt: fc.integer({ min: 1, max: 6 }) }),
    );
    fc.assert(fc.property(fc.integer({ min: 0, max: 4 }), fc.array(event, { maxLength: 30 }), (retries, events) => {
      let state = advance(EMPTY_CHUNK, { kind: 'Sub', retries }, CHUNK_ID).next;
      for (const item of events) {
        const before = state;
        const { next, effects } = advance(before, item, CHUNK_ID);
        const latest = (item.kind === 'Done' || item.kind === 'Fail') && item.attempt === before.attempt;
        if (next.state === 'failed' && before.state !== 'failed') {
          expect(item.kind === 'Fail' && latest && before.retries === 0).toBe(true);
          expect(effects).toEqual([{ kind: 'candidate-failed', code: (item as { code: string }).code }]);
        }
        if (!latest) {
          expect(next.state).toBe(before.state);
          expect(next.attempt).toBe(before.attempt);
        }
        expect(new Set(next.attempts.map((attempt) => attempt.jobId)).size).toBe(next.attempts.length);
        expect(next.attempts.map((attempt) => attempt.attempt)).toEqual(next.attempts.map((_, index) => index + 1));
        expect(next.attempt + next.retries).toBe(retries + 1);
        state = next;
      }
    }), { seed: 130902, numRuns: 400 });
  });
});

const A: Version = { versionId: 'a'.repeat(64), toolInputId: T };
const B_SAME: Version = { versionId: 'd'.repeat(64), toolInputId: T };
const B_NEW: Version = { versionId: 'e'.repeat(64), toolInputId: T2 };

/**
 * A complete current Pub of a candidate.
 * @param version - The candidate version.
 * @returns The event.
 */
function pub(version: Version): SelectionEvent {
  return { kind: 'Pub', candidate: version, complete: true, current: true };
}

describe('P §7.2 selected bundle', () => {
  const select = (state: Selection, event: SelectionEvent): SelectionStep => required('advanceSelectedPresentation')(state, event);
  const UNKNOWN: Selection = { kind: 'unknown' };
  const READY_A: Selection = { kind: 'ready', version: A };
  const INVALID_A: Selection = { kind: 'invalid', version: A };

  it('P01 unknown × a complete current Pub selects it', () => {
    expect(select(UNKNOWN, pub(B_NEW))).toEqual({ next: { kind: 'ready', version: B_NEW }, published: true, waiting: false });
  });

  it.each([
    ['an incomplete bundle', { kind: 'Pub', candidate: B_NEW, complete: false, current: true }],
    ['a non-current candidate', { kind: 'Pub', candidate: B_NEW, complete: true, current: false }],
  ] as const)('P02 unknown × Pub of %s keeps unknown', (_, event) => {
    expect(select(UNKNOWN, event)).toEqual({ next: UNKNOWN, published: false, waiting: false });
  });

  it('P03 unknown × Chk restores ready only from a complete stored proof', () => {
    expect(select(UNKNOWN, { kind: 'Chk', proof: 'complete', version: A }).next).toEqual(READY_A);
    expect(select(UNKNOWN, { kind: 'Chk', proof: 'head-only', version: A }).next).toEqual(UNKNOWN);
    expect(select(UNKNOWN, { kind: 'Chk', proof: 'none', version: A }).next).toEqual(UNKNOWN);
  });

  it.each([[{ kind: 'Bad' }], [{ kind: 'New' }], [{ kind: 'Src' }], [{ kind: 'Late', version: A }]] as const)('P04 unknown × %o keeps unknown', (event) => {
    expect(select(UNKNOWN, event).next).toEqual(UNKNOWN);
  });

  it('P05 ready(A) × Pub of a candidate with the same toolInputId swaps the whole bundle without waiting', () => {
    expect(select(READY_A, pub(B_SAME))).toEqual({ next: { kind: 'ready', version: B_SAME }, published: true, waiting: false });
  });

  it('P06 ready(A) × Pub of a new toolInputId swaps the whole bundle at once: the tool source travels in the bundle (§5.1 step 5)', () => {
    expect(select(READY_A, pub(B_NEW))).toEqual({ next: { kind: 'ready', version: B_NEW }, published: true, waiting: false });
  });

  it('P07 ready(A) × Chk keeps it; × Bad invalidates A; × New keeps A; × Src forgets it; × Late keeps A', () => {
    expect(select(READY_A, { kind: 'Chk', proof: 'complete', version: A }).next).toEqual(READY_A);
    // A complete proof of another version is ignored: only Pub switches the selection.
    expect(select(READY_A, { kind: 'Chk', proof: 'complete', version: B_NEW }).next).toEqual(READY_A);
    expect(select(READY_A, { kind: 'Bad' }).next).toEqual(INVALID_A);
    expect(select(READY_A, { kind: 'New' }).next).toEqual(READY_A);
    expect(select(READY_A, { kind: 'Src' }).next).toEqual(UNKNOWN);
    expect(select(READY_A, { kind: 'Late', version: B_NEW }).next).toEqual(READY_A);
  });

  it('P08 invalid(A) × a complete current Pub restores playback at once', () => {
    expect(select(INVALID_A, pub(B_NEW))).toEqual({ next: { kind: 'ready', version: B_NEW }, published: true, waiting: false });
  });

  it('P09 invalid(A) recovers A only from a complete proof of that version, never from a head check', () => {
    expect(select(INVALID_A, { kind: 'Chk', proof: 'complete', version: A }).next).toEqual(READY_A);
    expect(select(INVALID_A, { kind: 'Chk', proof: 'head-only', version: A }).next).toEqual(INVALID_A);
    expect(select(INVALID_A, { kind: 'Chk', proof: 'complete', version: B_NEW }).next).toEqual(INVALID_A);
  });

  it('P10 invalid(A) × Bad, New and Late keep it; × Src forgets it', () => {
    expect(select(INVALID_A, { kind: 'Bad' }).next).toEqual(INVALID_A);
    expect(select(INVALID_A, { kind: 'New' }).next).toEqual(INVALID_A);
    expect(select(INVALID_A, { kind: 'Late', version: B_NEW }).next).toEqual(INVALID_A);
    expect(select(INVALID_A, { kind: 'Src' }).next).toEqual(UNKNOWN);
  });

  it('PP01 only a complete current Pub or a complete proof selects a version, and Late never selects (property)', () => {
    const select2 = required('advanceSelectedPresentation');
    const version = fc.constantFrom(A, B_SAME, B_NEW);
    const event: fc.Arbitrary<SelectionEvent> = fc.oneof(
      fc.record({ kind: fc.constant('Pub' as const), candidate: version, complete: fc.boolean(), current: fc.boolean() }),
      fc.record({ kind: fc.constant('Chk' as const), proof: fc.constantFrom('complete' as const, 'head-only' as const, 'none' as const), version }),
      fc.constantFrom<SelectionEvent>({ kind: 'Bad' }, { kind: 'New' }, { kind: 'Src' }),
      fc.record({ kind: fc.constant('Late' as const), version }),
    );
    fc.assert(fc.property(fc.array(event, { maxLength: 30 }), (events) => {
      let state: Selection = UNKNOWN;
      for (const item of events) {
        const { next } = select2(state, item);
        const changed = JSON.stringify(next) !== JSON.stringify(state);
        if (changed && next.kind === 'ready') {
          if (item.kind === 'Pub') {
            expect(item.complete && item.current).toBe(true);
          } else {
            expect(item.kind).toBe('Chk');
            expect((item as { proof: string }).proof).toBe('complete');
          }
        }
        if (item.kind === 'Src') expect(next).toEqual(UNKNOWN);
        if (item.kind === 'Late') expect(next).toEqual(state);
        state = next;
      }
    }), { seed: 130903, numRuns: 400 });
  });
});

describe('R §7.3 stored object role', () => {
  const object = (kind: ObjectKind, receipt: string | null = null, role: 'R0' | 'other' = 'other'): StoredObject => ({ kind, role, receipt });
  const advance = (state: StoredObject, event: ObjectEvent): { next: StoredObject; rejected: boolean } => required('advancePresentationObject')(state, event);

  it('R01 absent: an authorized Begin starts writing; Put and Publish are refused; Stop keeps absent', () => {
    expect(advance(object('absent'), { kind: 'Begin', authorized: true })).toEqual({ next: object('writing'), rejected: false });
    expect(advance(object('absent'), { kind: 'Begin', authorized: false }).next).toEqual(object('absent'));
    expectRejected(advance(object('absent'), { kind: 'Put', won: true }), object('absent'));
    expectRejected(advance(object('absent'), { kind: 'Publish', ok: true, receipt: 'r1' }), object('absent'));
    expect(advance(object('absent'), { kind: 'Stop', committed: false })).toEqual({ next: object('absent'), rejected: false });
  });

  it('R02 writing: a concurrent Begin, a Measure and a Publish are refused; the winning Put completes; an uncommitted Stop returns to absent', () => {
    expectRejected(advance(object('writing'), { kind: 'Begin', authorized: true }), object('writing'));
    expectRejected(advance(object('writing'), { kind: 'Measure', matches: true, receipt: 'r1' }), object('writing'));
    expectRejected(advance(object('writing'), { kind: 'Publish', ok: true, receipt: 'r1' }), object('writing'));
    expect(advance(object('writing'), { kind: 'Put', won: true })).toEqual({ next: object('complete'), rejected: false });
    expect(advance(object('writing'), { kind: 'Stop', committed: false })).toEqual({ next: object('absent'), rejected: false });
  });

  it('R02a writing × Stop with an unknown commit outcome stays writing until a real check, never reports absent', () => {
    expect(advance(object('writing'), { kind: 'Stop', committed: 'unknown' })).toEqual({ next: object('writing'), rejected: false });
  });

  it('R03 complete: a matching measurement records the receipt, a mismatch invalidates; Publish is refused without a measurement', () => {
    expect(advance(object('complete'), { kind: 'Measure', matches: true, receipt: 'r1' })).toEqual({ next: object('measured', 'r1'), rejected: false });
    expect(advance(object('complete'), { kind: 'Measure', matches: false, receipt: 'r1' })).toEqual({ next: object('invalid'), rejected: false });
    expectRejected(advance(object('complete'), { kind: 'Publish', ok: true, receipt: 'r1' }), object('complete'));
    expect(advance(object('complete'), { kind: 'Begin', authorized: true }).next).toEqual(object('complete'));
    expect(advance(object('complete'), { kind: 'Stop', committed: false }).next).toEqual(object('complete'));
  });

  it('R04 measured: publication with every constraint met publishes, otherwise stays measured; a changed measurement invalidates', () => {
    expect(advance(object('measured', 'r1'), { kind: 'Publish', ok: true, receipt: 'r1' })).toEqual({ next: object('published', 'r1'), rejected: false });
    expect(advance(object('measured', 'r1'), { kind: 'Publish', ok: false, receipt: 'r1' }).next).toEqual(object('measured', 'r1'));
    expect(advance(object('measured', 'r1'), { kind: 'Measure', matches: true, receipt: 'r1' }).next).toEqual(object('measured', 'r1'));
    expect(advance(object('measured', 'r1'), { kind: 'Measure', matches: false, receipt: 'r2' }).next).toEqual(object('invalid'));
    expect(advance(object('measured', 'r1'), { kind: 'Stop', committed: false }).next).toEqual(object('measured', 'r1'));
  });

  it('R05 published: Begin and an old Put are refused; the same receipt is idempotent and a conflicting one refused; a failed check invalidates', () => {
    const published = object('published', 'r1');
    expectRejected(advance(published, { kind: 'Begin', authorized: true }), published);
    expectRejected(advance(published, { kind: 'Put', won: true }), published);
    expect(advance(published, { kind: 'Publish', ok: true, receipt: 'r1' })).toEqual({ next: published, rejected: false });
    expectRejected(advance(published, { kind: 'Publish', ok: true, receipt: 'r2' }), published);
    expect(advance(published, { kind: 'Verify', complete: true, matches: false, receipt: 'r1' }).next).toEqual(object('invalid'));
    expect(advance(published, { kind: 'Stop', committed: false }).next).toEqual(published);
  });

  it('R06 Replace swaps only the current descriptor pointer; other published objects stay for frozen references', () => {
    expect(advance(object('published', 'r1', 'R0'), { kind: 'Replace', receipt: 'r2' }).next).toEqual(object('published', 'r2', 'R0'));
    expect(advance(object('published', 'r1'), { kind: 'Replace', receipt: 'r2' }).next).toEqual(object('published', 'r1'));
  });

  it('R07 invalid: only a newly authorized Begin writes again and only a complete proof measures; Publish is refused; Stop keeps invalid', () => {
    expect(advance(object('invalid'), { kind: 'Begin', authorized: true }).next).toEqual(object('writing'));
    expect(advance(object('invalid'), { kind: 'Begin', authorized: false }).next).toEqual(object('invalid'));
    expectRejected(advance(object('invalid'), { kind: 'Publish', ok: true, receipt: 'r1' }), object('invalid'));
    expect(advance(object('invalid'), { kind: 'Verify', complete: true, matches: true, receipt: 'r3' }).next).toEqual(object('measured', 'r3'));
    expect(advance(object('invalid'), { kind: 'Verify', complete: false, matches: true, receipt: 'r3' }).next).toEqual(object('invalid'));
    expect(advance(object('invalid'), { kind: 'Stop', committed: false }).next).toEqual(object('invalid'));
  });

  it('RP01 an object is published only straight from measured, and nothing but Begin or Verify leaves invalid (property)', () => {
    const event: fc.Arbitrary<ObjectEvent> = fc.oneof(
      fc.record({ kind: fc.constant('Begin' as const), authorized: fc.boolean() }), fc.record({ kind: fc.constant('Put' as const), won: fc.boolean() }),
      fc.record({ kind: fc.constant('Measure' as const), matches: fc.boolean(), receipt: fc.constantFrom('r1', 'r2') }),
      fc.record({ kind: fc.constant('Publish' as const), ok: fc.boolean(), receipt: fc.constantFrom('r1', 'r2') }),
      fc.record({ kind: fc.constant('Stop' as const), committed: fc.boolean() }),
      fc.record({ kind: fc.constant('Verify' as const), complete: fc.boolean(), matches: fc.boolean(), receipt: fc.constantFrom('r1', 'r2') }),
      fc.record({ kind: fc.constant('Replace' as const), receipt: fc.constantFrom('r1', 'r2') }),
    );
    fc.assert(fc.property(fc.array(event, { maxLength: 40 }), (events) => {
      let state = object('absent');
      for (const item of events) {
        const { next } = advance(state, item);
        if (next.kind === 'published' && state.kind !== 'published') expect(state.kind).toBe('measured');
        if (state.kind === 'invalid' && next.kind !== 'invalid') expect(['Begin', 'Verify']).toContain(item.kind);
        state = next;
      }
    }), { seed: 130904, numRuns: 400 });
  });
});
