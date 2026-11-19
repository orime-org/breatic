// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The canonical-key presentation Durable Object store (inner#1306; frames-split design §7.1–§7.4). Every write goes
 * through one pure transition of `video-presentation-state.ts`: the candidate A, the chunk set, the selected bundle P
 * (published only by `commitPresentationVersion`, which replaces the current descriptor R0 in R2 before the DO copy)
 * and the companion ledger L per toolInputId (ready only by `commitLedger`, failed only by `failLedger` or a physical
 * check). Physical facts are measured from R2, never taken from a caller.
 */

import {
  alphaPackedManifestMatchesVersion, alphaPackedManifestSchema, videoPresentationDoneReceiptsSchema, videoPresentationKeyFor, videoPresentationLedgerReceiptSchema, videoPresentationObjectURL, videoPresentationVersionId, videoPresentationVersionSchema,
  videoPresentationWorkKeyFor, videoSourceLedgerKeyFor, videoSourceLedgerTableKeyFor,
  type VideoPresentationAdmissionPolicy, type VideoPresentationProbeFacts, type VideoPresentationOutputReceipt, type VideoPresentationChunkReport, type VideoPresentationChunkUnit,
  type VideoPresentationEncoding, type VideoPresentationIngestLedger, type VideoPresentationIngestPricing, type VideoPresentationIngestSnapshot,
  type VideoPresentationLedger, type VideoPresentationLedgerReceipt, type VideoPresentationPrepareAnswer, type VideoPresentationProcessLimits, type VideoPresentationUsageFact,
  type VideoPresentationVersion,
} from '@breatic/shared';
import type { VideoPresentation, VideoPresentationRegisteredMetadata } from '@shared/upload/video-presentation-types.js';
import { videoDurationsMatch } from '@shared/upload/video-duration.js';
import {
  chooseVideoCarrierRoute, estimateAudioEncodeSeconds, estimateVideoJobSeconds, planVideoEncodeChunks, presentationEncodeFailure, videoCarrierRouteStages, videoContainerJobId,
  type VideoCarrierIdentity, type VideoCarrierRoute, type VideoCarrierStage, type VideoCarrierRouteInput, type VideoEncodeChunk, type VideoJobWork,
} from '@shared/mini-tools/video-encode-plan.js';
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
  encoding?: VideoPresentationEncoding;
  /** The probe's sampled frames, the single-frame duration and the identity table (design §5.1 step 2, §4.1). */
  probe?: VideoPresentationProbeFacts;
  actorUserId?: string;
  projectId?: string | null;
  /** Every derived object's public URL is this base joined to its key. */
  publicBaseURL?: string;
  /** A discovery read's condition, re-checked in the serial entry and never stored (§3.5). */
  expect?: 'first' | 'readmit';
  /** The invalid version this candidate was readmitted for; set by the DO on a passed readmit (§7.1). */
  readmitOf?: string;
}
/** One accepted job's identity. */
export interface PresentationJobIdentity { storageKey?: string; sourceFingerprint: string; jobId: string; deadlineAt: number }
/** A job named without its deadline: the deadline lives in the DO admission record (§5.1 step 1). */
export interface PresentationJobRef { storageKey: string; sourceFingerprint: string; jobId: string }
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
export type PresentationChunkUnit = VideoPresentationChunkUnit;
/** One unit report; a stitch or copy Done carries the job DO's measured receipt of its carrier. */
export type PresentationChunkReport = VideoPresentationChunkReport;
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
  /** P is invalid(V) and V's publisher is current: `readmit` when it was admitted without readmitOf, else `presentation_invalid` (§3.5). */
  invalidPublisher?: 'readmit' | 'presentation_invalid';
}

/** What a basic execution needs before it plans. */
export interface PresentationGrant {
  /** The granted capability; null when the job is unknown, archived, past its deadline or refused St. */
  capability: PresentationCapability | null;
  /** Whether the job planned already (or cannot plan any more): a replay never probes again. */
  planned: boolean;
  /** For a ledger-only repair writer, the toolInputId it writes. */
  ledgerOnly: string | null;
  admission: VideoPresentationAdmission | null;
  /** The selected version's identity, from which the reuse route is decided. */
  selected: VideoCarrierIdentity | null;
}

/** Durable gate shared by the production container and the storage-only test object. */
export type PresentationStorageGate = <T>(work: () => Promise<T>) => Promise<T>;

/** What `preparePresentation` records with the plan: the route, its work and the plan-derived facts the DO publishes from. */
export interface PresentationPlanFacts {
  route: VideoCarrierRoute;
  toolInputId: string;
  planSha256: string;
  producerVersion: number;
  profileVersion: number;
  display: VideoPresentationVersion['display'];
  playbackClock: VideoPresentationVersion['playbackClock'];
  work: VideoPresentationPrepareAnswer['work'];
  /** The source audio for a dispatched copy, from the probe: copied when audioCopyable, encoded otherwise, null without audio. */
  copyAudio: 'copy' | 'encode' | null;
}
interface JobRecord {
  admission: VideoPresentationAdmission;
  token: string;
  candidate: PresentationCandidate;
  item: PresentationLedgerItem;
  planSha256: string | null;
  bundle: unknown;
  chunks: Record<string, PresentationChunk>;
  prepared?: PresentationPlanFacts;
  /** The role-tagged output receipts of the attempt that completed each stitch or copy unit (§90 E4-15). */
  receipts?: Record<string, VideoPresentationOutputReceipt[]>;
  /** The basic copy's carrier writes by key: claimed before any byte, then the Worker's measurement (§91 D2-2). */
  carrierWrites?: Record<string, CarrierWrite>;
  /** The ready selected version at the grant that planned, which a reuse route copies (§7.1). */
  reuseFrom?: string;
}
/** One claimed carrier write; insert-only, so a key is written once. */
interface CarrierWrite { owner: string; byteLength: number; contentType: string; measured: PresentationCarrierMeasurement | null }
/** What the Worker measured of a carrier it wrote. */
export interface PresentationCarrierMeasurement { storageKey: string; etag: string; sha256: string; sizeBytes: number; contentType: string }
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

/**
 * One instance in the §10.1 wire states: absent is null, both failure kinds are `failed` with their code.
 * @param instance - The store instance, if any.
 * @returns The wire ledger.
 * @throws {never} Never.
 */
export function wireLedger(instance: PresentationLedgerInstance<NonNullable<VideoPresentationIngestLedger['receipt']>> | undefined): VideoPresentationIngestLedger | null {
  if (instance === undefined || instance.kind === 'absent') return null;
  switch (instance.kind) {
    case 'pending': return { state: 'pending', receipt: null, failure: null };
    case 'ready': return { state: 'ready', receipt: instance.receipt, failure: null };
    default: return { state: 'failed', receipt: null, failure: instance.code };
  }
}

/**
 * Project the store view to the ingest snapshot (§3.5 response row, §5.1 step 6): the selected bundle, the target
 * policy's preparation and the L state of the selected toolInputId alone, never the full arrays or every instance.
 * @param view - The store view; a stand-in answering another shape projects to nothing selected.
 * @param storageKey - The registered key.
 * @param sourceFingerprint - The source fingerprint.
 * @returns The snapshot.
 * @throws {never} Never.
 */
export function presentationSnapshot(view: Partial<PresentationView>, storageKey: string, sourceFingerprint: string): VideoPresentationIngestSnapshot {
  const presentation = view.presentation ?? null;
  const candidate = view.candidate;
  // presentation_invalid exists only in this projection: the readmitted publisher's version failed again, not the candidate (§10.6).
  const failure = view.invalidPublisher === 'presentation_invalid' ? 'presentation_invalid' : candidate?.failure ?? null;
  return {
    sourceBinding: { storageKey, sourceFingerprint },
    presentation,
    preparation: candidate?.jobId == null || view.targetPolicyVersion == null ? null : {
      targetPolicyVersion: view.targetPolicyVersion, jobId: candidate.jobId, stage: candidate.stage as VideoCarrierStage | null, failure,
    },
    ledger: presentation === null ? null : wireLedger(view.ledgers?.[presentation.toolInputId]),
    readmit: view.invalidPublisher === 'readmit',
    ...(view.usageFact === undefined ? {} : { usageFact: view.usageFact }),
  };
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
      // A discovery read's condition is re-checked here, in the serial entry: a failed one answers the current view (§3.5).
      const { expect: condition, ...admitted } = input;
      const invalidPublisher = this.invalidPublisher(state);
      if (condition === 'first' && (current !== null || state.selected.kind !== 'unknown')) return this.view(state);
      if (condition === 'readmit') {
        if (invalidPublisher !== 'readmit' || state.selected.kind !== 'invalid') return this.view(state);
        admitted.readmitOf = state.selected.version.versionId;
      }
      // A readmitted version that failed again is repaired by a new job, not by its publisher's Rt (§3.5 repair dispatch).
      if (input.repair === true && current !== null && !current.candidate.archived && current.candidate.state !== 'failed' && invalidPublisher !== 'presentation_invalid') {
        await this.repair(state, current, admitted);
      } else {
        if (current !== null) {
          await this.candidateEvent(state, current, { kind: 'Ar' });
          const archived = advanceLedgerAdmission(current.item, { kind: 'Ar' });
          current.item = archived.next;
          for (const effect of archived.effects) if (effect.kind === 'instance-wa') await this.ledgerEvent(state, effect.toolInputId, { kind: 'Wa', jobId: effect.jobId });
          state.archive.push(current);
        }
        const requested = input.limits?.sourceLedger !== undefined && input.publicBaseURL !== undefined;
        state.current = {
          admission: admitted, token: crypto.randomUUID(),
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
   * Grant one basic execution (St) and report what planning it needs: whether the job already planned, its frozen
   * admission and the selected version's identity (the reuse route is decided from it).
   * @param identity - The job identity.
   * @param now - The current time.
   * @returns The grant.
   * @throws {Error} When durable storage fails.
   */
  grantPresentation(identity: PresentationJobRef, now: number): Promise<PresentationGrant> {
    return this.gate(async () => {
      const state = await this.load();
      const found = state === undefined ? undefined : this.findRef(state, identity);
      const none: PresentationGrant = { capability: null, planned: true, ledgerOnly: null, admission: null, selected: null };
      if (state === undefined || found === undefined || found.kind === 'archived' || now >= found.job.admission.deadlineAt) return none;
      const capability = { ...identity, deadlineAt: found.job.admission.deadlineAt, token: found.job.token };
      if (found.kind === 'ledger') return { ...none, capability, ledgerOnly: found.job.toolInputId, admission: found.job.admission };
      const step = await this.candidateEvent(state, found.job, { kind: 'St', jobId: identity.jobId, now });
      if (step.rejected) return none;
      const selected = state.selected.kind === 'ready' ? state.presentation : null;
      if (found.job.candidate.route === null && selected !== null) found.job.reuseFrom = selected.versionId;
      await this.save(state);
      return { capability, planned: found.job.candidate.route !== null || found.job.candidate.state !== 'building', ledgerOnly: null, admission: found.job.admission,
        selected: selected === null ? null : { planSha256: selected.planSha256, producerVersion: selected.producerVersion, profileVersion: selected.profileVersion } };
    });
  }

  /**
   * The frozen admission of a job this DO still holds, without changing anything.
   * @param identity - The job.
   * @returns Its admission, or null.
   * @throws {Error} When durable storage fails.
   */
  admissionOf(identity: PresentationJobRef): Promise<VideoPresentationAdmission | null> {
    return this.gate(async () => {
      const state = await this.load();
      return (state === undefined ? undefined : this.findRef(state, identity))?.job.admission ?? null;
    });
  }

  /**
   * The worker-only answer to `prepare` (E2-3): the snapshot plus the capability, the recorded plan and work, the
   * candidate's own ledger, the job's units and the frozen pricing and attribution. D comes only from the capability.
   * @param identity - The job identity.
   * @param now - The current time.
   * @returns The answer.
   * @throws {Error} When durable storage fails.
   */
  prepareAnswer(identity: PresentationJobRef, now: number): Promise<VideoPresentationPrepareAnswer> {
    return this.gate(async () => {
      const state = await this.load();
      const found = state === undefined ? undefined : this.findRef(state, identity);
      // The discovery read's readmit fact is not the worker's: the prepare answer carries the snapshot without it.
      const { readmit: _readmit, ...snapshot } = presentationSnapshot(this.view(state), identity.storageKey, identity.sourceFingerprint);
      const admission = found?.job.admission;
      const capability = found === undefined || now >= admission!.deadlineAt ? null : { token: found.job.token, deadlineAt: admission!.deadlineAt };
      const job = found === undefined || found.kind === 'ledger' ? null : found.job;
      const facts = capability === null ? undefined : job?.prepared;
      const plan = facts === undefined ? null : { route: facts.route, stages: videoCarrierRouteStages(facts.route), toolInputId: facts.toolInputId, planSha256: facts.planSha256 };
      const units = Object.fromEntries(Object.entries(job?.chunks ?? {}).map(([key, chunk]) => [key, {
        state: chunk.state, attempt: chunk.attempt, attempts: chunk.attempts.map(({ attempt, jobId, state: attemptState, usageRecorded }) => ({ attempt, jobId, state: attemptState, usageRecorded })),
        ...(job?.receipts?.[key] === undefined ? {} : { receipts: job.receipts[key] }),
      }]));
      // The carrier's encode parameters frozen at admission reach the worker, so every chunk encodes alike (§5.4, §91 D3b-1).
      const frozen = admission?.pricing === undefined || admission.actorUserId === undefined || admission.limits === undefined || admission.encoding === undefined ? null
        : { pricing: admission.pricing, actorUserId: admission.actorUserId, projectId: admission.projectId ?? null,
          carrier: { crf: admission.limits.crf, preset: admission.limits.preset, maxShortSide: admission.encoding.carrier.maxShortSide } };
      return { ...snapshot, capability, plan, work: facts?.work ?? { kind: 'none' }, ...(facts?.route === 'dispatch_copy' ? { copyAudio: facts.copyAudio } : {}),
        candidateLedger: plan === null ? null : wireLedger(state?.ledgers[plan.toolInputId]?.instance), units, frozen };
    });
  }

  /**
   * Record the plan fact (Tp): freeze the route and toolInputId, then let the toolInputId's instance decide the writer.
   * @param identity - The current job's capability.
   * @param plan - The route, toolInputId and plan digest.
   * @param plan.route - The carrier route.
   * @param plan.toolInputId - The tool input identity.
   * @param plan.planSha256 - The plan digest.
   * @param facts - The plan-derived facts `preparePresentation` publishes from, recorded with the plan.
   * @returns Whether this job is the instance's writer, and the view.
   * @throws {Error} When durable storage fails.
   */
  planPresentation(identity: PresentationCapability, plan: { route: VideoCarrierRoute; toolInputId: string; planSha256: string }, facts?: PresentationPlanFacts): Promise<{ writer: boolean; view: PresentationView }> {
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
        if (facts !== undefined) job.prepared ??= facts;
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
      if (stage === 'publish') {
        const verified = await this.publishWork(state, found.job);
        if (verified) await this.save(state);
        return verified;
      }
      const step = await this.candidateEvent(state, found.job, { kind: 'Sg', jobId: identity.jobId, stage });
      if (!step.rejected) await this.save(state);
      return !step.rejected;
    });
  }

  /**
   * The SHA-256 of a stored object: R2's own checksum when the write supplied one, otherwise measured by reading it back.
   * Job outputs and carriers are written without one (multipart or streamed puts).
   * @param head - The object's head.
   * @returns The lowercase hex digest.
   * @throws {Error} When R2 fails.
   */
  private async storedSha256(head: R2Object): Promise<string> {
    const stored = head.checksums.sha256;
    return stored === undefined ? hashStoredObject(this.bucket, head.key) : [...new Uint8Array(stored)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  /**
   * Publish after a dispatched copy or a stitch (§5.1 step 4): the done unit's forwarded receipt must match the DO's own
   * measurement of the R2 object; the DO then assembles the bundle, computes its versionId and submits it as verified.
   * @param state - The state.
   * @param job - The current job.
   * @returns Whether the candidate is now verified.
   * @throws {Error} When R2 fails.
   */
  private async publishWork(state: PresentationState, job: JobRecord): Promise<boolean> {
    const facts = job.prepared;
    const { candidate, admission } = job;
    if (facts === undefined || candidate.state !== 'building' || (facts.route !== 'dispatch_copy' && facts.route !== 'encode')) return false;
    const unit = unitKey(admission.jobId, { kind: facts.route === 'encode' ? 'presentation-stitch' : 'presentation-copy' });
    const receipt = job.receipts?.[unit]?.find((output) => output.role === 'carrier');
    if (job.chunks[unit]?.state !== 'done' || receipt === undefined) return false;
    const head = await this.bucket.head(receipt.storageKey);
    if (head === null || head.size !== receipt.sizeBytes || head.httpMetadata?.contentType !== receipt.contentType) return false;
    const sha256 = await this.storedSha256(head);
    if (sha256 !== receipt.sha256) return false;
    const carrier = { storageKey: receipt.storageKey, url: this.objectURL(admission, receipt.storageKey), etag: head.etag, size: head.size, sha256, contentType: receipt.contentType };
    let bundle = await this.assembleVersion(job, facts, carrier);
    if (receipt.geometry !== undefined) {
      const manifest = await this.writeManifest(job, bundle, receipt.geometry);
      if (manifest === null) return false;
      bundle = { ...bundle, playback: { kind: 'alpha-packed', carrier, manifest } };
      const { storageKey, sha256: digest, size, contentType } = manifest;
      job.receipts = { ...job.receipts, [unit]: [...job.receipts![unit]!.filter((output) => output.role !== 'manifest'), { role: 'manifest', storageKey, sha256: digest, sizeBytes: size, contentType }] };
    }
    const step = advancePresentationCandidate(candidate, { kind: 'Ev', jobId: admission.jobId, fact: { kind: 'verified' } }, this.policy(admission));
    if (step.next.state === 'verified') job.bundle = bundle;
    await this.applyCandidateStep(state, job, step);
    return job.candidate.state === 'verified';
  }

  /**
   * Write the alpha-packed manifest when the bundle is assembled (§3.5, §91 D3-3, D3b-3): the version identity, the measured
   * carrier and the geometry its job reported, at the carrier key plus `.manifest.json`; the manifest does not enter its own
   * versionId, which the carrier alone gives. The bytes are deterministic, so a repeated publish writes the same object.
   * @param job - The job.
   * @param version - The version assembled over the measured carrier.
   * @param geometry - The packed geometry.
   * @returns The manifest's measured receipt, or null when the geometry does not fit the version.
   * @throws {Error} When R2 fails.
   */
  private async writeManifest(job: JobRecord, version: VideoPresentationVersion, geometry: NonNullable<Extract<VideoPresentationOutputReceipt, { role: 'carrier' }>['geometry']>): Promise<Extract<VideoPresentationVersion['playback'], { kind: 'alpha-packed' }>['manifest'] | null> {
    const { versionId, toolInputId, planSha256, policyVersion, playback } = version;
    const parsed = alphaPackedManifestSchema.safeParse({ schemaVersion: 1, versionId, toolInputId, planSha256, policyVersion, packed: playback.carrier, ...geometry });
    if (!parsed.success) return null;
    const storageKey = `${playback.carrier.storageKey}.manifest.json`;
    const contentType = 'application/json';
    // The manifest's own receipt is not inside it, so the version it describes can be checked before it is written.
    const placeholder = { storageKey, url: this.objectURL(job.admission, storageKey), etag: '-', size: 1, sha256: '0'.repeat(64), contentType };
    if (!alphaPackedManifestMatchesVersion(parsed.data, { ...version, playback: { kind: 'alpha-packed', carrier: playback.carrier, manifest: placeholder } })) return null;
    const bytes = new TextEncoder().encode(JSON.stringify(parsed.data));
    const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    const object = await this.bucket.put(storageKey, bytes, { httpMetadata: { contentType }, sha256 });
    return { ...placeholder, etag: object.etag, size: bytes.byteLength, sha256 };
  }

  /**
   * Claim the basic copy's carrier key before the outbound handler writes R2 (§91 D2-2): only the current copy-route job,
   * in its copy stage, for its own copy key; a key is claimed once.
   * @param identity - The writer's capability.
   * @param key - The key the write names.
   * @param declaration - The declared length and type.
   * @param declaration.byteLength - The declared length.
   * @param declaration.contentType - The declared type.
   * @param attempt - The copy attempt the write names.
   * @returns The claim owner, `forbidden` when a granted job names another key, or null.
   * @throws {Error} When durable storage fails.
   */
  claimPresentationCarrier(identity: PresentationCapability, key: string, declaration: { byteLength: number; contentType: string }, attempt = 1): Promise<{ owner: string } | 'forbidden' | null> {
    return this.gate(async () => {
      const state = await this.load();
      const found = state === undefined ? undefined : this.find(state, identity, identity.token);
      if (state === undefined || found?.kind !== 'current' || identity.deadlineAt <= Date.now()) return null;
      const job = found.job;
      if (key !== copyCarrierKey(job.admission, attempt)) return 'forbidden';
      if (job.candidate.state !== 'building' || job.candidate.stage !== 'copy' || job.carrierWrites?.[key] !== undefined) return null;
      const owner = crypto.randomUUID();
      job.carrierWrites = { ...job.carrierWrites, [key]: { owner, byteLength: declaration.byteLength, contentType: declaration.contentType, measured: null } };
      await this.save(state);
      return { owner };
    });
  }

  /**
   * Record the Worker's measurement of a claimed carrier write.
   * @param identity - The writer's capability.
   * @param owner - The claim owner.
   * @param measured - What landed.
   * @returns Whether the claim took the measurement.
   * @throws {Error} When durable storage fails.
   */
  commitPresentationCarrier(identity: PresentationCapability, owner: string, measured: PresentationCarrierMeasurement): Promise<boolean> {
    return this.gate(async () => {
      const state = await this.load();
      const found = state === undefined ? undefined : this.find(state, identity, identity.token);
      if (state === undefined || found?.kind !== 'current') return false;
      const write = found.job.carrierWrites?.[measured.storageKey];
      if (write === undefined || write.owner !== owner || write.measured !== null || write.byteLength !== measured.sizeBytes || write.contentType !== measured.contentType) return false;
      write.measured = measured;
      await this.save(state);
      return true;
    });
  }

  /**
   * Publish an identity or basic copy carrier (§5.1 step 4, §91 D2-1): the one native carrier receipt must be the source
   * itself (its hash the source fingerprint) or the job's copy key, and agree with the DO's measurement of R2; the DO then
   * assembles the bundle and submits it as verified.
   * @param identity - The current job's capability.
   * @param route - The route the carrier was produced for.
   * @param receipts - The receipts the container answered.
   * @returns Whether the verified evidence was taken.
   * @throws {Error} When durable storage or R2 fails.
   */
  publishCarrier(identity: PresentationCapability, route: 'identity' | 'copy', receipts: readonly VideoPresentationOutputReceipt[]): Promise<boolean> {
    return this.gate(async () => {
      const state = await this.load();
      const found = state === undefined ? undefined : this.find(state, identity, identity.token);
      if (state === undefined || found?.kind !== 'current') return false;
      const job = found.job;
      const { prepared: facts, admission, candidate } = job;
      const receipt = receipts.length === 1 && receipts[0]!.role === 'carrier' && receipts[0]!.packing === 'native' ? receipts[0]! : undefined;
      if (facts?.route !== route || candidate.state !== 'building' || receipt === undefined) return false;
      if (receipt.storageKey !== (route === 'identity' ? admission.storageKey : copyCarrierKey(admission, 1))) return false;
      const head = await this.bucket.head(receipt.storageKey);
      if (head === null || head.size !== receipt.sizeBytes || head.httpMetadata?.contentType !== receipt.contentType) return false;
      // The source's hash is its registered fingerprint; a copy's is measured from the stored object.
      const sha256 = route === 'identity' ? admission.sourceFingerprint : await this.storedSha256(head);
      if (sha256 !== receipt.sha256) return false;
      const carrier = { storageKey: receipt.storageKey, url: this.objectURL(admission, receipt.storageKey), etag: head.etag, size: head.size, sha256, contentType: receipt.contentType };
      const bundle = await this.assembleVersion(job, facts, carrier);
      const step = advancePresentationCandidate(candidate, { kind: 'Ev', jobId: admission.jobId, fact: { kind: 'verified' } }, this.policy(admission));
      if (step.next.state === 'verified') job.bundle = bundle;
      await this.applyCandidateStep(state, job, step);
      await this.save(state);
      return !step.rejected;
    });
  }

  /**
   * Assemble a version bundle over a measured carrier: the versionId hashes the target policy, the plan's producer and
   * profile, the display and the carrier's measured bytes (§3.2).
   * @param job - The job.
   * @param facts - Its recorded plan facts.
   * @param carrier - The measured carrier receipt.
   * @returns The bundle.
   * @throws {Error} When the version input is invalid.
   */
  private async assembleVersion(job: JobRecord, facts: PresentationPlanFacts, carrier: Extract<VideoPresentationVersion['playback'], { kind: 'native' }>['carrier']): Promise<VideoPresentationVersion> {
    const { admission } = job;
    const policyVersion = admission.targetPolicyVersion ?? 1;
    const versionId = await videoPresentationVersionId({ sourceFingerprint: admission.sourceFingerprint, policyVersion, producerVersion: facts.producerVersion,
      profileVersion: facts.profileVersion, planSha256: facts.planSha256, display: facts.display, playback: { sha256: carrier.sha256, size: carrier.size, contentType: carrier.contentType } });
    return {
      schemaVersion: 1, sourceFingerprint: admission.sourceFingerprint, versionId, toolInputId: facts.toolInputId, planSha256: facts.planSha256, policyVersion,
      producerVersion: facts.producerVersion, profileVersion: facts.profileVersion,
      original: admission.original ?? { width: null, height: null, duration: null }, display: facts.display,
      playback: { kind: 'native', carrier, displayRect: null }, playbackClock: facts.playbackClock,
    };
  }

  /**
   * Publish the reuse route (§7.1): the selected carrier under the new target policy, as a new versionId.
   * @param identity - The current job's capability.
   * @returns Whether the candidate is now verified.
   * @throws {Error} When storage fails.
   */
  publishReuse(identity: PresentationCapability): Promise<boolean> {
    return this.gate(async () => {
      const state = await this.load();
      const found = state === undefined ? undefined : this.find(state, identity, identity.token);
      const selected = state?.presentation;
      if (state === undefined || found?.kind !== 'current' || found.job.prepared?.route !== 'reuse' || selected === null || selected === undefined) return false;
      const job = found.job;
      // The selected version is no longer the ready one the route was planned from: a temporary failure the readmit covers (§10.6).
      if (state.selected.kind !== 'ready' || state.selected.version.versionId !== job.reuseFrom) {
        await this.candidateEvent(state, job, { kind: 'Er', jobId: identity.jobId, code: 'reuse_source_invalid' });
        await this.save(state);
        return false;
      }
      const bundle = await this.assembleVersion(job, job.prepared!, selected.playback.carrier);
      const step = advancePresentationCandidate(job.candidate, { kind: 'Ev', jobId: identity.jobId, fact: { kind: 'verified' } }, this.policy(job.admission));
      if (step.next.state === 'verified') job.bundle = { ...bundle, playback: selected.playback };
      await this.applyCandidateStep(state, job, step);
      await this.save(state);
      return job.candidate.state === 'verified';
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
      const before = job.chunks[key] ?? NO_PRESENTATION_CHUNK;
      let event: Parameters<typeof advancePresentationChunk>[1];
      if (report.kind === 'Sub') event = { kind: 'Sub', retries: job.admission.policy?.chunkRetries ?? 0 };
      else if (report.kind === 'Done') event = { kind: 'Done', attempt: report.attempt, usage: report.usage };
      else event = report;
      const step = advancePresentationChunk(before, event, chunkIdentity);
      if (step.rejected) return false;
      // Output receipts count only for the attempt that completed the unit, its carrier at that attempt's own output key.
      // A Done carries its one carrier, an alpha-packed one with its geometry; the manifest is the DO's own (§91 D3-3).
      if (report.kind === 'Done' && report.receipts !== undefined && !videoPresentationDoneReceiptsSchema.safeParse(report.receipts).success) return false;
      if (report.kind === 'Done' && report.receipts !== undefined && before.state === 'open' && step.next.state === 'done') {
        const attemptJob = videoContainerJobId({ ...chunkIdentity, attempt: report.attempt });
        const carrier = report.receipts.find((receipt) => receipt.role === 'carrier');
        if (carrier?.storageKey !== videoPresentationWorkKeyFor(job.admission.storageKey, attemptJob)) return false;
        job.receipts = { ...job.receipts, [key]: report.receipts };
      }
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
        if (head === null || head.etag !== state.descriptorETag) {
          state.selected = advanceSelectedPresentation(state.selected, { kind: 'Bad' }).next;
          // The observed object (none when missing) is the base of the next conditional write (§7.2 ready(A)×Bad, §7.3 R0).
          state.descriptorETag = head?.etag ?? null;
        }
      }
      // A current verified candidate P does not select is published now, without waiting for its L (§7.2 invalid row).
      const waiting = state.current;
      if (state.selected.kind === 'invalid' && waiting !== null && !waiting.candidate.archived && waiting.candidate.state === 'verified' &&
        (waiting.bundle as { versionId?: unknown } | null)?.versionId !== state.selected.version.versionId) {
        await this.commitPresentationVersion(state, waiting);
      }
      for (const [toolInputId, record] of Object.entries(state.ledgers)) {
        const instance = record.instance;
        if (instance.kind === 'ready' && record.proof !== null) {
          const failure = await this.checkReceipt(storageKey, toolInputId, record.proof);
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
        limits === undefined || admission.publicBaseURL === undefined ||
        (declaration.planSha256 !== undefined && declaration.planSha256 !== record.planSha256) ||
        declaration.producerVersion !== 2 || !within(declaration.byteLength, limits.maxBytes) || !within(declaration.table?.byteLength, limits.maxBytes) ||
        !within(declaration.table.frameCount, Number.MAX_SAFE_INTEGER)) return null;
      const key = videoSourceLedgerKeyFor(admission.storageKey, toolInputId);
      const tableKey = videoSourceLedgerTableKeyFor(admission.storageKey, toolInputId);
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
    // The candidate moves by the whole chunk set (§7.1.1, §5.1 step 2a): stitch only once every chunk of its work is done.
    if (event.kind === 'Sg' && event.stage === 'stitch' && !this.chunksDone(job)) return { next: job.candidate, effects: [], rejected: true };
    const step = advancePresentationCandidate(job.candidate, event, this.policy(job.admission));
    await this.applyCandidateStep(state, job, step);
    return step;
  }

  /**
   * Whether every chunk of the job's recorded encode work is done.
   * @param job - The job.
   * @returns False without recorded encode work or while any chunk's latest attempt is not done.
   * @throws {never} Never.
   */
  private chunksDone(job: JobRecord): boolean {
    const work = job.prepared?.work;
    return work?.kind === 'encode' && work.chunks.every((_window, chunk) => job.chunks[unitKey(job.admission.jobId, { kind: 'presentation-chunk', chunk })]?.state === 'done');
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
      attempt: { jobId: admission.jobId, deadlineAt: admission.deadlineAt }, url: this.objectURL(admission, claimed.claim.key),
      etag: measured.etag, size: measured.size, sha256: measured.sha256, contentType: 'application/json',
      table: { url: this.objectURL(admission, claimed.claim.table.key), sha256: measured.table.sha256, size: measured.table.size, contentType: 'application/json', frameCount: claimed.declaration.table.frameCount },
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
   * @param toolInputId - The instance whose objects the receipt names.
   * @param proof - The receipt and its physical proof.
   * @returns The failure code, or null when both objects are the committed ones.
   * @throws {Error} When R2 fails.
   */
  private async checkReceipt(storageKey: string, toolInputId: string, proof: ProvenReceipt): Promise<'source_ledger_missing' | 'source_ledger_invalid' | null> {
    const [object, table] = await Promise.all([this.bucket.head(videoSourceLedgerKeyFor(storageKey, toolInputId)), this.bucket.head(videoSourceLedgerTableKeyFor(storageKey, toolInputId))]);
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
      if (!workTerminal(current?.candidate) || !samePlan || await this.checkReceipt(storageKey, toolInputId, proven) !== null) continue;
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
   * Locate a job by its id and source alone, as `prepare` names it.
   * @param state - The state.
   * @param identity - The job reference.
   * @returns The job, or undefined.
   * @throws {never} Never.
   */
  private findRef(state: PresentationState, identity: PresentationJobRef): FoundJob | undefined {
    const found = this.find(state, { ...identity, deadlineAt: Number.NaN }, null, true);
    return found?.job.admission.sourceFingerprint === identity.sourceFingerprint ? found : undefined;
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
   * The public URL of an object derived from the admission's frozen public base.
   * @param admission - The admission.
   * @param key - The storage key.
   * @returns The URL.
   * @throws {Error} When the admission froze no public base.
   */
  private objectURL(admission: VideoPresentationAdmission, key: string): string {
    if (admission.publicBaseURL === undefined) throw new Error('The admission froze no public base');
    return videoPresentationObjectURL(admission.publicBaseURL, key);
  }

  /**
   * Whether P is invalid(V) with the current candidate V's publisher or a reuse of V that failed reuse_source_invalid, and
   * how that candidate was admitted (§3.5, §7.1).
   * @param state - The state.
   * @returns `readmit` without readmitOf, `presentation_invalid` with it, or null when P is not invalid or another candidate is current.
   * @throws {never} Never.
   */
  private invalidPublisher(state: PresentationState): 'readmit' | 'presentation_invalid' | null {
    const current = state.current;
    if (state.selected.kind !== 'invalid' || current === null || current.candidate.archived) return null;
    const version = state.selected.version.versionId;
    const publisher = (current.bundle as { versionId?: unknown } | null)?.versionId === version;
    const failedReuse = current.candidate.failure === 'reuse_source_invalid' && current.reuseFrom === version;
    if (!publisher && !failedReuse) return null;
    return current.admission.readmitOf === undefined ? 'readmit' : 'presentation_invalid';
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
    const invalidPublisher = state === undefined ? null : this.invalidPublisher(state);
    return {
      candidate: current?.candidate ?? NO_PRESENTATION_CANDIDATE,
      archive: state?.archive.map((job) => job.candidate) ?? [],
      selected: state?.selected ?? { kind: 'unknown' },
      presentation: state?.selected.kind === 'ready' ? state.presentation : null,
      targetPolicyVersion: current?.admission.targetPolicyVersion ?? null,
      ledgers: Object.fromEntries(Object.entries(state?.ledgers ?? {}).map(([toolInputId, record]) => [toolInputId, record.instance])),
      chunks: Object.assign({}, ...jobs.map((job) => job.chunks)) as Record<string, PresentationChunk>,
      usage: state?.usage ?? {},
      ...(invalidPublisher === null ? {} : { invalidPublisher }),
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

/** What the basic execution's probe found (design §5.1 step 2): the plan identity, the route facts and the plan-derived facts. */
export type PresentationProbe =
  | { kind: 'failed'; code: string }
  | {
    kind: 'planned';
    toolInputId: string;
    planSha256: string;
    /** The route facts; `selected`, the copy margin and the basic disk are supplied from the DO's own state. */
    routeInput: Omit<VideoCarrierRouteInput, 'selected' | 'copyDiskMarginBytes' | 'basicDiskBytes'>;
    /** The full ledger's encode facts (§3.2 item 7): source keyframe ordinals and the coded size. */
    encoding: VideoPresentationLedger['encoding'];
    /** The encode work and the selected audio's seconds, which a dispatched copy encodes to AAC. */
    work: VideoJobWork & { audioSeconds: number };
    display: VideoPresentationVersion['display'];
    playbackClock: VideoPresentationVersion['playbackClock'];
  };
/** A carrier the basic execution produced itself (identity, or a copy that fits its disk): its receipts, measured by the store. */
export type PresentationCarrierOutcome = { kind: 'written'; receipts: VideoPresentationOutputReceipt[] } | { kind: 'failed'; code: string };
/** The basic container's work, injected so the orchestration is tested over the real store with a fake container. */
export interface PresentationContainerPort {
  probe(capability: PresentationCapability): Promise<PresentationProbe>;
  /** Write full and compact; a ledger-only repair passes null and the container derives the encode facts again. */
  writeLedger(capability: PresentationCapability, toolInputId: string, encoding: VideoPresentationLedger['encoding'] | null): Promise<void>;
  carrier(capability: PresentationCapability, route: 'identity' | 'copy'): Promise<PresentationCarrierOutcome>;
  usage(): Promise<{ wallMs: number; cpuUsec: number | null } | null>;
}

/**
 * The basic copy's carrier key (§91 D2-2): where the first dispatched copy attempt writes.
 * @param admission - The job's admission.
 * @param attempt - The copy attempt.
 * @returns The key.
 * @throws {never} Never.
 */
function copyCarrierKey(admission: VideoPresentationAdmission, attempt: number): string {
  return videoPresentationWorkKeyFor(admission.storageKey, videoContainerJobId({ kind: 'presentation-copy', jobId: admission.jobId, attempt }));
}

// Cloudflare sizes container disks in decimal gigabytes.
const DISK_BYTES_PER_GB = 1_000_000_000;

/**
 * The encode chunks of a plan (§5.4): each targets the frozen share of the remaining budget, measured with the frozen rates.
 * @param probe - The planned probe.
 * @param encoding - The frozen encoding parameters.
 * @param remainingSeconds - Seconds left before the job's deadline.
 * @returns The chunks.
 * @throws {RangeError} When the work or the budget is out of range.
 */
function encodeChunks(probe: Extract<PresentationProbe, { kind: 'planned' }>, encoding: VideoPresentationEncoding, remainingSeconds: number): VideoEncodeChunk[] {
  const { work } = probe;
  const frameSeconds = (estimateVideoJobSeconds(work, encoding.encoder) - encoding.encoder.startSeconds) / (work.encodedFrames + work.prerollFrames);
  const keyframes = Array.from({ length: work.encodedFrames }, () => false);
  for (const ordinal of probe.encoding.keyframeOrdinals) if (ordinal < keyframes.length) keyframes[ordinal] = true;
  return planVideoEncodeChunks({ keyframes, frameSeconds, targetSeconds: encoding.chunkShare * remainingSeconds });
}

/**
 * One basic execution of a presentation job (design §5.1 steps 1, 2 and 5): grant the job, probe and plan, record the
 * plan so the toolInputId's instance decides the writer, let the writer write full and compact, choose the route from
 * the probe facts and the frozen encoding and basic disk, publish identity, in-basic copy and reuse here, answer the
 * dispatched work, fail an encode over the frozen chunk cap `too_long`, and report the basic execution's usage. A
 * replay of a started job never probes again.
 * @param store - The canonical key's store.
 * @param identity - The job identity.
 * @param port - The basic container.
 * @param now - The current time.
 * @returns The worker-only answer.
 * @throws {Error} When storage, R2 or the container fails.
 */
export async function preparePresentation(store: VideoPresentationStore, identity: PresentationJobRef, port: PresentationContainerPort, now: number): Promise<VideoPresentationPrepareAnswer> {
  const grant = await store.grantPresentation(identity, now);
  const { capability, admission } = grant;
  if (capability !== null && admission !== null && grant.ledgerOnly !== null) {
    if ((await store.read(identity.storageKey, identity.sourceFingerprint)).ledgers[grant.ledgerOnly]?.kind === 'pending') await writeLedgerOrFail(store, port, capability, grant.ledgerOnly, null);
  } else if (capability !== null && admission !== null && !grant.planned) {
    await planAndProduce(store, capability, admission, grant.selected, port, now);
    const usage = await port.usage();
    if (usage !== null) await store.report(capability, { kind: 'finished', usage });
  }
  return store.prepareAnswer(identity, now);
}

/**
 * Probe, plan, write the ledger when this job is its writer, and take the route as far as the basic execution goes.
 * @param store - The store.
 * @param capability - The granted capability.
 * @param admission - The frozen admission.
 * @param selected - The selected version's identity.
 * @param port - The basic container.
 * @param now - The current time.
 * @returns Nothing.
 * @throws {Error} When storage, R2 or the container fails.
 */
async function planAndProduce(store: VideoPresentationStore, capability: PresentationCapability, admission: VideoPresentationAdmission,
  selected: VideoCarrierIdentity | null, port: PresentationContainerPort, now: number): Promise<void> {
  const probe = await port.probe(capability);
  if (probe.kind === 'failed') { await store.fail(capability, probe.code); return; }
  const { encoding, pricing } = admission;
  if (encoding === undefined || pricing === undefined) { await store.fail(capability, 'admission_invalid'); return; }
  const route = chooseVideoCarrierRoute({ ...probe.routeInput, selected, copyDiskMarginBytes: encoding.copyDiskMarginBytes,
    basicDiskBytes: pricing.basic.size.disk_gb * DISK_BYTES_PER_GB });
  const remainingSeconds = (capability.deadlineAt - now) / 1000;
  const chunks = route === 'encode' ? encodeChunks(probe, encoding, remainingSeconds) : [];
  // A dispatched copy encodes no video: its estimate is the start plus the selected audio at the frozen AAC rate (§5.4).
  const copySeconds = estimateAudioEncodeSeconds(probe.work.audioSeconds, encoding.encoder);
  const tooLong = route === 'encode' ? presentationEncodeFailure(chunks.length, encoding.maxParallelChunks)
    : route === 'dispatch_copy' && copySeconds > encoding.chunkShare * remainingSeconds ? 'too_long' : null;
  const work: PresentationPlanFacts['work'] = route === 'dispatch_copy' && tooLong === null ? { kind: 'dispatch_copy' }
    : route === 'encode' && tooLong === null ? { kind: 'encode', chunks } : { kind: 'none' };
  const { planSha256, producerVersion, profileVersion } = probe.routeInput.plan;
  const facts: PresentationPlanFacts = { route, toolInputId: probe.toolInputId, planSha256, producerVersion, profileVersion,
    display: probe.display, playbackClock: probe.playbackClock, work,
    copyAudio: probe.work.audioSeconds === 0 ? null : probe.routeInput.audioCopyable ? 'copy' : 'encode' };
  const { writer, view } = await store.planPresentation(capability, { route, toolInputId: probe.toolInputId, planSha256 }, facts);
  if (writer) await writeLedgerOrFail(store, port, capability, probe.toolInputId, probe.encoding);
  if (view.candidate.state !== 'building') return;
  if (tooLong !== null) { await store.fail(capability, tooLong); return; }
  if (route === 'reuse') { await store.publishReuse(capability); return; }
  if (route !== 'identity' && route !== 'copy') return;
  if (route === 'copy' && !await store.advanceStage(capability, 'copy')) return;
  const carrier = await port.carrier(capability, route);
  if (carrier.kind === 'failed') await store.fail(capability, carrier.code);
  else if (!await store.publishCarrier(capability, route, carrier.receipts)) await store.fail(capability, 'presentation_failed');
}

/**
 * Write the ledger; a write the container answers with a code ends the instance in that code's class (§91 D2-3).
 * @param store - The store.
 * @param port - The basic container.
 * @param capability - The writer's capability.
 * @param toolInputId - The instance.
 * @param encoding - The probe's encode facts, or null for a ledger-only repair.
 * @returns Nothing.
 * @throws {Error} When the container fails without a code, or storage fails.
 */
async function writeLedgerOrFail(store: VideoPresentationStore, port: PresentationContainerPort, capability: PresentationCapability, toolInputId: string,
  encoding: VideoPresentationLedger['encoding'] | null): Promise<void> {
  try { await port.writeLedger(capability, toolInputId, encoding); } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (typeof code !== 'string' || !/^[a-z][a-z0-9_]*$/u.test(code)) throw error;
    await store.failLedger(capability, toolInputId, code);
  }
}
