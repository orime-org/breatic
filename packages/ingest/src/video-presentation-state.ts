// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The presentation Durable Object state machine as pure transitions (inner#1306; frames-split design §7.1 candidate
 * A/A', §7.1.1 chunk set, §7.2 selected bundle P, §7.3 stored object roles R). Each function is the decision half of one
 * single write point; the store persists what it returns.
 * A refused cell returns `rejected: true` with the state unchanged; a kept cell returns the state and no effects.
 */

import { videoCarrierRouteStages, videoContainerJobId, type VideoCarrierRoute } from '@shared/mini-tools/video-encode-plan.js';

/** One transition's result. */
export interface PresentationStep<T, E> { next: T; effects: E[]; rejected: boolean }

/**
 * A kept cell: unchanged, not refused, no effects.
 * @param next - The unchanged state.
 * @returns The step.
 * @throws {never} Never.
 */
function kept<T, E>(next: T): PresentationStep<T, E> {
  return { next, effects: [], rejected: false };
}

/**
 * A refused cell: unchanged and refused.
 * @param next - The unchanged state.
 * @returns The step.
 * @throws {never} Never.
 */
function refused<T, E>(next: T): PresentationStep<T, E> {
  return { next, effects: [], rejected: true };
}

/**
 * A moved cell.
 * @param next - The new state.
 * @param effects - Its effects.
 * @returns The step.
 * @throws {never} Never.
 */
function moved<T, E>(next: T, effects: E[] = []): PresentationStep<T, E> {
  return { next, effects, rejected: false };
}

// ---------------------------------------------------------------- candidate A (§7.1)

/** One presentation candidate record. */
export interface PresentationCandidate {
  state: 'none' | 'accepted' | 'building' | 'verified' | 'failed';
  archived: boolean;
  jobId: string | null;
  deadlineAt: number | null;
  route: VideoCarrierRoute | null;
  stage: string | null;
  toolInputId: string | null;
  pinned: boolean;
  failure: string | null;
  autoRepairs: number;
}
/**
 * A physical fact reported by the candidate's work: the plan (its toolInputId is null on the edit route until the edit file is
 * measured, §3.2 item 3), the edit file's toolInputId, or verified evidence.
 */
export type PresentationFact =
  | { kind: 'plan'; route: VideoCarrierRoute; toolInputId: string | null }
  | { kind: 'tool-input'; toolInputId: string }
  | { kind: 'verified' };
/** One candidate event. */
export type PresentationCandidateEvent =
  | { kind: 'Ad'; jobId: string; deadlineAt: number }
  | { kind: 'St'; jobId: string; now: number }
  | { kind: 'Sg'; jobId: string; stage: string }
  | { kind: 'Ev'; jobId: string; fact: PresentationFact }
  | { kind: 'Er'; jobId: string; code: string }
  | { kind: 'Ar' }
  | { kind: 'Rt'; jobId: string; deadlineAt: number };
/** One candidate side effect. */
export type PresentationCandidateEffect =
  | { kind: 'dispatch'; stage: string }
  | { kind: 'publish'; toolInputId: string }
  | { kind: 'recheck-publish'; toolInputId: string };
type CandidateStep = PresentationStep<PresentationCandidate, PresentationCandidateEffect>;

/** The candidate with no admission. */
export const NO_PRESENTATION_CANDIDATE: PresentationCandidate = {
  state: 'none', archived: false, jobId: null, deadlineAt: null, route: null, stage: null, toolInputId: null, pinned: false, failure: null, autoRepairs: 0,
};

/**
 * The work stage after which complete verified evidence makes the candidate verified: the last before `publish`.
 * @param route - The frozen route.
 * @returns That stage.
 * @throws {never} Never.
 */
function lastWorkStage(route: VideoCarrierRoute): string {
  const stages = videoCarrierRouteStages(route);
  return stages[stages.length - 2]!;
}

/**
 * Apply a reported fact (Ev) to an admitted candidate.
 * @param record - The record, admitted.
 * @param fact - The fact.
 * @returns The step.
 * @throws {never} Never.
 */
function candidateFact(record: PresentationCandidate, fact: PresentationFact): CandidateStep {
  const same = fact.kind === 'verified' || (fact.kind === 'plan' ? fact.route === record.route && fact.toolInputId === record.toolInputId : fact.toolInputId === record.toolInputId);
  switch (record.state) {
    case 'verified': return same ? kept(record) : refused(record);
    case 'failed':
      return !record.archived && record.toolInputId !== null ? moved(record, [{ kind: 'recheck-publish', toolInputId: record.toolInputId }]) : kept(record);
    case 'building': break;
    default: return refused(record);
  }
  if (fact.kind === 'plan') {
    if (record.route !== null) return same ? kept(record) : refused(record);
    if (record.stage !== 'plan') return refused(record);
    return moved({ ...record, route: fact.route, toolInputId: fact.toolInputId, pinned: !record.archived });
  }
  if (fact.kind === 'tool-input') {
    if (record.toolInputId !== null) return same ? kept(record) : refused(record);
    return record.route === 'edit' ? moved({ ...record, toolInputId: fact.toolInputId }) : refused(record);
  }
  if (record.route === null || record.toolInputId === null || record.stage !== lastWorkStage(record.route)) return kept(record);
  return moved({ ...record, state: 'verified' }, record.archived ? [] : [{ kind: 'publish', toolInputId: record.toolInputId }]);
}

/**
 * Advance one presentation candidate (§7.1): the job and deadline freeze at admission, stages move only along the
 * frozen route, failed is terminal and an archived record never publishes, dispatches or repairs.
 * @param record - The current record.
 * @param event - The event.
 * @returns The next record, its effects and whether the event was refused.
 * @throws {never} Never.
 */
export function advancePresentationCandidate(record: PresentationCandidate, event: PresentationCandidateEvent): CandidateStep {
  if (record.state === 'none') {
    if (event.kind === 'Ad' || event.kind === 'Rt') return moved({ ...record, state: 'accepted', jobId: event.jobId, deadlineAt: event.deadlineAt });
    return event.kind === 'St' || event.kind === 'Sg' || event.kind === 'Ev' ? refused(record) : kept(record);
  }
  switch (event.kind) {
    case 'Ad': return event.jobId === record.jobId ? kept(record) : refused(record);
    case 'Rt': return kept(record);
    case 'Ar': return record.archived ? kept(record) : moved({ ...record, archived: true, pinned: false });
    case 'St':
      if (record.state === 'accepted') {
        return event.jobId === record.jobId && !record.archived && event.now < record.deadlineAt! ? moved({ ...record, state: 'building', stage: 'plan' }) : refused(record);
      }
      return record.state === 'failed' ? refused(record) : kept(record);
    case 'Sg': {
      if (record.state !== 'building' || record.archived || event.jobId !== record.jobId || record.route === null || record.stage === null) return refused(record);
      const stages = videoCarrierRouteStages(record.route);
      const following = stages[stages.indexOf(record.stage as (typeof stages)[number]) + 1];
      if (following === undefined || following === 'publish' || event.stage !== following) return refused(record);
      return moved({ ...record, stage: following }, [{ kind: 'dispatch', stage: following }]);
    }
    case 'Ev': return event.jobId === record.jobId ? candidateFact(record, event.fact) : refused(record);
    case 'Er':
      if (record.state === 'verified' || record.state === 'failed') return kept(record);
      return event.jobId === record.jobId ? moved({ ...record, state: 'failed', failure: event.code, pinned: false }) : refused(record);
  }
}

// ---------------------------------------------------------------- chunk set (§7.1.1)

/** One container attempt of a chunk. */
export interface PresentationChunkAttempt {
  attempt: number;
  jobId: string;
  state: 'pending' | 'done' | 'failed';
  usage: number | null;
  usageRecorded: boolean;
  failure: string | null;
}
/** One unit (a count, a playback or edit chunk, or a stitch) and its attempts. */
export interface PresentationChunk {
  state: 'none' | 'open' | 'done' | 'failed';
  attempt: number;
  retries: number;
  failure: string | null;
  attempts: PresentationChunkAttempt[];
}
/** One attempt-level event; on the latest attempt it is also the chunk's event. */
export type PresentationChunkEvent =
  | { kind: 'Sub'; retries: number }
  | { kind: 'Done'; attempt: number; usage: number }
  | { kind: 'Fail'; attempt: number; code: string; usage: number | null }
  | { kind: 'Exp' }
  | { kind: 'Rec'; attempt: number };
/** One chunk side effect. */
export type PresentationChunkEffect = { kind: 'dispatch'; jobId: string } | { kind: 'chunk-done' } | { kind: 'candidate-failed'; code: string };
/** The unit's container job identity without its attempt number (§5.4). */
export type PresentationChunkIdentity =
  | { kind: 'presentation-count'; jobId: string }
  | { kind: 'presentation-chunk'; jobId: string; chunk: number }
  | { kind: 'presentation-stitch'; jobId: string }
  | { kind: 'presentation-edit'; jobId: string; chunk: number }
  | { kind: 'presentation-edit-stitch'; jobId: string };
type ChunkStep = PresentationStep<PresentationChunk, PresentationChunkEffect>;

/** A unit not submitted yet. */
export const NO_PRESENTATION_CHUNK: PresentationChunk = { state: 'none', attempt: 0, retries: 0, failure: null, attempts: [] };

/**
 * A new pending attempt item.
 * @param identity - The unit identity.
 * @param attempt - The attempt number.
 * @returns The item.
 * @throws {RangeError} When the attempt is not a positive integer.
 */
function pendingAttempt(identity: PresentationChunkIdentity, attempt: number): PresentationChunkAttempt {
  return { attempt, jobId: videoContainerJobId({ ...identity, attempt }), state: 'pending', usage: null, usageRecorded: false, failure: null };
}

/**
 * Replace one attempt item.
 * @param chunk - The chunk.
 * @param attempt - The attempt number.
 * @param change - The fields to change.
 * @returns The attempts with that item changed.
 * @throws {never} Never.
 */
function withAttempt(chunk: PresentationChunk, attempt: number, change: Partial<PresentationChunkAttempt>): PresentationChunkAttempt[] {
  return chunk.attempts.map((item) => (item.attempt === attempt ? { ...item, ...change } : item));
}

/**
 * Advance one chunk (§7.1.1): only the latest attempt moves the chunk; an older attempt records its receipt and usage;
 * the chunk fails, and fails the candidate with the underlying code, only when its latest attempt fails with no retry left.
 * @param chunk - The current chunk.
 * @param event - The attempt event.
 * @param identity - The unit's job identity without the attempt.
 * @returns The next chunk, its effects and whether the event was refused.
 * @throws {RangeError} When the identity cannot name a container job.
 */
export function advancePresentationChunk(chunk: PresentationChunk, event: PresentationChunkEvent, identity: PresentationChunkIdentity): ChunkStep {
  if (event.kind === 'Sub') {
    if (chunk.state === 'failed') return refused(chunk);
    if (chunk.state !== 'none') return kept(chunk);
    const first = pendingAttempt(identity, 1);
    return moved({ state: 'open', attempt: 1, retries: event.retries, failure: null, attempts: [first] }, [{ kind: 'dispatch', jobId: first.jobId }]);
  }
  if (event.kind === 'Exp') {
    if (chunk.state !== 'open') return kept(chunk);
    const attempts = chunk.attempts.map((item) => (item.state === 'pending' ? { ...item, state: 'failed' as const, failure: 'expired' } : item));
    return moved({ ...chunk, state: 'failed', failure: 'expired', attempts });
  }
  const item = chunk.attempts.find((entry) => entry.attempt === event.attempt);
  if (item === undefined) return refused(chunk);
  if (event.kind === 'Rec') {
    if (item.state === 'pending' || item.usage === null) return refused(chunk);
    return item.usageRecorded ? kept(chunk) : moved({ ...chunk, attempts: withAttempt(chunk, event.attempt, { usageRecorded: true }) });
  }
  const recordUsage = (usage: number | null): ChunkStep =>
    (usage === null || item.usage !== null ? kept(chunk) : moved({ ...chunk, attempts: withAttempt(chunk, event.attempt, { usage }) }));
  if (event.attempt !== chunk.attempt || chunk.state === 'failed' || item.state !== 'pending') {
    if (event.kind === 'Fail' && event.attempt === chunk.attempt && chunk.state === 'done') return refused(chunk);
    return recordUsage(event.usage);
  }
  if (event.kind === 'Done') {
    return moved({ ...chunk, state: 'done', attempts: withAttempt(chunk, event.attempt, { state: 'done', usage: event.usage }) }, [{ kind: 'chunk-done' }]);
  }
  const attempts = withAttempt(chunk, event.attempt, { state: 'failed', failure: event.code, usage: event.usage ?? item.usage });
  if (chunk.retries === 0) return moved({ ...chunk, state: 'failed', failure: event.code, attempts }, [{ kind: 'candidate-failed', code: event.code }]);
  const following = pendingAttempt(identity, chunk.attempt + 1);
  return moved({ ...chunk, attempt: chunk.attempt + 1, retries: chunk.retries - 1, attempts: [...attempts, following] }, [{ kind: 'dispatch', jobId: following.jobId }]);
}

/**
 * Whether the main job's container usage is all recorded: every attempt that measured usage has been recorded.
 * @param chunks - Every unit of the job.
 * @returns True when nothing measured is left unrecorded.
 * @throws {never} Never.
 */
export function presentationChunksUsageRecorded(chunks: readonly PresentationChunk[]): boolean {
  return chunks.every((chunk) => chunk.attempts.every((item) => item.usage === null || item.usageRecorded));
}

// ---------------------------------------------------------------- selected bundle P (§7.2)

/** A selected version's identity. */
export interface PresentationVersionRef { versionId: string; toolInputId: string }
/** The selected bundle. */
export type PresentationSelection =
  | { kind: 'unknown' }
  | { kind: 'ready'; version: PresentationVersionRef }
  | { kind: 'invalid'; version: PresentationVersionRef };
/** One selection event; Pub carries the publication gate G (`complete && current`). */
export type PresentationSelectionEvent =
  | { kind: 'Pub'; candidate: PresentationVersionRef; complete: boolean; current: boolean }
  | { kind: 'Chk'; proof: 'complete' | 'head-only' | 'none'; version: PresentationVersionRef }
  | { kind: 'Bad' } | { kind: 'New' } | { kind: 'Src' } | { kind: 'Late'; version: PresentationVersionRef };
/** One selection step: whether the candidate was published. */
export interface PresentationSelectionStep { next: PresentationSelection; published: boolean; waiting: boolean }

/**
 * Advance the selected bundle (§7.2): only a complete current Pub or a complete stored proof selects a version.
 * @param state - The current selection.
 * @param event - The event.
 * @returns The next selection and whether the candidate was published or is waiting.
 * @throws {never} Never.
 */
export function advanceSelectedPresentation(state: PresentationSelection, event: PresentationSelectionEvent): PresentationSelectionStep {
  const keep = { next: state, published: false, waiting: false };
  switch (event.kind) {
    case 'Pub': {
      if (!event.complete || !event.current) return keep;
      return { next: { kind: 'ready', version: event.candidate }, published: true, waiting: false };
    }
    case 'Chk':
      if (event.proof !== 'complete') return keep;
      if (state.kind === 'unknown') return { ...keep, next: { kind: 'ready', version: event.version } };
      if (state.kind === 'invalid' && state.version.versionId === event.version.versionId && state.version.toolInputId === event.version.toolInputId) {
        return { ...keep, next: { kind: 'ready', version: state.version } };
      }
      return keep;
    case 'Bad': return state.kind === 'ready' ? { ...keep, next: { kind: 'invalid', version: state.version } } : keep;
    case 'Src': return { ...keep, next: { kind: 'unknown' } };
    default: return keep;
  }
}

// ---------------------------------------------------------------- stored object roles R (§7.3)

/** One stored object's role state; only R0 (the current descriptor pointer) is replaced. */
export interface PresentationObject {
  kind: 'absent' | 'writing' | 'complete' | 'measured' | 'published' | 'invalid';
  role: 'R0' | 'other';
  receipt: string | null;
}
/** One object event, carrying the gate's verdict. */
export type PresentationObjectEvent =
  | { kind: 'Begin'; authorized: boolean }
  | { kind: 'Put'; won: boolean }
  | { kind: 'Measure'; matches: boolean; receipt: string }
  | { kind: 'Publish'; ok: boolean; receipt: string }
  | { kind: 'Stop'; committed: boolean | 'unknown' }
  | { kind: 'Verify'; complete: boolean; matches: boolean; receipt: string }
  | { kind: 'Replace'; receipt: string };

/**
 * Advance one stored object (§7.3): published only straight from measured, and invalid left only by a newly
 * authorized Begin or a complete proof.
 * @param object - The object.
 * @param event - The event.
 * @returns The next object and whether the event was refused.
 * @throws {never} Never.
 */
export function advancePresentationObject(object: PresentationObject, event: PresentationObjectEvent): { next: PresentationObject; rejected: boolean } {
  const keep = { next: object, rejected: false };
  const refuse = { next: object, rejected: true };
  const to = (kind: PresentationObject['kind'], receipt: string | null = null): { next: PresentationObject; rejected: boolean } => ({ next: { ...object, kind, receipt }, rejected: false });
  const { kind } = object;
  switch (event.kind) {
    case 'Begin':
      if (kind === 'writing' || kind === 'published') return refuse;
      return (kind === 'absent' || kind === 'invalid') && event.authorized ? to('writing') : keep;
    case 'Put':
      if (kind === 'absent' || kind === 'published') return refuse;
      return kind === 'writing' && event.won ? to('complete') : keep;
    case 'Measure':
      if (kind === 'writing') return refuse;
      if (kind === 'complete') return event.matches ? to('measured', event.receipt) : to('invalid');
      if (kind === 'measured') return event.matches ? keep : to('invalid');
      return keep;
    case 'Publish':
      if (kind === 'published') return event.receipt === object.receipt ? keep : refuse;
      if (kind !== 'measured') return refuse;
      return event.ok && event.receipt === object.receipt ? to('published', object.receipt) : keep;
    case 'Stop':
      if (kind !== 'writing' || event.committed === 'unknown') return keep;
      return event.committed ? to('complete') : to('absent');
    case 'Verify':
      if (kind === 'invalid') return event.complete && event.matches ? to('measured', event.receipt) : keep;
      if (kind === 'measured' || kind === 'published') return event.complete && event.matches ? keep : to('invalid');
      return keep;
    case 'Replace':
      return kind === 'published' && object.role === 'R0' ? to('published', event.receipt) : keep;
  }
}
