// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The canonical-key presentation Durable Object store (inner#1306; frames-split design §7.1–§7.4). Every write goes
 * through one pure transition of `video-presentation-state.ts`: the candidate A, the chunk set, the selected bundle P
 * (published only by `commitPresentationVersion`, which replaces the current descriptor R0 in R2 before the DO copy)
 * and the companion ledger L per toolInputId (ready only by `commitLedger`, failed only by `failLedger` or a physical
 * check). Physical facts are measured from R2, never taken from a caller.
 */

import {
  videoPresentationKeyFor, videoPresentationLedgerReceiptSchema, videoPresentationVersionSchema, videoSourceLedgerKeyFor, videoSourceLedgerTableKeyFor,
  type VideoPresentationAdmissionPolicy, type VideoPresentationIngestPricing, type VideoPresentationLedgerReceipt, type VideoPresentationProcessLimits,
  type VideoPresentationUsageFact, type VideoPresentationVersion,
} from '@breatic/shared';
import type { VideoPresentation, VideoPresentationRegisteredMetadata } from '@shared/upload/video-presentation-types.js';
import { videoDurationsMatch } from '@shared/upload/video-duration.js';
import type { VideoCarrierRoute } from '@shared/mini-tools/video-encode-plan.js';
import {
  advanceLedgerAdmission, advancePresentationCandidate, advancePresentationChunk, advancePresentationLedger, advanceSelectedPresentation,
  NO_PRESENTATION_CANDIDATE, NO_PRESENTATION_CHUNK,
  type PresentationCandidate, type PresentationCandidateEvent, type PresentationChunk, type PresentationLedgerEvent,
  type PresentationLedgerInstance, type PresentationLedgerItem, type PresentationSelection,
} from '@ingest/video-presentation-state.js';
import { hashStoredObject } from '@ingest/stored-object.js';

/** Backend-authorized admission of one canonical source's presentation work, frozen at the first accept. */
export interface VideoPresentationAdmission {
  storageKey: string;
  sourceFingerprint: string;
  jobId: string;
  deadlineAt: number;
  contentType: string;
  original: VideoPresentation['original'] | null;
  registeredMetadata?: VideoPresentationRegisteredMetadata;
  knownAlpha?: boolean;
  repair?: boolean;
  limits?: VideoPresentationProcessLimits;
  pricing?: VideoPresentationIngestPricing;
  targetPolicyVersion?: number;
  policy?: VideoPresentationAdmissionPolicy;
  actorUserId?: string;
  projectId?: string | null;
  packedURL?: string;
  manifestURL?: string;
  sourceLedgerURL?: string;
  sourceLedgerTableURL?: string;
}
/** One accepted job's identity. */
export interface PresentationJobIdentity { storageKey?: string; sourceFingerprint: string; jobId: string; deadlineAt: number }
/** One accepted job's private capability: its identity and the token `prepare` granted. */
export interface PresentationCapability extends PresentationJobIdentity { token: string }
/** The producer's declaration of its one write: the full ledger and the compact table written before it. */
export interface SourceLedgerDeclaration { producerVersion: 2; byteLength: number; table: { byteLength: number; frameCount: number }; planSha256?: string }
/** Durable authorization for one write of both objects, each under its own observed version. */
export interface SourceLedgerWriteClaim {
  owner: string; key: string; priorETag: string | null; byteLength: number;
  table: { key: string; priorETag: string | null; byteLength: number };
}
/** Facts measured from one stored object, never from an HTTP caller. */
export interface StoredObjectReceipt { etag: string; size: number; sha256: string }
/** Facts measured from both stored ledger objects. */
export interface SourceLedgerMeasurement extends StoredObjectReceipt { table: StoredObjectReceipt }
/** A job's measured container usage and whether its SQL record was acknowledged. */
export interface PresentationUsage { wallMs: number; cpuUsec: number | null; acknowledged: boolean }
/** A container unit of the candidate, without its job id. */
export type PresentationChunkUnit = { kind: 'presentation-chunk'; chunk: number } | { kind: 'presentation-stitch' } | { kind: 'presentation-copy' };
/** One unit report. */
export type PresentationChunkReport = { kind: 'Sub' } | { kind: 'Done'; attempt: number; usage: number } | { kind: 'Fail'; attempt: number; code: string; usage: number | null };
/** One reported fact of a job. */
export type PresentationReport =
  | { kind: 'verified'; bundle: { versionId: string; toolInputId: string; descriptor: unknown } }
  | { kind: 'finished'; usage: { wallMs: number; cpuUsec: number | null } };
/** What a read answers: the store's facts, before the route projects them to the ingest snapshot. */
export interface PresentationView {
  candidate: PresentationCandidate;
  archive: PresentationCandidate[];
  selected: PresentationSelection;
  /** The selected bundle while it is ready. */
  presentation: VideoPresentationVersion | null;
  targetPolicyVersion: number | null;
  ledgers: Record<string, PresentationLedgerInstance<VideoPresentationLedgerReceipt>>;
  chunks: Record<string, PresentationChunk>;
  usage: Record<string, PresentationUsage>;
  /** The current job's measured usage while unacknowledged. */
  usageFact?: VideoPresentationUsageFact;
}

/** Durable gate shared by the production container and the storage-only test object. */
export type PresentationStorageGate = <T>(work: () => Promise<T>) => Promise<T>;

interface JobRecord {
  admission: VideoPresentationAdmission;
  token: string;
  candidate: PresentationCandidate;
  item: PresentationLedgerItem;
  planSha256: string | null;
  bundle: unknown;
  chunks: Record<string, PresentationChunk>;
}
interface LedgerOnlyJob { admission: VideoPresentationAdmission; token: string; toolInputId: string }
interface ClaimRecord { claim: SourceLedgerWriteClaim; declaration: SourceLedgerDeclaration; planSha256: string; status: 'active' | 'released' | 'refused' }
/** A receipt and the physical proof it is checked against: the claim owner and the table's own ETag. */
interface ProvenReceipt { receipt: VideoPresentationLedgerReceipt; owner: string; tableETag: string }
interface LedgerRecord {
  instance: PresentationLedgerInstance<VideoPresentationLedgerReceipt>;
  planSha256: string;
  claims: Record<string, ClaimRecord>;
  proof: ProvenReceipt | null;
  /** L' receipts of archived jobs' completed streams, kept beside the instance for H2. */
  archived: Record<string, ProvenReceipt>;
}
interface PresentationState {
  sourceFingerprint: string;
  descriptorETag: string | null;
  current: JobRecord | null;
  archive: JobRecord[];
  ledgerJobs: Record<string, LedgerOnlyJob>;
  selected: PresentationSelection;
  presentation: VideoPresentationVersion | null;
  ledgers: Record<string, LedgerRecord>;
  usage: Record<string, PresentationUsage>;
}
type FoundJob = { kind: 'current' | 'archived'; job: JobRecord } | { kind: 'ledger'; job: LedgerOnlyJob };

// ponytail: one storage value holds the whole key's state, archive included; split per job if a key's archive grows past the value limit.
const STATE_KEY = 'video-presentation-v2';

/**
 * The unit key of a chunk report: its container job id without the attempt.
 * @param jobId - The main job.
 * @param unit - The unit.
 * @returns The key.
 * @throws {never} Never.
 */
function unitKey(jobId: string, unit: PresentationChunkUnit): string {
  if (unit.kind === 'presentation-chunk') return `video-presentation:${jobId}:chunk:${unit.chunk}`;
  return `video-presentation:${jobId}:${unit.kind === 'presentation-stitch' ? 'stitch' : 'copy'}`;
}

/**
 * Whether a candidate's work is over: no stage of it will run again.
 * @param candidate - The candidate.
 * @returns True when failed or verified.
 * @throws {never} Never.
 */
function workTerminal(candidate: PresentationCandidate | undefined): boolean {
  return candidate === undefined || candidate.state === 'failed' || candidate.state === 'verified';
}

/** One canonical key's presentation state machine over durable storage and R2. */
export class VideoPresentationStore {
  /**
   * Bind real durable state and R2 to one request serialization gate.
   * @param storage - This canonical key's Durable Object storage.
   * @param bucket - The canonical source and its companion objects.
   * @param gate - Serializes every transition.
   */
  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly bucket: R2Bucket,
    private readonly gate: PresentationStorageGate,
  ) {}

  /**
   * The one admission entry (Ad; Rt for repair): a new job archives the current candidate and hands its ledger writing
   * over in the same transaction; a repair of a verified candidate whose ledger is missing admits a ledger-only writer.
   * @param input - The registered source and requested work identity.
   * @returns The store view.
   * @throws {Error} When durable storage or R2 fails.
   */
  accept(input: VideoPresentationAdmission): Promise<PresentationView> {
    return this.gate(async () => {
      let state = await this.load();
      if (state?.sourceFingerprint !== input.sourceFingerprint) {
        const head = await this.bucket.head(videoPresentationKeyFor(input.storageKey));
        state = { sourceFingerprint: input.sourceFingerprint, descriptorETag: head?.etag ?? null, current: null, archive: [], ledgerJobs: {},
          selected: { kind: 'unknown' }, presentation: null, ledgers: {}, usage: {} };
      }
      const current = state.current;
      const known = current?.admission.jobId === input.jobId || input.jobId in state.ledgerJobs || state.archive.some((job) => job.admission.jobId === input.jobId);
      if (known) return this.view(state);
      if (input.repair === true && current !== null && !current.candidate.archived && current.candidate.state !== 'failed') {
        await this.repair(state, current, input);
      } else {
        if (current !== null) {
          await this.candidateEvent(state, current, { kind: 'Ar' });
          const archived = advanceLedgerAdmission(current.item, { kind: 'Ar' });
          current.item = archived.next;
          for (const effect of archived.effects) if (effect.kind === 'instance-wa') await this.ledgerEvent(state, effect.toolInputId, { kind: 'Wa', jobId: effect.jobId });
          state.archive.push(current);
        }
        const requested = input.limits?.sourceLedger !== undefined && input.sourceLedgerURL !== undefined && input.sourceLedgerTableURL !== undefined;
        state.current = {
          admission: { ...input }, token: crypto.randomUUID(),
          candidate: advancePresentationCandidate(NO_PRESENTATION_CANDIDATE, { kind: 'Ad', jobId: input.jobId, deadlineAt: input.deadlineAt }, this.policy(input)).next,
          item: advanceLedgerAdmission({ kind: 'absent', archived: false }, { kind: 'Ask', jobId: input.jobId, ledgerOnly: !requested }).next,
          planSha256: null, bundle: null, chunks: {},
        };
      }
      await this.save(state);
      return this.view(state);
    });
  }

  /**
   * Start the current job before its deadline (St), or a ledger-only job.
   * @param identity - The original identity.
   * @param now - The current time.
   * @returns The granted token, or null, and the view.
   * @throws {Error} When durable storage fails.
   */
  prepare(identity: PresentationJobIdentity, now: number): Promise<{ token: string | null; view: PresentationView }> {
    return this.gate(async () => {
      const state = await this.load();
      if (state === undefined) return { token: null, view: this.view(undefined) };
      const found = this.find(state, identity, null);
      let token: string | null = null;
      if (found?.kind === 'current') {
        const step = await this.candidateEvent(state, found.job, { kind: 'St', jobId: identity.jobId, now });
        if (!step.rejected) token = found.job.token;
        await this.save(state);
      } else if (found?.kind === 'ledger' && now < found.job.admission.deadlineAt) token = found.job.token;
      return { token, view: this.view(state) };
    });
  }

  /**
   * Record the plan fact (Tp): freeze the route and toolInputId, then let the toolInputId's instance decide the writer.
   * @param identity - The current job's capability.
   * @param plan - The route, toolInputId and plan digest.
   * @param plan.route - The carrier route.
   * @param plan.toolInputId - The tool input identity.
   * @param plan.planSha256 - The plan digest.
   * @returns Whether this job is the instance's writer, and the view.
   * @throws {Error} When durable storage fails.
   */
  planPresentation(identity: PresentationCapability, plan: { route: VideoCarrierRoute; toolInputId: string; planSha256: string }): Promise<{ writer: boolean; view: PresentationView }> {
    return this.gate(async () => {
      const state = await this.load();
      const found = state === undefined ? undefined : this.find(state, identity, identity.token);
      if (state === undefined || found?.kind !== 'current') return { writer: false, view: this.view(state) };
      const job = found.job;
      const instance = state.ledgers[plan.toolInputId]?.instance ?? { kind: 'absent' as const };
      const ledgerCode = instance.kind === 'failed-content' || instance.kind === 'failed-transient' ? { ledgerCode: instance.code } : {};
      const step = await this.candidateEvent(state, job, { kind: 'Ev', jobId: identity.jobId, fact: { kind: 'plan', route: plan.route, toolInputId: plan.toolInputId, ledger: instance.kind, ...ledgerCode } });
      if (!step.rejected) {
        job.planSha256 ??= plan.planSha256;
        const item = advanceLedgerAdmission(job.item, { kind: 'Tp', jobId: identity.jobId, toolInputId: plan.toolInputId });
        job.item = item.next;
        for (const effect of item.effects) {
          if (effect.kind !== 'instance-tp') continue;
          state.ledgers[effect.toolInputId] ??= { instance: { kind: 'absent' }, planSha256: plan.planSha256, claims: {}, proof: null, archived: {} };
          await this.ledgerEvent(state, effect.toolInputId, { kind: 'Tp', jobId: effect.jobId });
        }
        await this.save(state);
      }
      const after = state.ledgers[plan.toolInputId]?.instance;
      return { writer: after?.kind === 'pending' && after.writer === identity.jobId && job.candidate.toolInputId === plan.toolInputId, view: this.view(state) };
    });
  }

  /**
   * Move the current job to the next stage of its frozen route (Sg).
   * @param identity - The current job's capability.
   * @param stage - The requested stage.
   * @returns Whether the stage was recorded.
   * @throws {Error} When durable storage fails.
   */
  advanceStage(identity: PresentationCapability, stage: string): Promise<boolean> {
    return this.gate(async () => {
      const state = await this.load();
      const found = state === undefined ? undefined : this.find(state, identity, identity.token);
      if (state === undefined || found?.kind !== 'current') return false;
      const step = await this.candidateEvent(state, found.job, { kind: 'Sg', jobId: identity.jobId, stage });
      if (!step.rejected) await this.save(state);
      return !step.rejected;
    });
  }

  /**
   * Apply one chunk or attempt report; a chunk that fails for good fails the candidate with the underlying code.
   * @param identity - The job's capability.
   * @param unit - The unit.
   * @param report - The report.
   * @returns Whether the report was accepted.
   * @throws {Error} When durable storage fails.
   */
  reportChunk(identity: PresentationCapability, unit: PresentationChunkUnit, report: PresentationChunkReport): Promise<boolean> {
    return this.gate(async () => {
      const state = await this.load();
      const found = state === undefined ? undefined : this.find(state, identity, identity.token);
      if (state === undefined || found === undefined || found.kind === 'ledger') return false;
      const job = found.job;
      const key = unitKey(identity.jobId, unit);
      const chunkIdentity = { ...unit, jobId: identity.jobId };
      const event = report.kind === 'Sub' ? { kind: 'Sub' as const, retries: job.admission.policy?.chunkRetries ?? 0 } : report;
      const step = advancePresentationChunk(job.chunks[key] ?? NO_PRESENTATION_CHUNK, event, chunkIdentity);
      if (step.rejected) return false;
      job.chunks[key] = step.next;
      for (const effect of step.effects) {
        if (effect.kind === 'candidate-failed') await this.candidateEvent(state, job, { kind: 'Er', jobId: identity.jobId, code: effect.code });
      }
      await this.save(state);
      return true;
    });
  }

  /**
   * Record a job's fact (Ev verified with its bundle, or its measured usage); verified evidence of the current job
   * after its last work stage submits Pub.
   * @param identity - The job's capability.
   * @param fact - The fact.
   * @returns The view.
   * @throws {Error} When durable storage or R2 fails.
   */
  report(identity: PresentationCapability, fact: PresentationReport): Promise<PresentationView> {
    return this.gate(async () => {
      const state = await this.load();
      const found = state === undefined ? undefined : this.find(state, identity, identity.token);
      if (state === undefined || found === undefined || found.kind === 'ledger') return this.view(state);
      const job = found.job;
      if (fact.kind === 'finished') {
        state.usage[identity.jobId] ??= { wallMs: fact.usage.wallMs, cpuUsec: fact.usage.cpuUsec, acknowledged: false };
      } else {
        const wasVerified = job.candidate.state === 'verified';
        const step = advancePresentationCandidate(job.candidate, { kind: 'Ev', jobId: identity.jobId, fact: { kind: 'verified' } }, this.policy(job.admission));
        if (!wasVerified && step.next.state === 'verified') job.bundle = fact.bundle.descriptor;
        await this.applyCandidateStep(state, job, step);
      }
      await this.save(state);
      return this.view(state);
    });
  }

  /**
   * Fail a job's candidate with a stable code (Er); its ledger instance is not touched.
   * @param identity - The job's identity.
   * @param code - The failure code.
   * @returns The view.
   * @throws {Error} When durable storage fails.
   */
  fail(identity: PresentationJobIdentity, code: string): Promise<PresentationView> {
    return this.gate(async () => {
      const state = await this.load();
      const found = state === undefined ? undefined : this.find(state, identity, null);
      if (state === undefined || found === undefined || found.kind === 'ledger') return this.view(state);
      await this.candidateEvent(state, found.job, { kind: 'Er', jobId: identity.jobId, code });
      await this.save(state);
      return this.view(state);
    });
  }

  /**
   * Acknowledge a job's usage once its unique SQL record committed.
   * @param identity - The measured job.
   * @returns The view.
   * @throws {Error} When durable storage fails.
   */
  acknowledgeUsage(identity: PresentationJobIdentity): Promise<PresentationView> {
    return this.gate(async () => {
      const state = await this.load();
      const usage = state === undefined || this.find(state, identity, null) === undefined ? undefined : state.usage[identity.jobId];
      if (usage !== undefined && !usage.acknowledged) { usage.acknowledged = true; await this.save(state!); }
      return this.view(state);
    });
  }

  /**
   * Read the current facts, checking the stored descriptor and every ready ledger against R2, recovering the writer's
   * uncommitted objects and attaching an archived job's receipt under the H2 conditions.
   * @param storageKey - Registered canonical key.
   * @param sourceFingerprint - Registered SHA-256.
   * @returns The view; empty for another source.
   * @throws {Error} When durable storage or R2 fails.
   */
  read(storageKey: string, sourceFingerprint: string): Promise<PresentationView> {
    return this.gate(async () => {
      const state = await this.load();
      if (state?.sourceFingerprint !== sourceFingerprint) return this.view(undefined);
      if (state.selected.kind === 'ready') {
        const head = await this.bucket.head(videoPresentationKeyFor(storageKey));
        if (head === null || head.etag !== state.descriptorETag) state.selected = advanceSelectedPresentation(state.selected, { kind: 'Bad' }).next;
      }
      for (const [toolInputId, record] of Object.entries(state.ledgers)) {
        const instance = record.instance;
        if (instance.kind === 'ready' && record.proof !== null) {
          const failure = await this.checkReceipt(storageKey, record.proof);
          if (failure !== null) await this.ledgerEvent(state, toolInputId, { kind: 'Check', failure });
        } else if (instance.kind === 'pending' && !instance.writerArchived) {
          await this.recoverWrite(state, storageKey, toolInputId, record, instance.writer);
        } else if (instance.kind === 'absent' || instance.kind === 'failed-transient') {
          await this.attachArchived(state, storageKey, toolInputId, record);
        }
      }
      await this.save(state);
      return this.view(state);
    });
  }

  /**
   * Reserve the toolInputId's writer before bytes reach R2.
   * @param identity - The writer's capability.
   * @param toolInputId - The instance.
   * @param declaration - The producer's declared lengths and frame count.
   * @returns One persisted claim, or a refusal.
   * @throws {Error} When durable storage or R2 cannot be read.
   */
  claimSourceLedger(identity: PresentationCapability, toolInputId: string, declaration: SourceLedgerDeclaration): Promise<SourceLedgerWriteClaim | null> {
    return this.gate(async () => {
      const state = await this.load();
      const found = state === undefined ? undefined : this.find(state, identity, identity.token);
      const record = state?.ledgers[toolInputId];
      if (found === undefined || found.kind === 'archived' || record === undefined || identity.deadlineAt <= Date.now()) return null;
      const { admission } = found.job;
      const instance = record.instance;
      const limits = admission.limits?.sourceLedger;
      const within = (value: unknown, ceiling: number): boolean => Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= ceiling;
      if (instance.kind !== 'pending' || instance.writer !== identity.jobId || instance.writerArchived || identity.jobId in record.claims ||
        limits === undefined || admission.sourceLedgerURL === undefined || admission.sourceLedgerTableURL === undefined ||
        (declaration.planSha256 !== undefined && declaration.planSha256 !== record.planSha256) ||
        declaration.producerVersion !== 2 || !within(declaration.byteLength, limits.maxBytes) || !within(declaration.table?.byteLength, limits.maxBytes) ||
        !within(declaration.table.frameCount, Number.MAX_SAFE_INTEGER)) return null;
      const key = videoSourceLedgerKeyFor(admission.storageKey);
      const tableKey = videoSourceLedgerTableKeyFor(admission.storageKey);
      const [head, tableHead] = await Promise.all([this.bucket.head(key), this.bucket.head(tableKey)]);
      const claim = { owner: crypto.randomUUID(), key, priorETag: head?.etag ?? null, byteLength: declaration.byteLength,
        table: { key: tableKey, priorETag: tableHead?.etag ?? null, byteLength: declaration.table.byteLength } };
      const planSha256 = found.kind === 'current' ? found.job.planSha256 ?? record.planSha256 : record.planSha256;
      record.claims[identity.jobId] = { claim, planSha256, status: 'active',
        declaration: { producerVersion: 2, byteLength: declaration.byteLength, table: { byteLength: declaration.table.byteLength, frameCount: declaration.table.frameCount } } };
      await this.save(state!);
      return claim;
    });
  }

  /**
   * Commit both measured objects of an active claim (Both): the writer's commit makes the instance ready; an archived
   * job's completed stream is kept beside the instance for H2.
   * @param identity - The claiming job's capability.
   * @param toolInputId - The instance.
   * @param owner - The claim owner.
   * @param measured - Actual stored byte facts of both objects.
   * @returns Whether the instance is now ready with this receipt.
   * @throws {Error} When durable storage or R2 fails.
   */
  commitLedger(identity: PresentationCapability, toolInputId: string, owner: string, measured: SourceLedgerMeasurement): Promise<boolean> {
    return this.gate(async () => {
      const state = await this.load();
      const found = state === undefined ? undefined : this.find(state, identity, identity.token);
      const record = state?.ledgers[toolInputId];
      const claimed = record?.claims[identity.jobId];
      if (state === undefined || found === undefined || record === undefined || claimed?.claim.owner !== owner || claimed.status !== 'active') return false;
      const proven = await this.measuredReceipt(found.job.admission, toolInputId, claimed, measured);
      if (proven === null) { claimed.status = 'refused'; await this.save(state); return false; }
      const ready = await this.commitProven(state, toolInputId, record, identity.jobId, proven, found.kind === 'archived');
      await this.save(state);
      return ready;
    });
  }

  /**
   * Fail the toolInputId's instance with the writer's code (Err); candidate codes are never stored.
   * @param identity - The job's capability.
   * @param toolInputId - The instance.
   * @param code - The failure code.
   * @returns Whether the event was accepted.
   * @throws {Error} When durable storage fails.
   */
  failLedger(identity: PresentationCapability, toolInputId: string, code: string): Promise<boolean> {
    return this.gate(async () => {
      const state = await this.load();
      const found = state === undefined ? undefined : this.find(state, identity, identity.token);
      if (state === undefined || found === undefined || state.ledgers[toolInputId] === undefined) return false;
      const step = await this.ledgerEvent(state, toolInputId, { kind: 'Err', jobId: identity.jobId, code });
      if (!step.rejected) await this.save(state);
      return !step.rejected;
    });
  }

  /**
   * Release a failed write's own claim; its objects stay recoverable by the writer.
   * @param identity - The job's capability.
   * @param toolInputId - The instance.
   * @param owner - The claim owner.
   * @returns Nothing after release.
   * @throws {Error} When durable storage fails.
   */
  releaseSourceLedger(identity: PresentationCapability, toolInputId: string, owner: string): Promise<void> {
    return this.gate(async () => {
      const state = await this.load();
      const claimed = state === undefined || this.find(state, identity, identity.token) === undefined ? undefined : state.ledgers[toolInputId]?.claims[identity.jobId];
      if (claimed?.claim.owner !== owner || claimed.status !== 'active') return;
      claimed.status = 'released';
      await this.save(state!);
    });
  }

  /**
   * A repair admission of an active candidate (Rt): a verified candidate whose ledger is missing gets a ledger-only
   * writer of the same toolInputId (§5.2); active work replays.
   * @param state - The state.
   * @param current - The current job.
   * @param input - The repair admission.
   * @returns Nothing.
   * @throws {Error} When R2 fails.
   */
  private async repair(state: PresentationState, current: JobRecord, input: VideoPresentationAdmission): Promise<void> {
    const toolInputId = current.candidate.toolInputId;
    const kind = toolInputId === null ? 'absent' : state.ledgers[toolInputId]?.instance.kind ?? 'absent';
    const step = await this.candidateEvent(state, current, { kind: 'Rt', jobId: input.jobId, deadlineAt: input.deadlineAt, ledgerMissing: kind !== 'ready' && kind !== 'pending' });
    for (const effect of step.effects) {
      if (effect.kind !== 'repair-ledger') continue;
      state.ledgers[effect.toolInputId] ??= { instance: { kind: 'absent' }, planSha256: current.planSha256!, claims: {}, proof: null, archived: {} };
      const repaired = await this.ledgerEvent(state, effect.toolInputId, { kind: 'Repair', jobId: input.jobId });
      if (repaired.effects.some((entry) => entry.kind === 'write')) {
        state.ledgerJobs[input.jobId] = { admission: { ...input }, token: crypto.randomUUID(), toolInputId: effect.toolInputId };
      }
    }
  }

  /**
   * Apply one candidate event and its effects.
   * @param state - The state.
   * @param job - The job.
   * @param event - The event.
   * @returns The step.
   * @throws {Error} When publication fails.
   */
  private async candidateEvent(state: PresentationState, job: JobRecord, event: PresentationCandidateEvent): Promise<ReturnType<typeof advancePresentationCandidate>> {
    const step = advancePresentationCandidate(job.candidate, event, this.policy(job.admission));
    await this.applyCandidateStep(state, job, step);
    return step;
  }

  /**
   * Persist a candidate step into its job and publish when it asks to; dispatch and repair effects are the caller's.
   * @param state - The state.
   * @param job - The job.
   * @param step - The step.
   * @returns Nothing.
   * @throws {Error} When publication fails.
   */
  private async applyCandidateStep(state: PresentationState, job: JobRecord, step: ReturnType<typeof advancePresentationCandidate>): Promise<void> {
    job.candidate = step.next;
    // ponytail: an Lt auto repair (repair-ledger) is recorded as a counted attempt only; the worker admits the repair job through accept.
    if (step.effects.some((effect) => effect.kind === 'publish')) await this.commitPresentationVersion(state, job);
  }

  /**
   * Apply one instance event and hand its Lr/Lt/Lc and candidate failures to the current candidate of that toolInputId.
   * @param state - The state.
   * @param toolInputId - The instance.
   * @param event - The event.
   * @returns The step.
   * @throws {Error} When publication fails.
   */
  private async ledgerEvent(state: PresentationState, toolInputId: string, event: PresentationLedgerEvent<VideoPresentationLedgerReceipt>): Promise<ReturnType<typeof advancePresentationLedger<VideoPresentationLedgerReceipt>>> {
    const record = state.ledgers[toolInputId];
    const step = advancePresentationLedger(record?.instance ?? { kind: 'absent' }, event);
    if (record === undefined || step.rejected) return step;
    record.instance = step.next;
    const job = state.current;
    if (job === null || job.candidate.toolInputId !== toolInputId) return step;
    const selected = state.selected.kind === 'ready' && job.bundle !== null && state.selected.version.versionId === (job.bundle as { versionId?: unknown }).versionId;
    for (const effect of step.effects) {
      if (effect.kind === 'Lr' || effect.kind === 'Lt') await this.candidateEvent(state, job, { kind: effect.kind, toolInputId, selected });
      if (effect.kind === 'Lc') await this.candidateEvent(state, job, { kind: 'Lc', toolInputId, code: effect.code, selected });
      if (effect.kind === 'candidate-failed') await this.candidateEvent(state, job, { kind: 'Er', jobId: job.admission.jobId, code: effect.code });
    }
    return step;
  }

  /**
   * Submit Pub for a verified job: physical completeness, currency and the toolInputId's ledger decide the selection;
   * the current descriptor (R0) is replaced in R2 under its observed ETag before the DO selects it.
   * @param state - The state.
   * @param job - The verified job.
   * @returns Nothing.
   * @throws {Error} When R2 fails.
   */
  private async commitPresentationVersion(state: PresentationState, job: JobRecord): Promise<void> {
    const parsed = videoPresentationVersionSchema.safeParse(job.bundle);
    if (!parsed.success) return;
    const bundle = parsed.data;
    const complete = await this.bundleComplete(state, job, bundle);
    const current = state.current === job && !job.candidate.archived;
    const step = advanceSelectedPresentation(state.selected, { kind: 'Pub', candidate: { versionId: bundle.versionId, toolInputId: bundle.toolInputId },
      complete, current, ledgerReady: state.ledgers[bundle.toolInputId]?.instance.kind === 'ready' });
    if (!step.published) return;
    const written = await this.bucket.put(videoPresentationKeyFor(job.admission.storageKey), JSON.stringify(bundle), {
      onlyIf: state.descriptorETag === null ? { etagDoesNotMatch: '*' } : { etagMatches: state.descriptorETag }, httpMetadata: { contentType: 'application/json' },
    });
    if (written === null) return;
    state.descriptorETag = written.etag;
    state.selected = step.next;
    state.presentation = bundle;
  }

  /**
   * Whether a bundle belongs to this job and every object it names is stored with the measured bytes (§7.2, §3.1).
   * @param state - The state.
   * @param job - The job.
   * @param bundle - The parsed bundle.
   * @returns True when complete.
   * @throws {Error} When R2 fails.
   */
  private async bundleComplete(state: PresentationState, job: JobRecord, bundle: VideoPresentationVersion): Promise<boolean> {
    const registered = job.admission.registeredMetadata;
    const original = bundle.original;
    if (bundle.sourceFingerprint !== state.sourceFingerprint || bundle.toolInputId !== job.candidate.toolInputId || bundle.planSha256 !== job.planSha256 ||
      (registered !== undefined && ((registered.width !== null && registered.width !== original.width) || (registered.height !== null && registered.height !== original.height) ||
        (registered.duration !== null && (original.duration === null || !videoDurationsMatch(original.duration, registered.duration)))))) return false;
    const objects = bundle.playback.kind === 'alpha-packed' ? [bundle.playback.carrier, bundle.playback.manifest] : [bundle.playback.carrier];
    const heads = await Promise.all(objects.map((object) => this.bucket.head(object.storageKey)));
    return objects.every((object, index) => heads[index] !== null && heads[index]!.etag === object.etag && heads[index]!.size === object.size &&
      heads[index]!.httpMetadata?.contentType === object.contentType);
  }

  /**
   * Build the S6a receipt of a claim's objects after checking them against the claim and the measurement.
   * @param admission - The claiming job's admission.
   * @param toolInputId - The instance.
   * @param claimed - The claim.
   * @param measured - The writer's measurement.
   * @returns The proven receipt, or null when the stored objects disagree.
   * @throws {Error} When R2 fails.
   */
  private async measuredReceipt(admission: VideoPresentationAdmission, toolInputId: string, claimed: ClaimRecord, measured: SourceLedgerMeasurement): Promise<ProvenReceipt | null> {
    const [object, table] = await Promise.all([this.bucket.head(claimed.claim.key), this.bucket.head(claimed.claim.table.key)]);
    if (!this.claimOwns(admission, claimed, object, table) || object!.etag !== measured.etag || object!.size !== measured.size ||
      table!.etag !== measured.table.etag || table!.size !== measured.table.size) return null;
    const parsed = videoPresentationLedgerReceiptSchema.safeParse({
      schemaVersion: 2, sourceFingerprint: admission.sourceFingerprint, toolInputId, planSha256: claimed.planSha256, producerVersion: claimed.declaration.producerVersion,
      attempt: { jobId: admission.jobId, deadlineAt: admission.deadlineAt }, url: admission.sourceLedgerURL,
      etag: measured.etag, size: measured.size, sha256: measured.sha256, contentType: 'application/json',
      table: { url: admission.sourceLedgerTableURL, sha256: measured.table.sha256, size: measured.table.size, contentType: 'application/json', frameCount: claimed.declaration.table.frameCount },
    });
    return parsed.success ? { receipt: parsed.data, owner: claimed.claim.owner, tableETag: measured.table.etag } : null;
  }

  /**
   * Whether both stored objects are the ones this claim declared: size, type, budget and the owner metadata.
   * @param admission - The claiming job's admission.
   * @param claimed - The claim.
   * @param object - The full ledger's headers.
   * @param table - The compact table's headers.
   * @returns True when both belong to the claim.
   * @throws {never} Never.
   */
  private claimOwns(admission: VideoPresentationAdmission, claimed: ClaimRecord, object: R2Object | null, table: R2Object | null): boolean {
    const maxBytes = admission.limits?.sourceLedger?.maxBytes ?? 0;
    const owned = (stored: R2Object | null, byteLength: number): boolean => stored !== null && stored.size === byteLength && stored.size > 0 &&
      stored.size <= maxBytes && stored.httpMetadata?.contentType === 'application/json' &&
      stored.customMetadata?.sourceLedgerJobId === admission.jobId && stored.customMetadata.sourceLedgerClaimOwner === claimed.claim.owner;
    return owned(object, claimed.claim.byteLength) && owned(table, claimed.claim.table.byteLength);
  }

  /**
   * Hand a proven receipt to the instance (Both) and keep what the instance did not take.
   * @param state - The state.
   * @param toolInputId - The instance.
   * @param record - Its record.
   * @param jobId - The committing job.
   * @param proven - The proven receipt.
   * @param archivedJob - Whether the committing job is archived.
   * @returns Whether the instance is ready with this receipt.
   * @throws {Error} When publication fails.
   */
  private async commitProven(state: PresentationState, toolInputId: string, record: LedgerRecord, jobId: string, proven: ProvenReceipt, archivedJob: boolean): Promise<boolean> {
    const current = state.current;
    const samePlan = current !== null && current.candidate.toolInputId === toolInputId && current.planSha256 === proven.receipt.planSha256;
    const step = await this.ledgerEvent(state, toolInputId, { kind: 'Both', jobId, receipt: proven.receipt, startedStreamProof: true, workTerminal: workTerminal(current?.candidate), samePlan });
    const claimed = record.claims[jobId]!;
    claimed.status = 'released';
    if ((step.rejected && archivedJob) || step.effects.some((effect) => effect.kind === 'archive-receipt')) record.archived[jobId] = proven;
    if (step.rejected || record.instance.kind !== 'ready') return false;
    if (step.effects.some((effect) => effect.kind === 'Lr')) record.proof = proven;
    return record.proof?.receipt.etag === proven.receipt.etag && record.proof.owner === proven.owner;
  }

  /**
   * Check a ready receipt against both stored objects (§7.4 Check).
   * @param storageKey - The canonical key.
   * @param proof - The receipt and its physical proof.
   * @returns The failure code, or null when both objects are the committed ones.
   * @throws {Error} When R2 fails.
   */
  private async checkReceipt(storageKey: string, proof: ProvenReceipt): Promise<'source_ledger_missing' | 'source_ledger_invalid' | null> {
    const [object, table] = await Promise.all([this.bucket.head(videoSourceLedgerKeyFor(storageKey)), this.bucket.head(videoSourceLedgerTableKeyFor(storageKey))]);
    if (object === null || table === null) return 'source_ledger_missing';
    const owned = (stored: R2Object): boolean => stored.httpMetadata?.contentType === 'application/json' &&
      stored.customMetadata?.sourceLedgerJobId === proof.receipt.attempt.jobId && stored.customMetadata.sourceLedgerClaimOwner === proof.owner;
    return owned(object) && owned(table) && object.etag === proof.receipt.etag && object.size === proof.receipt.size &&
      table.etag === proof.tableETag && table.size === proof.receipt.table.size ? null : 'source_ledger_invalid';
  }

  /**
   * Recover the writer's objects that were stored but whose commit call was lost, measured from R2.
   * @param state - The state.
   * @param storageKey - The canonical key.
   * @param toolInputId - The instance.
   * @param record - Its record.
   * @param writer - The pending writer.
   * @returns Nothing.
   * @throws {Error} When R2 fails.
   */
  private async recoverWrite(state: PresentationState, storageKey: string, toolInputId: string, record: LedgerRecord, writer: string): Promise<void> {
    const claimed = record.claims[writer];
    const found = this.find(state, { sourceFingerprint: state.sourceFingerprint, jobId: writer, deadlineAt: Number.NaN }, null, true);
    // Only a released claim: its writer stopped waiting for the commit answer; an active claim's commit is still to come.
    if (claimed?.status !== 'released' || found === undefined) return;
    const [object, table] = await Promise.all([this.bucket.head(claimed.claim.key), this.bucket.head(claimed.claim.table.key)]);
    if (!this.claimOwns(found.job.admission, claimed, object, table)) return;
    const measured = { etag: object!.etag, size: object!.size, sha256: await hashStoredObject(this.bucket, claimed.claim.key),
      table: { etag: table!.etag, size: table!.size, sha256: await hashStoredObject(this.bucket, claimed.claim.table.key) } };
    const proven = await this.measuredReceipt(found.job.admission, toolInputId, claimed, measured);
    if (proven !== null && proven.receipt.attempt.jobId === writer && storageKey === found.job.admission.storageKey) {
      await this.commitProven(state, toolInputId, record, writer, proven, false);
    }
  }

  /**
   * H2: attach an archived job's receipt when the current work is terminal, no writer is active, nothing is ready and
   * the toolInputId and plan are the same, after checking its objects are still the committed ones.
   * @param state - The state.
   * @param storageKey - The canonical key.
   * @param toolInputId - The instance.
   * @param record - Its record.
   * @returns Nothing.
   * @throws {Error} When R2 fails.
   */
  private async attachArchived(state: PresentationState, storageKey: string, toolInputId: string, record: LedgerRecord): Promise<void> {
    const current = state.current;
    for (const proven of Object.values(record.archived)) {
      const samePlan = current !== null && current.candidate.toolInputId === toolInputId && current.planSha256 === proven.receipt.planSha256;
      if (!workTerminal(current?.candidate) || !samePlan || await this.checkReceipt(storageKey, proven) !== null) continue;
      const step = await this.ledgerEvent(state, toolInputId, { kind: 'H2', receipt: proven.receipt, workTerminal: true, samePlan: true });
      if (record.instance.kind === 'ready' && !step.rejected) { record.proof = proven; return; }
    }
  }

  /**
   * Locate a job by its identity: the current candidate, an archived one or a ledger-only writer.
   * @param state - The state.
   * @param identity - The identity.
   * @param token - The token to require, or null when the caller is the trusted backend.
   * @param byJobOnly - Match the job id alone.
   * @returns The job, or undefined.
   * @throws {never} Never.
   */
  private find(state: PresentationState, identity: PresentationJobIdentity, token: string | null, byJobOnly = false): FoundJob | undefined {
    const matches = (admission: VideoPresentationAdmission, held: string): boolean => admission.jobId === identity.jobId &&
      (byJobOnly || (admission.sourceFingerprint === identity.sourceFingerprint && admission.deadlineAt === identity.deadlineAt && (token === null || held === token)));
    if (state.current !== null && matches(state.current.admission, state.current.token)) return { kind: 'current', job: state.current };
    const archived = state.archive.find((job) => matches(job.admission, job.token));
    if (archived !== undefined) return { kind: 'archived', job: archived };
    const ledger = state.ledgerJobs[identity.jobId];
    return ledger !== undefined && matches(ledger.admission, ledger.token) ? { kind: 'ledger', job: ledger } : undefined;
  }

  /**
   * The caps frozen into an admission.
   * @param admission - The admission.
   * @returns The candidate policy.
   * @throws {never} Never.
   */
  private policy(admission: VideoPresentationAdmission): { maxAutoRepairs: number } {
    return { maxAutoRepairs: admission.policy?.maxAutoRepairs ?? 0 };
  }

  /**
   * The view of the state.
   * @param state - The state, or undefined before any admission.
   * @returns The view.
   * @throws {never} Never.
   */
  private view(state: PresentationState | undefined): PresentationView {
    const current = state?.current ?? null;
    const jobs = state === undefined ? [] : [...state.archive, ...(current === null ? [] : [current])];
    const usage = current === null ? undefined : state!.usage[current.admission.jobId];
    const { pricing, actorUserId, projectId } = current?.admission ?? {};
    return {
      candidate: current?.candidate ?? NO_PRESENTATION_CANDIDATE,
      archive: state?.archive.map((job) => job.candidate) ?? [],
      selected: state?.selected ?? { kind: 'unknown' },
      presentation: state?.selected.kind === 'ready' ? state.presentation : null,
      targetPolicyVersion: current?.admission.targetPolicyVersion ?? null,
      ledgers: Object.fromEntries(Object.entries(state?.ledgers ?? {}).map(([toolInputId, record]) => [toolInputId, record.instance])),
      chunks: Object.assign({}, ...jobs.map((job) => job.chunks)) as Record<string, PresentationChunk>,
      usage: state?.usage ?? {},
      // Usage is billed at the basic price: the presentation job's own container is basic (§5.1 step 2).
      ...(usage !== undefined && !usage.acknowledged && pricing !== undefined && actorUserId !== undefined ? {
        usageFact: { jobId: current!.admission.jobId, actorUserId, projectId: projectId ?? null, usage: { wallMs: usage.wallMs, cpuUsec: usage.cpuUsec }, pricing: pricing.basic },
      } : {}),
    };
  }

  /**
   * Load the state.
   * @returns The state, or undefined before any admission.
   * @throws {Error} When storage fails.
   */
  private load(): Promise<PresentationState | undefined> {
    return this.storage.get<PresentationState>(STATE_KEY);
  }

  /**
   * Persist the state.
   * @param state - The state.
   * @returns Nothing.
   * @throws {Error} When storage fails.
   */
  private save(state: PresentationState): Promise<void> {
    return this.storage.put(STATE_KEY, state);
  }
}
