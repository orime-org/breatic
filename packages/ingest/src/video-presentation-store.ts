// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The canonical-key presentation Durable Object store (inner#1306; frames-split design §5.1, §7.1–§7.4). Every write goes
 * through one pure transition of `video-presentation-state.ts`: the candidate A, the chunk set and the selected bundle P
 * (published only by `commitPresentationVersion`, which replaces the current descriptor R0 in R2 before the DO copy).
 * Physical facts are measured from R2, never taken from a caller. The plan, the grid and the tool source travel in the P
 * bundle; there is no companion frame table (§5.1 step 5).
 */

import {
  alphaPackedManifestSchema, videoPresentationDoneReceiptsSchema, videoPresentationKeyFor, videoPresentationObjectURL,
  videoPresentationToolInputId, videoPresentationVersionId, videoPresentationVersionSchema, videoPresentationWorkKeyFor,
  type VideoPresentationAdmissionPolicy, type VideoPresentationProbeFacts, type VideoPresentationOutputReceipt, type VideoPresentationChunkReport, type VideoPresentationChunkUnit,
  type VideoPresentationDisplay, type VideoPresentationEncoding, type VideoPresentationIngestPricing, type VideoPresentationIngestSnapshot,
  type VideoPresentationPrepareAnswer, type VideoPresentationProcessLimits, type VideoPresentationUsageFact, type VideoPresentationVersion,
} from '@breatic/shared';
import type { VideoPresentation, VideoPresentationRegisteredMetadata } from '@shared/upload/video-presentation-types.js';
import type { VideoPresentationEditReceipt, VideoPresentationPlan } from '@shared/upload/video-presentation-version.js';
import { videoDurationsMatch } from '@shared/upload/video-duration.js';
import { decodePrerollFrames, planFrameGrid } from '@shared/upload/frame-grid.js';
import {
  chooseVideoCarrierRoute, editFileSizeFailure, estimateAudioEncodeSeconds, estimateVideoJobSeconds, planVideoEncodeChunks, presentationRouteFailure, presentationStageKeys,
  videoCarrierGeometry, videoCarrierRouteStages, videoContainerJobId,
  type PresentationRouteStage, type VideoCarrierIdentity, type VideoCarrierRoute, type VideoCarrierStage, type VideoEncodeChunk, type VideoStageKeys,
} from '@shared/mini-tools/video-encode-plan.js';
import {
  advancePresentationCandidate, advancePresentationChunk, advanceSelectedPresentation, NO_PRESENTATION_CANDIDATE, NO_PRESENTATION_CHUNK,
  type PresentationCandidate, type PresentationCandidateEvent, type PresentationChunk, type PresentationSelection,
} from '@ingest/video-presentation-state.js';
import type { PresentationProbeAnswerParsed } from '@ingest/presentation-run-contract.js';
import type { PresentationGridInput, PresentationSourceFacts } from '@ingest/presentation-run-types.js';
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
  /** The probe's sampled frames, the single-frame duration and the rate cap (design §5.1 step 2, §4.1). */
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
/** A job's measured container usage and whether its SQL record was acknowledged. */
export interface PresentationUsage { wallMs: number; cpuUsec: number | null; acknowledged: boolean }
/** A container unit of the candidate, without its job id. */
export type PresentationChunkUnit = VideoPresentationChunkUnit;
/** One unit report; a stitch Done carries its carrier's receipt, an edit stitch Done its edit file's, a count Done the count. */
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
  chunks: Record<string, PresentationChunk>;
  usage: Record<string, PresentationUsage>;
  /** The current job's measured usage while unacknowledged. */
  usageFact?: VideoPresentationUsageFact;
  /** P is invalid(V) and V's publisher is current: `readmit` when it was admitted without readmitOf, else `presentation_invalid` (§3.5). */
  invalidPublisher?: 'readmit' | 'presentation_invalid';
}

/** The latest published version V a job may reuse (§7.1): ready, or invalid(V) during the automatic readmit. */
export interface PresentationReuseSource { versionId: string; ready: boolean; identity: VideoCarrierIdentity; version: VideoPresentationVersion }
/** What a basic execution needs before it plans. */
export interface PresentationGrant {
  /** The granted capability; null when the job is unknown, archived, past its deadline or refused St. */
  capability: PresentationCapability | null;
  /** Whether the job planned already (or cannot plan any more): a replay never probes again. */
  planned: boolean;
  admission: VideoPresentationAdmission | null;
  /** V at the grant, from which the route is chosen. */
  reuseFrom: PresentationReuseSource | null;
}

/** Durable gate shared by the production container and the storage-only test object. */
export type PresentationStorageGate = <T>(work: () => Promise<T>) => Promise<T>;

/** How one chunked stage's windows are planned again once the count makes the frame count exact (§5.4 chunking row). */
interface ChunkPlan { frameSeconds: number; prerollFrames: number }
/** What `preparePresentation` records with the plan: the route, the plan and its versions, the tool source, the grid and the work. */
export interface PresentationPlanFacts {
  route: VideoCarrierRoute;
  /** Null on the edit route until the edit file is measured (§3.2 item 3). */
  toolInputId: string | null;
  planSha256: string;
  versions: { producerVersion: string; profileVersion: string; editProfileVersion: string | null };
  plan: VideoPresentationPlan;
  source: PresentationSourceFacts;
  gridInput: PresentationGridInput;
  /** The display grid: the probe's estimate until the count makes it exact (§4.1 frame count row); V's on a reuse route. */
  display: VideoPresentationDisplay;
  work: VideoPresentationPrepareAnswer['work'];
  /** The chunk budget the windows are planned from; null on the carrier reuse route. */
  chunking: { targetSeconds: number; encode: ChunkPlan; edit: ChunkPlan | null } | null;
}
interface JobRecord {
  admission: VideoPresentationAdmission;
  token: string;
  candidate: PresentationCandidate;
  planSha256: string | null;
  bundle: unknown;
  chunks: Record<string, PresentationChunk>;
  prepared?: PresentationPlanFacts;
  /** The role-tagged output receipts of the attempt that completed each stitch unit (§90 E4-15). */
  receipts?: Record<string, VideoPresentationOutputReceipt[]>;
  /** The edit file the edit stitch wrote, as the DO measured it (§4.2, §7.3). */
  editFile?: VideoPresentationEditReceipt;
  /** The versionId of V at the grant that planned, which a reuse route reads (§7.1). */
  reuseFrom?: string;
}
interface PresentationState {
  sourceFingerprint: string;
  descriptorETag: string | null;
  current: JobRecord | null;
  archive: JobRecord[];
  selected: PresentationSelection;
  /** The latest published version V, kept while P is invalid(V) so a readmit can reuse its edit file (§7.1). */
  presentation: VideoPresentationVersion | null;
  usage: Record<string, PresentationUsage>;
}
type FoundJob = { kind: 'current' | 'archived'; job: JobRecord };

// ponytail: one storage value holds the whole key's state, archive included; split per job if a key's archive grows past the value limit.
// v3: the frame-grid shape replaced the unpublished ledger shape in place; older state reads as absent and is readmitted (§3.4).
const STATE_KEY = 'video-presentation-v3';

/**
 * The unit key of a chunk report: its container job id without the attempt.
 * @param jobId - The main job.
 * @param unit - The unit.
 * @returns The key.
 * @throws {never} Never.
 */
function unitKey(jobId: string, unit: PresentationChunkUnit): string {
  switch (unit.kind) {
    case 'presentation-count': return `video-presentation:${jobId}:count`;
    case 'presentation-chunk': return `video-presentation:${jobId}:chunk:${unit.chunk}`;
    case 'presentation-stitch': return `video-presentation:${jobId}:stitch`;
    case 'presentation-edit': return `video-presentation:${jobId}:edit:${unit.chunk}`;
    case 'presentation-edit-stitch': return `video-presentation:${jobId}:edit-stitch`;
  }
}

/**
 * The units a stage runs (§7.1.1): the candidate leaves a stage only once every one of them is done.
 * @param stage - The stage.
 * @param work - The recorded work.
 * @returns The units, empty for a stage without container jobs.
 * @throws {never} Never.
 */
function stageUnits(stage: string, work: VideoPresentationPrepareAnswer['work'] | undefined): PresentationChunkUnit[] {
  switch (stage) {
    case 'count': return [{ kind: 'presentation-count' }];
    case 'edit': return work?.kind === 'edit' ? work.editChunks.map((_window, chunk) => ({ kind: 'presentation-edit' as const, chunk })) : [];
    case 'edit_stitch': return [{ kind: 'presentation-edit-stitch' }];
    case 'encode': return work?.kind === 'none' || work === undefined ? [] : work.chunks.map((_window, chunk) => ({ kind: 'presentation-chunk' as const, chunk }));
    case 'stitch': return [{ kind: 'presentation-stitch' }];
    default: return [];
  }
}

/**
 * Project the store view to the ingest snapshot (§3.5 response row, §5.1 step 6): the selected bundle and the target
 * policy's preparation, never the full arrays.
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
    readmit: view.invalidPublisher === 'readmit',
    ...(view.usageFact === undefined ? {} : { usageFact: view.usageFact }),
  };
}

/** One canonical key's presentation state machine over durable storage and R2. */
export class VideoPresentationStore {
  /**
   * Bind real durable state and R2 to one request serialization gate.
   * @param storage - This canonical key's Durable Object storage.
   * @param bucket - The canonical source and its derived objects.
   * @param gate - Serializes every transition.
   */
  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly bucket: R2Bucket,
    private readonly gate: PresentationStorageGate,
  ) {}

  /**
   * The one admission entry (Ad; Rt for repair): a new job archives the current candidate in the same transaction.
   * @param input - The registered source and requested work identity.
   * @returns The store view.
   * @throws {Error} When durable storage or R2 fails.
   */
  accept(input: VideoPresentationAdmission): Promise<PresentationView> {
    return this.gate(async () => {
      let state = await this.load();
      if (state?.sourceFingerprint !== input.sourceFingerprint) {
        const head = await this.bucket.head(videoPresentationKeyFor(input.storageKey));
        state = { sourceFingerprint: input.sourceFingerprint, descriptorETag: head?.etag ?? null, current: null, archive: [], selected: { kind: 'unknown' }, presentation: null, usage: {} };
      }
      const current = state.current;
      const known = current?.admission.jobId === input.jobId || state.archive.some((job) => job.admission.jobId === input.jobId);
      if (known) return this.view(state);
      // A discovery read's condition is re-checked here, in the serial entry: a failed one answers the current view (§3.5).
      const { expect: condition, ...admitted } = input;
      const invalidPublisher = this.invalidPublisher(state);
      if (condition === 'first' && (current !== null || state.selected.kind !== 'unknown')) return this.view(state);
      if (condition === 'readmit') {
        if (invalidPublisher !== 'readmit' || state.selected.kind !== 'invalid') return this.view(state);
        admitted.readmitOf = state.selected.version.versionId;
      }
      // A repair of active work replays it; a readmitted version that failed again is repaired by a new job (§3.5 repair dispatch).
      if (input.repair === true && current !== null && !current.candidate.archived && current.candidate.state !== 'failed' && invalidPublisher !== 'presentation_invalid') {
        await this.candidateEvent(state, current, { kind: 'Rt', jobId: input.jobId, deadlineAt: input.deadlineAt });
      } else {
        if (current !== null) {
          await this.candidateEvent(state, current, { kind: 'Ar' });
          state.archive.push(current);
        }
        state.current = {
          admission: admitted, token: crypto.randomUUID(),
          candidate: advancePresentationCandidate(NO_PRESENTATION_CANDIDATE, { kind: 'Ad', jobId: input.jobId, deadlineAt: input.deadlineAt }).next,
          planSha256: null, bundle: null, chunks: {},
        };
      }
      await this.save(state);
      return this.view(state);
    });
  }

  /**
   * Start the current job before its deadline (St).
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
      }
      return { token, view: this.view(state) };
    });
  }

  /**
   * Grant one basic execution (St) and report what planning it needs: whether the job already planned, its frozen
   * admission and V, from which the route is chosen (§7.1).
   * @param identity - The job identity.
   * @param now - The current time.
   * @returns The grant.
   * @throws {Error} When durable storage fails.
   */
  grantPresentation(identity: PresentationJobRef, now: number): Promise<PresentationGrant> {
    return this.gate(async () => {
      const state = await this.load();
      const found = state === undefined ? undefined : this.findRef(state, identity);
      const none: PresentationGrant = { capability: null, planned: true, admission: null, reuseFrom: null };
      if (state === undefined || found === undefined || found.kind === 'archived' || now >= found.job.admission.deadlineAt) return none;
      const capability = { ...identity, deadlineAt: found.job.admission.deadlineAt, token: found.job.token };
      const step = await this.candidateEvent(state, found.job, { kind: 'St', jobId: identity.jobId, now });
      if (step.rejected) return none;
      const version = state.presentation;
      if (found.job.candidate.route === null && version !== null) found.job.reuseFrom = version.versionId;
      await this.save(state);
      const reuseFrom = version === null ? null : {
        versionId: version.versionId, ready: state.selected.kind === 'ready' && state.selected.version.versionId === version.versionId, version,
        identity: { planSha256: version.planSha256, producerVersion: version.producerVersion, profileVersion: version.profileVersion, editProfileVersion: version.toolSource.edit?.editProfileVersion ?? null },
      };
      return { capability, planned: found.job.candidate.route !== null || found.job.candidate.state !== 'building', admission: found.job.admission, reuseFrom };
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
   * The worker-only answer to `prepare` (E2-3): the snapshot plus the capability, the recorded plan and work, the job's
   * units and the frozen pricing and attribution. D comes only from the capability.
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
      const job = found?.job;
      const admission = job?.admission;
      const capability = job === undefined || now >= admission!.deadlineAt ? null : { token: job.token, deadlineAt: admission!.deadlineAt };
      const facts = capability === null ? undefined : job?.prepared;
      const plan = facts === undefined ? null
        : { route: facts.route, stages: videoCarrierRouteStages(facts.route), toolInputId: job!.candidate.toolInputId, planSha256: facts.planSha256 };
      const units = Object.fromEntries(Object.entries(job?.chunks ?? {}).map(([key, chunk]) => [key, {
        state: chunk.state, attempt: chunk.attempt, attempts: chunk.attempts.map(({ attempt, jobId, state: attemptState, usageRecorded }) => ({ attempt, jobId, state: attemptState, usageRecorded })),
        ...(job?.receipts?.[key] === undefined ? {} : { receipts: job.receipts[key] }),
      }]));
      // The carrier's encode parameters frozen at admission reach the worker, so every chunk encodes alike (§5.4).
      const frozen = admission?.pricing === undefined || admission.actorUserId === undefined || admission.limits === undefined || admission.encoding === undefined ? null
        : { pricing: admission.pricing, actorUserId: admission.actorUserId, projectId: admission.projectId ?? null,
          carrier: { crf: admission.limits.crf, preset: admission.limits.preset, maxShortSide: admission.encoding.carrier.maxShortSide } };
      return { ...snapshot, capability, plan, work: facts?.work ?? { kind: 'none' }, units, frozen };
    });
  }

  /**
   * Record the plan fact: freeze the route, the plan digest, the toolInputId (null on the edit route) and the facts the
   * candidate publishes from.
   * @param identity - The current job's capability.
   * @param plan - The route, toolInputId and plan digest.
   * @param plan.route - The carrier route.
   * @param plan.toolInputId - The tool input identity, null until the edit file is measured.
   * @param plan.planSha256 - The plan digest.
   * @param facts - The plan-derived facts, recorded with the plan.
   * @returns Whether the plan was taken, and the view.
   * @throws {Error} When durable storage fails.
   */
  planPresentation(identity: PresentationCapability, plan: { route: VideoCarrierRoute; toolInputId: string | null; planSha256: string }, facts?: PresentationPlanFacts): Promise<{ accepted: boolean; view: PresentationView }> {
    return this.gate(async () => {
      const state = await this.load();
      const found = state === undefined ? undefined : this.find(state, identity, identity.token);
      if (state === undefined || found?.kind !== 'current') return { accepted: false, view: this.view(state) };
      const job = found.job;
      const step = await this.candidateEvent(state, job, { kind: 'Ev', jobId: identity.jobId, fact: { kind: 'plan', route: plan.route, toolInputId: plan.toolInputId } });
      if (!step.rejected) {
        job.planSha256 ??= plan.planSha256;
        if (facts !== undefined) job.prepared ??= facts;
        await this.save(state);
      }
      return { accepted: !step.rejected, view: this.view(state) };
    });
  }

  /**
   * Move the current job to the next stage of its frozen route (Sg), or publish it at `publish`.
   * @param identity - The current job's capability.
   * @param stage - The requested stage.
   * @returns Whether the stage was recorded.
   * @throws {Error} When durable storage or R2 fails.
   */
  advanceStage(identity: PresentationCapability, stage: string): Promise<boolean> {
    return this.gate(async () => {
      const state = await this.load();
      const found = state === undefined ? undefined : this.find(state, identity, identity.token);
      if (state === undefined || found?.kind !== 'current') return false;
      if (stage === 'publish') {
        const verified = await this.publishWork(state, found.job);
        await this.save(state);
        return verified;
      }
      const step = await this.candidateEvent(state, found.job, { kind: 'Sg', jobId: identity.jobId, stage });
      if (!step.rejected) await this.save(state);
      return !step.rejected;
    });
  }

  /**
   * The SHA-256 of a stored object: R2's own checksum when the write supplied one, otherwise measured by reading it back.
   * Job outputs are written without one (multipart or streamed puts).
   * @param head - The object's head.
   * @returns The lowercase hex digest.
   * @throws {Error} When R2 fails.
   */
  private async storedSha256(head: R2Object): Promise<string> {
    const stored = head.checksums.sha256;
    return stored === undefined ? hashStoredObject(this.bucket, head.key) : [...new Uint8Array(stored)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  /**
   * Measure a receipt a job reported against the object R2 holds.
   * @param receipt - The reported key, size, type and digest.
   * @param receipt.storageKey - The key.
   * @param receipt.sizeBytes - The reported size.
   * @param receipt.contentType - The reported type.
   * @param receipt.sha256 - The reported digest.
   * @returns The measured object, or null when R2 disagrees.
   * @throws {Error} When R2 fails.
   */
  private async measure(receipt: { storageKey: string; sizeBytes: number; contentType: string; sha256: string }): Promise<{ etag: string; size: number; sha256: string } | null> {
    const head = await this.bucket.head(receipt.storageKey);
    if (head === null || head.size !== receipt.sizeBytes || head.httpMetadata?.contentType !== receipt.contentType) return null;
    const sha256 = await this.storedSha256(head);
    return sha256 === receipt.sha256 ? { etag: head.etag, size: head.size, sha256 } : null;
  }

  /**
   * Publish after the stitch (§5.1 step 4): the stitch's forwarded carrier receipt must match the DO's own measurement of R2;
   * a reused edit file must still be V's and stored as measured (§7.1 reuse-edit row). The DO then assembles the bundle,
   * computes its versionId and submits it as verified.
   * @param state - The state.
   * @param job - The current job.
   * @returns Whether the candidate is now verified.
   * @throws {Error} When R2 fails.
   */
  private async publishWork(state: PresentationState, job: JobRecord): Promise<boolean> {
    const facts = job.prepared;
    const { candidate, admission } = job;
    if (facts === undefined || candidate.state !== 'building' || candidate.stage !== 'stitch' || facts.route === 'reuse') return false;
    const unit = unitKey(admission.jobId, { kind: 'presentation-stitch' });
    const receipt = job.receipts?.[unit]?.find((output) => output.role === 'carrier');
    if (job.chunks[unit]?.state !== 'done' || receipt?.role !== 'carrier') return false;
    let edit: VideoPresentationEditReceipt | null = null;
    if (facts.route === 'edit') {
      if (job.editFile === undefined) return false;
      edit = job.editFile;
    } else if (facts.route === 'reuse_edit') {
      const reused = state.presentation?.versionId === job.reuseFrom ? state.presentation?.toolSource.edit ?? null : null;
      if (reused === null || !await this.stored([reused])) {
        await this.candidateEvent(state, job, { kind: 'Er', jobId: admission.jobId, code: 'reuse_source_invalid' });
        return false;
      }
      edit = reused;
    }
    const measured = await this.measure(receipt);
    if (measured === null) return false;
    const carrier = { storageKey: receipt.storageKey, url: this.objectURL(admission, receipt.storageKey), ...measured, contentType: receipt.contentType };
    const toolSource = { edit, keyframes: facts.source.keyframes, sourceDecodeKey: facts.source.sourceDecodeKey };
    let playback: VideoPresentationVersion['playback'];
    if (receipt.geometry === undefined) {
      playback = { kind: 'native', carrier, displayRect: videoCarrierGeometry(facts.display, admission.encoding?.carrier.maxShortSide ?? Number.MAX_SAFE_INTEGER).displayRect };
    } else {
      const manifest = await this.writeManifest(admission, facts.display, carrier, receipt.geometry);
      if (manifest === null) return false;
      playback = { kind: 'alpha-packed', carrier, manifest };
      const { storageKey, sha256, size, contentType } = manifest;
      job.receipts = { ...job.receipts, [unit]: [...job.receipts![unit]!.filter((output) => output.role !== 'manifest'), { role: 'manifest', storageKey, sha256, sizeBytes: size, contentType }] };
    }
    const bundle = await this.assembleVersion(job, facts, playback, toolSource);
    const step = advancePresentationCandidate(candidate, { kind: 'Ev', jobId: admission.jobId, fact: { kind: 'verified' } });
    if (step.next.state === 'verified') job.bundle = bundle;
    await this.applyCandidateStep(state, job, step);
    return job.candidate.state === 'verified';
  }

  /**
   * Write the alpha-packed manifest (§3.5): the measured packed carrier and the geometry its job reported, at the carrier key
   * plus `.manifest.json`. It names no version, so the carrier reuse route takes it as it is; P binds it by its measured hash.
   * @param admission - The job's admission.
   * @param display - The display grid the planes must match.
   * @param carrier - The measured packed carrier.
   * @param geometry - The packed geometry.
   * @returns The manifest's measured receipt, or null when the geometry does not fit the display.
   * @throws {Error} When R2 fails.
   */
  private async writeManifest(admission: VideoPresentationAdmission, display: VideoPresentationDisplay, carrier: Extract<VideoPresentationVersion['playback'], { kind: 'alpha-packed' }>['carrier'],
    geometry: NonNullable<Extract<VideoPresentationOutputReceipt, { role: 'carrier' }>['geometry']>): Promise<Extract<VideoPresentationVersion['playback'], { kind: 'alpha-packed' }>['manifest'] | null> {
    const parsed = alphaPackedManifestSchema.safeParse({ schemaVersion: 1, packed: carrier, ...geometry });
    if (!parsed.success || [parsed.data.colorRect, parsed.data.alphaRect].some((area) => area.width !== display.width || area.height !== display.height)) return null;
    const storageKey = `${carrier.storageKey}.manifest.json`;
    const contentType = 'application/json';
    const bytes = new TextEncoder().encode(JSON.stringify(parsed.data));
    const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    const object = await this.bucket.put(storageKey, bytes, { httpMetadata: { contentType }, sha256 });
    return { storageKey, url: this.objectURL(admission, storageKey), etag: object.etag, size: bytes.byteLength, sha256, contentType };
  }

  /**
   * Assemble a version bundle (§3.2 item 4, §3.5): the versionId hashes the target policy, the producer and playback profile,
   * the plan, the toolInputId, the display grid and the carrier's measured bytes.
   * @param job - The job.
   * @param facts - Its recorded plan facts.
   * @param playback - The measured playback object(s).
   * @param toolSource - The tool source.
   * @returns The bundle.
   * @throws {Error} When the version input is invalid.
   */
  private async assembleVersion(job: JobRecord, facts: PresentationPlanFacts, playback: VideoPresentationVersion['playback'], toolSource: VideoPresentationVersion['toolSource']): Promise<VideoPresentationVersion> {
    const { admission } = job;
    const policyVersion = admission.targetPolicyVersion ?? 1;
    const toolInputId = job.candidate.toolInputId!;
    const { producerVersion, profileVersion } = facts.versions;
    const versionId = await videoPresentationVersionId({ sourceFingerprint: admission.sourceFingerprint, policyVersion, producerVersion, profileVersion, planSha256: facts.planSha256,
      toolInputId, display: facts.display, playback: { sha256: playback.carrier.sha256, size: playback.carrier.size, contentType: playback.carrier.contentType } });
    return {
      schemaVersion: 1, sourceFingerprint: admission.sourceFingerprint, versionId, toolInputId, planSha256: facts.planSha256, policyVersion, producerVersion, profileVersion,
      original: admission.original ?? { width: null, height: null, duration: null }, display: facts.display, playback, toolSource,
    };
  }

  /**
   * Publish the carrier reuse route (§7.1): the selected ready P's playback file, manifest and edit file under the new target
   * policy, as a new versionId. P no longer the ready version the route was planned from, or one of its objects no longer
   * stored as measured, fails the candidate `reuse_source_invalid`.
   * @param identity - The current job's capability.
   * @returns Whether the candidate is now verified.
   * @throws {Error} When storage or R2 fails.
   */
  publishReuse(identity: PresentationCapability): Promise<boolean> {
    return this.gate(async () => {
      const state = await this.load();
      const found = state === undefined ? undefined : this.find(state, identity, identity.token);
      if (state === undefined || found?.kind !== 'current' || found.job.prepared?.route !== 'reuse' || found.job.candidate.state !== 'building') return false;
      const job = found.job;
      const selected = state.presentation;
      if (state.selected.kind !== 'ready' || selected === null || state.selected.version.versionId !== job.reuseFrom || !await this.stored(this.objectsOf(selected))) {
        await this.candidateEvent(state, job, { kind: 'Er', jobId: identity.jobId, code: 'reuse_source_invalid' });
        await this.save(state);
        return false;
      }
      const policyVersion = job.admission.targetPolicyVersion ?? 1;
      const { carrier } = selected.playback;
      const versionId = await videoPresentationVersionId({ sourceFingerprint: selected.sourceFingerprint, policyVersion, producerVersion: selected.producerVersion,
        profileVersion: selected.profileVersion, planSha256: selected.planSha256, toolInputId: selected.toolInputId, display: selected.display,
        playback: { sha256: carrier.sha256, size: carrier.size, contentType: carrier.contentType } });
      const step = advancePresentationCandidate(job.candidate, { kind: 'Ev', jobId: identity.jobId, fact: { kind: 'verified' } });
      if (step.next.state === 'verified') job.bundle = { ...selected, versionId, policyVersion };
      await this.applyCandidateStep(state, job, step);
      await this.save(state);
      return job.candidate.state === 'verified';
    });
  }

  /**
   * Apply one chunk or attempt report; a chunk that fails for good fails the candidate with the underlying code. A count Done
   * makes the grid exact and plans the windows on it (§4.1, §5.4); an edit stitch Done is measured and gives the toolInputId
   * (§3.2 item 3), or fails `edit_over_cap` over the cap (§4.2).
   * @param identity - The job's capability.
   * @param unit - The unit.
   * @param report - The report.
   * @returns Whether the report was accepted.
   * @throws {Error} When durable storage or R2 fails.
   */
  reportChunk(identity: PresentationCapability, unit: PresentationChunkUnit, report: PresentationChunkReport): Promise<boolean> {
    return this.gate(async () => {
      const state = await this.load();
      const found = state === undefined ? undefined : this.find(state, identity, identity.token);
      if (state === undefined || found === undefined) return false;
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
      const completes = report.kind === 'Done' && before.state === 'open' && step.next.state === 'done';
      // Output receipts count only for the attempt that completed the unit, at that attempt's own output key.
      if (report.kind === 'Done' && report.receipts !== undefined) {
        if (!videoPresentationDoneReceiptsSchema.safeParse(report.receipts).success) return false;
        const output = report.receipts[0]!;
        if (completes && output.storageKey !== videoPresentationWorkKeyFor(job.admission.storageKey, videoContainerJobId({ ...chunkIdentity, attempt: report.attempt }))) return false;
      }
      let edit: VideoPresentationEditReceipt | undefined;
      if (completes && unit.kind === 'presentation-edit-stitch' && found.kind === 'current') {
        const output = report.receipts?.[0];
        const measured = output?.role === 'edit' ? await this.measure(output) : null;
        const editProfileVersion = job.prepared?.versions.editProfileVersion;
        if (output?.role !== 'edit' || measured === null || editProfileVersion == null) return false;
        edit = { storageKey: output.storageKey, url: this.objectURL(job.admission, output.storageKey), ...measured, contentType: output.contentType, editProfileVersion, tier: output.tier };
      }
      if (completes && report.receipts !== undefined) job.receipts = { ...job.receipts, [key]: report.receipts };
      job.chunks[key] = step.next;
      if (completes && unit.kind === 'presentation-count' && report.count !== undefined && job.prepared !== undefined) job.prepared = exactGrid(job.prepared, report.count);
      if (edit !== undefined) await this.takeEditFile(state, job, edit);
      for (const effect of step.effects) {
        if (effect.kind === 'candidate-failed') await this.candidateEvent(state, job, { kind: 'Er', jobId: identity.jobId, code: effect.code });
      }
      await this.save(state);
      return true;
    });
  }

  /**
   * Take the measured edit file: over `presentation.max_edit_bytes` the candidate fails `edit_over_cap`; otherwise its digest
   * completes the toolInputId (§3.2 item 3, §4.2 size cap row).
   * @param state - The state.
   * @param job - The current job.
   * @param edit - The measured edit receipt.
   * @returns Nothing.
   * @throws {Error} When publication fails.
   */
  private async takeEditFile(state: PresentationState, job: JobRecord, edit: VideoPresentationEditReceipt): Promise<void> {
    const { admission, prepared } = job;
    const encoding = admission.encoding;
    if (prepared === undefined || encoding === undefined) return;
    const over = editFileSizeFailure({ frameCount: prepared.display.frameCount, width: prepared.display.width, height: prepared.display.height,
      bytesPerPixel: encoding.edit.bytesPerPixel, maxEditBytes: encoding.edit.maxEditBytes, measuredBytes: edit.size });
    if (over !== null) { await this.candidateEvent(state, job, { kind: 'Er', jobId: admission.jobId, code: over }); return; }
    const toolInputId = await videoPresentationToolInputId({ sourceFingerprint: admission.sourceFingerprint, planSha256: prepared.planSha256, editFileSha256: edit.sha256 });
    const step = await this.candidateEvent(state, job, { kind: 'Ev', jobId: admission.jobId, fact: { kind: 'tool-input', toolInputId } });
    if (!step.rejected) job.editFile = edit;
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
      if (state === undefined || found === undefined) return this.view(state);
      const job = found.job;
      if (fact.kind === 'finished') {
        state.usage[identity.jobId] ??= { wallMs: fact.usage.wallMs, cpuUsec: fact.usage.cpuUsec, acknowledged: false };
      } else {
        const wasVerified = job.candidate.state === 'verified';
        const step = advancePresentationCandidate(job.candidate, { kind: 'Ev', jobId: identity.jobId, fact: { kind: 'verified' } });
        if (!wasVerified && step.next.state === 'verified') job.bundle = fact.bundle.descriptor;
        await this.applyCandidateStep(state, job, step);
      }
      await this.save(state);
      return this.view(state);
    });
  }

  /**
   * Fail a job's candidate with a stable code (Er).
   * @param identity - The job's identity.
   * @param code - The failure code.
   * @returns The view.
   * @throws {Error} When durable storage fails.
   */
  fail(identity: PresentationJobIdentity, code: string): Promise<PresentationView> {
    return this.gate(async () => {
      const state = await this.load();
      const found = state === undefined ? undefined : this.find(state, identity, null);
      if (state === undefined || found === undefined) return this.view(state);
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
   * Read the current facts, checking the stored descriptor against R2.
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
      // A current verified candidate P does not select is published now (§7.2 invalid row).
      const waiting = state.current;
      if (state.selected.kind === 'invalid' && waiting !== null && !waiting.candidate.archived && waiting.candidate.state === 'verified' &&
        (waiting.bundle as { versionId?: unknown } | null)?.versionId !== state.selected.version.versionId) {
        await this.commitPresentationVersion(state, waiting);
      }
      await this.save(state);
      return this.view(state);
    });
  }

  /**
   * Apply one candidate event and its effects; the candidate leaves a stage only once every unit of it is done (§7.1.1).
   * @param state - The state.
   * @param job - The job.
   * @param event - The event.
   * @returns The step.
   * @throws {Error} When publication fails.
   */
  private async candidateEvent(state: PresentationState, job: JobRecord, event: PresentationCandidateEvent): Promise<ReturnType<typeof advancePresentationCandidate>> {
    if (event.kind === 'Sg' && !this.stageDone(job)) return { next: job.candidate, effects: [], rejected: true };
    const step = advancePresentationCandidate(job.candidate, event);
    await this.applyCandidateStep(state, job, step);
    return step;
  }

  /**
   * Whether every unit of the candidate's current stage is done, and the edit stitch has given the toolInputId.
   * @param job - The job.
   * @returns True when the candidate may move on.
   * @throws {never} Never.
   */
  private stageDone(job: JobRecord): boolean {
    const stage = job.candidate.stage;
    if (stage === null) return false;
    if (stage === 'edit_stitch' && job.candidate.toolInputId === null) return false;
    return stageUnits(stage, job.prepared?.work).every((unit) => job.chunks[unitKey(job.admission.jobId, unit)]?.state === 'done');
  }

  /**
   * Persist a candidate step into its job and publish when it asks to; dispatch effects are the worker's.
   * @param state - The state.
   * @param job - The job.
   * @param step - The step.
   * @returns Nothing.
   * @throws {Error} When publication fails.
   */
  private async applyCandidateStep(state: PresentationState, job: JobRecord, step: ReturnType<typeof advancePresentationCandidate>): Promise<void> {
    job.candidate = step.next;
    if (step.effects.some((effect) => effect.kind === 'publish')) await this.commitPresentationVersion(state, job);
  }

  /**
   * Submit Pub for a verified job: physical completeness and currency decide the selection; the current descriptor (R0) is
   * replaced in R2 under its observed ETag before the DO selects it.
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
    const step = advanceSelectedPresentation(state.selected, { kind: 'Pub', candidate: { versionId: bundle.versionId, toolInputId: bundle.toolInputId }, complete, current });
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
   * The objects a version names: the playback file, the manifest and the edit file.
   * @param bundle - The version.
   * @returns Their receipts.
   * @throws {never} Never.
   */
  private objectsOf(bundle: VideoPresentationVersion): { storageKey: string; etag: string; size: number; contentType: string }[] {
    const playback = bundle.playback.kind === 'alpha-packed' ? [bundle.playback.carrier, bundle.playback.manifest] : [bundle.playback.carrier];
    return bundle.toolSource.edit === null ? playback : [...playback, bundle.toolSource.edit];
  }

  /**
   * Whether every object is stored with the measured etag, size and type.
   * @param objects - The receipts.
   * @returns True when all are.
   * @throws {Error} When R2 fails.
   */
  private async stored(objects: readonly { storageKey: string; etag: string; size: number; contentType: string }[]): Promise<boolean> {
    const heads = await Promise.all(objects.map((object) => this.bucket.head(object.storageKey)));
    return objects.every((object, index) => heads[index] !== null && heads[index]!.etag === object.etag && heads[index]!.size === object.size &&
      heads[index]!.httpMetadata?.contentType === object.contentType);
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
    return this.stored(this.objectsOf(bundle));
  }

  /**
   * Locate a job by its identity: the current candidate or an archived one.
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
    return archived === undefined ? undefined : { kind: 'archived', job: archived };
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

/** What the basic execution's probe found (design §5.1 step 2): the plan, its digest and versions, the tool source and the grid inputs. */
export type PresentationProbe = PresentationProbeAnswerParsed;
/** The basic container's work, injected so the orchestration is tested over the real store with a fake container. */
export interface PresentationContainerPort {
  probe(capability: PresentationCapability): Promise<PresentationProbe>;
  usage(): Promise<{ wallMs: number; cpuUsec: number | null } | null>;
}

/**
 * The windows of the chunked stages on a frame count (§5.4 chunking row): grid frames divided evenly, each chunk within the
 * target with its pre-roll; an unseekable original's edit file is one window.
 * @param route - The route.
 * @param frameCount - The grid frames.
 * @param chunking - The chunk budget.
 * @param seekable - Whether the original seeks.
 * @returns The work.
 * @throws {RangeError} When the count or the budget is out of range.
 */
function routeWork(route: VideoCarrierRoute, frameCount: number, chunking: PresentationPlanFacts['chunking'], seekable: boolean): VideoPresentationPrepareAnswer['work'] {
  if (route === 'reuse' || chunking === null) return { kind: 'none' };
  const windows = (plan: ChunkPlan): VideoEncodeChunk[] => planVideoEncodeChunks({ frameCount, frameSeconds: plan.frameSeconds, prerollFrames: plan.prerollFrames, targetSeconds: chunking.targetSeconds });
  const chunks = windows(chunking.encode);
  if (route !== 'edit' || chunking.edit === null) return { kind: 'encode', chunks };
  return { kind: 'edit', editChunks: seekable ? windows(chunking.edit) : [{ start: 0, end: frameCount }], chunks };
}

/**
 * The facts once the decode-only count completes the grid (§4.1 frame count row): the exact frame count, and the windows
 * planned again on it (§5.4 chunking row).
 * @param facts - The recorded facts.
 * @param count - The count's last real frame time and decoded frames.
 * @param count.lastVideoTime - The last decoded frame's display time.
 * @param count.sourceFrames - The decoded frames.
 * @returns The facts on the exact grid.
 * @throws {RangeError} When the grid cannot be planned.
 */
function exactGrid(facts: PresentationPlanFacts, count: { lastVideoTime: { numerator: number; denominator: number }; sourceFrames: number }): PresentationPlanFacts {
  const grid = planFrameGrid({ ...facts.gridInput, lastVideoTime: count.lastVideoTime, sourceFrames: count.sourceFrames, singleFrameMs: facts.plan.grid.singleFrameDurationMs });
  const display = { ...facts.display, gridStart: grid.gridStart, leadFrames: grid.leadFrames, frameCount: grid.frameCount, realFrameCount: grid.realFrameCount, holdFrames: grid.holdFrames };
  return { ...facts, display, work: routeWork(facts.route, grid.frameCount, facts.chunking, facts.source.seekable) };
}

/**
 * One basic execution of a presentation job (design §5.1 steps 1–2): grant the job, probe and plan, choose the route from
 * the plan's identity and V's (§7.1), estimate the whole route against the deadline (§5.4 limit row), record the plan,
 * publish the carrier reuse route here and leave the counted, edit and playback stages to the worker. A replay of a
 * started job never probes again.
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
  if (capability !== null && admission !== null && !grant.planned) {
    await planAndProduce(store, capability, admission, grant.reuseFrom, port, now);
    const usage = await port.usage();
    if (usage !== null) await store.report(capability, { kind: 'finished', usage });
  }
  return store.prepareAnswer(identity, now);
}

/**
 * Probe, plan the route and its work, and take the carrier reuse route as far as publishing.
 * @param store - The store.
 * @param capability - The granted capability.
 * @param admission - The frozen admission.
 * @param reuseFrom - V at the grant.
 * @param port - The basic container.
 * @param now - The current time.
 * @returns Nothing.
 * @throws {Error} When storage, R2 or the container fails.
 */
async function planAndProduce(store: VideoPresentationStore, capability: PresentationCapability, admission: VideoPresentationAdmission,
  reuseFrom: PresentationReuseSource | null, port: PresentationContainerPort, now: number): Promise<void> {
  const probe = await port.probe(capability);
  if (probe.kind === 'failed') { await store.fail(capability, probe.code); return; }
  const { encoding } = admission;
  if (encoding === undefined) { await store.fail(capability, 'admission_invalid'); return; }
  const { plan, planSha256, versions, source } = probe;
  const route = chooseVideoCarrierRoute({ plan: { planSha256, ...versions }, reuseFrom: reuseFrom === null ? null : { identity: reuseFrom.identity, ready: reuseFrom.ready } });
  const reused = reuseFrom?.version;
  const toolInputId = route === 'edit' ? null : route === 'reuse' ? reused!.toolInputId
    : await videoPresentationToolInputId({ sourceFingerprint: admission.sourceFingerprint, planSha256, editFileSha256: route === 'reuse_edit' ? reused!.toolSource.edit!.sha256 : null });
  // A reuse route has V's plan, so V's exact grid; otherwise the probe's estimate until the count (§4.1 frame count row).
  const display: VideoPresentationDisplay = route === 'reuse' || route === 'reuse_edit' ? reused!.display : {
    width: plan.display.width, height: plan.display.height, fps: plan.grid.fps, gridStart: plan.grid.gridStart,
    leadFrames: plan.grid.leadFrames, frameCount: probe.estimate.frameCount, realFrameCount: probe.estimate.realFrameCount, holdFrames: probe.estimate.frameCount - probe.estimate.realFrameCount,
  };
  const remainingSeconds = (capability.deadlineAt - now) / 1000;
  const rates = encoding.encoder;
  const stageSource = { sourceDecodeKey: source.sourceDecodeKey, hdr: source.hdr, editTier: source.editTier };
  const carrier = videoCarrierGeometry(display, encoding.carrier.maxShortSide);
  // Decode and tone mapping run at the source's size, encodes at the output's (§5.4 estimate row).
  const seconds = (frames: number, prerollFrames: number, keys: VideoStageKeys, output: { width: number; height: number }): number => estimateVideoJobSeconds({
    encodedFrames: frames, prerollFrames, sourceWidth: display.width, sourceHeight: display.height, outputWidth: output.width, outputHeight: output.height, ...keys,
  }, rates);
  const perFrame = (keys: VideoStageKeys, output: { width: number; height: number }): number => seconds(1, 0, keys, output) - rates.startSeconds;
  const encodeKeys = presentationStageKeys('encode', stageSource);
  const editKeys = source.editTier === null ? null : presentationStageKeys('edit', stageSource);
  const preroll = (toolSource: 'original' | 'edit'): number => decodePrerollFrames({ toolSource, keyframes: source.keyframes, fps: display.fps });
  const chunking = route === 'reuse' ? null : {
    targetSeconds: encoding.chunkShare * remainingSeconds,
    encode: { frameSeconds: perFrame(encodeKeys, carrier), prerollFrames: preroll(source.editTier === null ? 'original' : 'edit') },
    edit: editKeys === null ? null : { frameSeconds: perFrame(editKeys, display), prerollFrames: preroll('original') },
  };
  let failure: string | null = null;
  let work: VideoPresentationPrepareAnswer['work'] = { kind: 'none' };
  if (route !== 'reuse') {
    work = routeWork(route, display.frameCount, chunking, source.seekable);
    const window = (chunk: VideoEncodeChunk, keys: VideoStageKeys, output: { width: number; height: number }, prerollFrames: number): number => seconds(chunk.end - chunk.start, prerollFrames, keys, output);
    const stages: PresentationRouteStage[] = [];
    if (route !== 'reuse_edit') {
      stages.push({ stage: 'count', chunked: false, jobSeconds: [seconds(probe.estimate.sourceFrames, 0, presentationStageKeys('count', stageSource), display)] });
    }
    if (work.kind === 'edit' && editKeys !== null) {
      stages.push({ stage: 'edit', chunked: source.seekable, jobSeconds: work.editChunks.map((chunk) => window(chunk, editKeys, display, preroll('original'))) });
      // The stitches copy streams: their estimate is the job start; the playback stitch encodes the audio once (§5.4 stitch row).
      stages.push({ stage: 'edit_stitch', chunked: false, jobSeconds: [rates.startSeconds] });
    }
    if (work.kind !== 'none') stages.push({ stage: 'encode', chunked: true, jobSeconds: work.chunks.map((chunk) => window(chunk, encodeKeys, carrier, chunking!.encode.prerollFrames)) });
    const audioSeconds = plan.audioTrack === null ? 0 : (display.frameCount * display.fps.denominator) / display.fps.numerator;
    stages.push({ stage: 'stitch', chunked: false, jobSeconds: [audioSeconds === 0 ? rates.startSeconds : estimateAudioEncodeSeconds(audioSeconds, rates)] });
    failure = presentationRouteFailure({ remainingSeconds, chunkShare: encoding.chunkShare, maxParallelChunks: encoding.maxParallelChunks, stages });
    if (failure === null && route === 'edit') {
      failure = editFileSizeFailure({ frameCount: display.frameCount, width: display.width, height: display.height, bytesPerPixel: encoding.edit.bytesPerPixel,
        maxEditBytes: encoding.edit.maxEditBytes, measuredBytes: null });
    }
  }
  const facts: PresentationPlanFacts = { route, toolInputId, planSha256, versions, plan, source, gridInput: probe.gridInput, display, work, chunking };
  const { view } = await store.planPresentation(capability, { route, toolInputId, planSha256 }, facts);
  if (view.candidate.state !== 'building') return;
  if (failure !== null) { await store.fail(capability, failure); return; }
  if (route === 'reuse') await store.publishReuse(capability);
}
