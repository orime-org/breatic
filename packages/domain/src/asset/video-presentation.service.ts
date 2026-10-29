// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { randomUUID } from 'node:crypto';
import { budgetDeadlineFrom, ConflictError, NotFoundError, ValidationError, createQueue, defaultJobOpts, env, getMiniToolsConfig, getStorageAdapter, projectAuthService } from '@breatic/core';
import { alphaManifestKeyFor, alphaPackedKeyFor, readVideoSourceLedger, t, videoPresentationAtIngest, videoPresentationResponseSchema, videoPresentationSourceBindingSchema,
  VideoSourceLedgerReadRefused, videoSourceLedgerKeyFor, videoSourceLedgerTableKeyFor, type VideoSourceLedgerCompanion, type VideoSourceLedgerReadLimits,
  type StudioAssetEntity, type VideoPresentation, type VideoPresentationAttempt, type VideoPresentationIngestRequest,
  type VideoPresentationIngestSnapshot, type VideoPresentationResponse, type VideoPresentationSourceBinding, type VideoPresentationRepairResponse } from '@breatic/shared';
import { findById, findLiveByStorageKey } from '@domain/asset/asset.repo.js';
import { fillMediaNumbers } from '@domain/asset/asset.repo.js';
import { containerCostUsd } from '@domain/credit/container-cost.js';
import { createUsageRecorder } from '@domain/credit/usage-recorder.js';

/** An authorized read of a canonical registered video. */
export interface ResolveVideoPresentationInput { projectId: string; userId: string; canonicalURL: string }
/** An explicit repair retains the press identity across delivery retries. */
export interface RepairVideoPresentationInput extends ResolveVideoPresentationInput { sourceFingerprint: string; requestId: string }
/** An automatic registration or first-read metadata preparation. */
export interface EnsureVideoPresentationInput { assetId: string; parentDeadlineAt?: number; knownAlpha?: boolean }
/** Repair answers the current canonical identity and the fixed accepted work. */
export type { VideoPresentationRepairResponse } from '@breatic/shared';
/** The queue retains the accepted source identity and original deadline on retry. */
export interface VideoPresentationJob { assetId: string; sourceFingerprint: string; jobId: string; deadlineAt: number }
/** The registered source and its whole validated frame table. */
export interface VideoSourceLedgerRead { sourceBinding: VideoPresentationSourceBinding; ledger: VideoSourceLedgerCompanion }
/** Source readiness and platform accounting remain independent observations. */
export interface VideoPresentationExecutionResult { status: 'ready' | 'failed' | 'gone' | 'stale'; usageRecorded: boolean; usagePending: boolean; error?: string }
/** Internal admission context; explicit repairs retain their actual requester. */
interface AdmissionOptions { parentDeadlineAt?: number; knownAlpha?: boolean; repair?: boolean; requestId?: string; userId?: string; projectId?: string }
/** Automatic metadata preparation has no user task or credit hold. */
export const VIDEO_PRESENTATION_QUEUE = 'video-presentation';
let queue: ReturnType<typeof createQueue> | undefined;

/** A stale repair returns current registry truth without admitting new work. */
export class VideoPresentationSourceChanged extends ConflictError {
  /**
   * Carry the current binding for the route's explicit conflict response.
   * @param currentSourceBinding - Actual current registered bytes.
   */
  constructor(public readonly currentSourceBinding: VideoPresentationSourceBinding) {
    super(t('server.mini_tool.foreignSource'));
    this.name = 'VideoPresentationSourceChanged';
  }
}

/**
 * Require membership before touching a requested source or queue.
 * @param input - Current member and project.
 * @returns Nothing after read access succeeds.
 * @throws {NotFoundError} When this project is hidden or no longer live.
 */
async function assertAccess(input: ResolveVideoPresentationInput): Promise<void> {
  if (await projectAuthService.loadProjectRole(input.userId, input.projectId) === null) throw new NotFoundError(t('server.error.not_found'));
}

/**
 * Read real registered bytes while retaining legacy single-source sharing semantics.
 * @param canonicalURL - The selected asset address.
 * @returns Its real live video row and public registry binding.
 * @throws {ValidationError} When no registered video corresponds to the address.
 */
async function registeredSource(canonicalURL: string): Promise<{ row: StudioAssetEntity; binding: VideoPresentationSourceBinding }> {
  const storage = await getStorageAdapter();
  const key = storage.keyFromUrl(canonicalURL);
  const row = key === null ? null : await findLiveByStorageKey(key);
  if (row === null || row.deletedAt !== null || row.kind !== 'video') throw new ValidationError(t('server.mini_tool.foreignSource'));
  return { row, binding: await sourceBinding(row) };
}

/**
 * Map one registered row without inventing missing media measurements.
 * @param row - The live registered video.
 * @returns Nullable metadata and its actual content hash.
 * @throws {ValidationError} When stored registry facts are invalid.
 */
async function sourceBinding(row: StudioAssetEntity): Promise<VideoPresentationSourceBinding> {
  const storage = await getStorageAdapter();
  const parsed = videoPresentationSourceBindingSchema.safeParse({
    assetId: row.id, contentHash: row.contentHash, canonicalURL: storage.publicUrl(row.storageKey), kind: row.kind,
    mediaInfo: { width: row.width, height: row.height, duration: row.durationSeconds, mimeType: row.mimeType },
  });
  if (!parsed.success) throw new ValidationError(t('server.mini_tool.foreignSource'));
  return parsed.data;
}

/**
 * Supply a descriptor original only when all measurements are trusted and complete.
 * @param row - Registered media facts, possibly still unknown.
 * @returns Complete positive original geometry and duration, or none.
 * @throws {never} Unknown values stay unknown.
 */
function originalOf(row: StudioAssetEntity): VideoPresentation['original'] | null {
  return Number.isSafeInteger(row.width) && Number.isSafeInteger(row.height) && row.width !== null && row.height !== null && row.width > 0 && row.height > 0 &&
    row.durationSeconds !== null && Number.isFinite(row.durationSeconds) && row.durationSeconds > 0 ? { width: row.width, height: row.height, duration: row.durationSeconds } : null;
}

/**
 * Queue the identity actually accepted by ingest, including replayed admissions.
 * @param row - The canonical registered winner, including dedup winners.
 * @param snapshot - Durable admission facts from its canonical-key owner.
 * @returns Fixed accepted work identity, or none before admission.
 * @throws {Error} When the queue refuses durable work.
 */
async function enqueue(row: StudioAssetEntity, snapshot: VideoPresentationIngestSnapshot): Promise<VideoPresentationAttempt | null> {
  const attempt = snapshot.attempt;
  if (attempt === null) return null;
  if (attempt.status === 'accepted' || attempt.status === 'running' || (attempt.usage !== null && attempt.usageRecorded !== true)) {
    queue ??= createQueue(VIDEO_PRESENTATION_QUEUE);
    const job: VideoPresentationJob = { assetId: row.id, sourceFingerprint: row.contentHash, jobId: attempt.jobId, deadlineAt: attempt.deadlineAt };
    await queue.add('prepare', job, { ...defaultJobOpts(), jobId: attempt.jobId });
  }
  return { jobId: attempt.jobId, deadlineAt: attempt.deadlineAt };
}

/**
 * Accept source-scoped platform work without resetting a current attempt.
 * @param row - Actual registered source, never a derivative.
 * @param options - Any parent deadline and explicit repair attribution.
 * @returns The persisted admission and descriptor facts.
 * @throws {Error} When ingest admission or queueing fails.
 */
async function accept(row: StudioAssetEntity, options: AdmissionOptions): Promise<VideoPresentationIngestSnapshot> {
  const storage = await getStorageAdapter();
  const config = getMiniToolsConfig();
  const settings = config.presentation;
  const ledger = settings.source_ledger;
  const size = config.classes[settings.container_class]!;
  const request: VideoPresentationIngestRequest = {
    action: 'accept', storageKey: row.storageKey, sourceFingerprint: row.contentHash,
    jobId: `video-presentation-${options.requestId ?? randomUUID()}`, deadlineAt: options.parentDeadlineAt ?? budgetDeadlineFrom(Date.now()),
    original: originalOf(row), contentType: row.mimeType, knownAlpha: options.knownAlpha === true, repair: options.repair === true,
    registeredMetadata: { width: row.width, height: row.height, duration: row.durationSeconds },
    actorUserId: options.userId ?? row.producedByUserId, projectId: options.projectId ?? null,
    packedURL: storage.publicUrl(alphaPackedKeyFor(row.storageKey)), manifestURL: storage.publicUrl(alphaManifestKeyFor(row.storageKey)),
    // Every admission requests the ledger; the ingest store decides whether this source still needs one produced.
    sourceLedgerURL: storage.publicUrl(videoSourceLedgerKeyFor(row.storageKey)), sourceLedgerTableURL: storage.publicUrl(videoSourceLedgerTableKeyFor(row.storageKey)),
    limits: { ...config.plan_limits, maxSourceBytes: settings.max_source_bytes, maxPackedBytes: settings.max_packed_bytes, crf: settings.crf, preset: settings.preset,
      sourceLedger: { maxBytes: ledger.max_bytes, probeStdoutBytes: ledger.probe_stdout_bytes, metadataBytes: ledger.metadata_bytes,
        isoBoxCount: ledger.iso_box_count, matroskaElementCount: ledger.matroska_element_count, matroskaMaxBlocks: ledger.matroska_max_blocks } },
    pricing: { containerClass: settings.container_class, size: { vcpu: size.vcpu, memory_gib: size.memory_gib, disk_gb: size.disk_gb }, prices: { ...config.prices } },
  };
  const snapshot = await videoPresentationAtIngest(env.INGEST_BASE_URL, env.INGEST_SHARED_SECRET, request);
  await enqueue(row, snapshot);
  return snapshot;
}

/**
 * The current read policy for a stored source frame table.
 * @returns The three ceilings a reader holds the table to.
 * @throws {Error} When configuration cannot be read.
 */
function sourceLedgerReadLimits(): VideoSourceLedgerReadLimits {
  const policy = getMiniToolsConfig().presentation.source_ledger;
  return { maxBytes: policy.max_bytes, maxPhysicalFrames: policy.max_physical_frames, maxOccurrences: policy.max_occurrences };
}

/**
 * Convert internal work facts to the owned public source response.
 * @param binding - Current registry identity.
 * @param snapshot - Validated durable source facts.
 * @returns A public response with polling only for accepted pending work.
 * @throws {Error} When ingest violates the public source or geometry contract.
 */
function response(binding: VideoPresentationSourceBinding, snapshot: VideoPresentationIngestSnapshot): VideoPresentationResponse {
  const attempt = snapshot.attempt;
  const pending = attempt?.status === 'accepted' || attempt?.status === 'running';
  return videoPresentationResponseSchema.parse({ sourceBinding: binding, presentation: snapshot.presentation,
    ...(snapshot.manifest === undefined ? {} : { manifest: snapshot.manifest }),
    preparation: attempt === null ? null : { status: attempt.status, attempt: { jobId: attempt.jobId, deadlineAt: attempt.deadlineAt },
      ...(attempt.error === undefined ? {} : { error: attempt.error }) },
    pollAfterMs: pending ? getMiniToolsConfig().poll_interval_ms : null,
    // An ingest answer without the field predates the ledger; it stays unknown.
    ...(snapshot.sourceLedger === undefined ? {} : { sourceLedger: snapshot.sourceLedger }),
    sourceLedgerReadLimits: sourceLedgerReadLimits(),
  });
}

/**
 * Resolve project-authorized registry and presentation truth.
 * @param input - Current project member and selected canonical address.
 * @returns Registered identity with nullable trusted presentation.
 * @throws {NotFoundError} When project read access is absent.
 * @throws {ValidationError} When the URL has no live registered video.
 * @throws {Error} When ingest, queueing or its trusted response fails.
 */
export async function resolveVideoPresentation(input: ResolveVideoPresentationInput): Promise<VideoPresentationResponse> {
  await assertAccess(input);
  const { row, binding } = await registeredSource(input.canonicalURL);
  let snapshot = await videoPresentationAtIngest(env.INGEST_BASE_URL, env.INGEST_SHARED_SECRET, {
    action: 'read', storageKey: row.storageKey, sourceFingerprint: row.contentHash,
  });
  // Work that is not running and has no ledger state yet is admitted once; any ledger state, including a failure, is answered as it is.
  const status = snapshot.attempt?.status;
  if (status !== 'accepted' && status !== 'running' && (snapshot.sourceLedger === undefined || snapshot.sourceLedger === null)) snapshot = await accept(row, {});
  else await enqueue(row, snapshot);
  return response(binding, snapshot);
}

/**
 * Read the stored source frame table of a registered video for a project member.
 *
 * The receipt is trusted only once it names the registered row's own hash and
 * the companion address derived from its own storage key. A source with no
 * ready table is refused here; admitting work to make one is the presentation
 * read's job, not this one's.
 * @param input - Current project member and selected canonical address.
 * @param deadlineAt - The calling task's own deadline, in epoch ms.
 * @param signal - The caller's signal.
 * @returns The registered binding and the whole validated table.
 * @throws {NotFoundError} When project read access is absent.
 * @throws {ValidationError} When the URL has no live registered video.
 * @throws {VideoSourceLedgerReadRefused} When there is no ready receipt for this source, or its body is not the stored table.
 * @throws {DeadlinePassed} When the deadline comes before the table is validated.
 * @throws {Error} When ingest or the companion delivery fails.
 */
export async function readSourceLedger(input: ResolveVideoPresentationInput, deadlineAt: number, signal?: AbortSignal): Promise<VideoSourceLedgerRead> {
  await assertAccess(input);
  const { row, binding } = await registeredSource(input.canonicalURL);
  const snapshot = await videoPresentationAtIngest(env.INGEST_BASE_URL, env.INGEST_SHARED_SECRET, {
    action: 'read', storageKey: row.storageKey, sourceFingerprint: row.contentHash,
  });
  const state = snapshot.sourceLedger;
  // A version 2 receipt is read by the v2 reader; this one reads version 1 only.
  if (state === undefined || state === null || state.state !== 'ready' || state.receipt.schemaVersion !== 1) throw new VideoSourceLedgerReadRefused('receipt');
  const storage = await getStorageAdapter();
  if (state.receipt.sourceFingerprint !== binding.contentHash || state.receipt.url !== storage.publicUrl(videoSourceLedgerKeyFor(row.storageKey))) {
    throw new VideoSourceLedgerReadRefused('receipt');
  }
  const ledger = await readVideoSourceLedger(state.receipt, sourceLedgerReadLimits(), { deadlineAt, ...(signal === undefined ? {} : { signal }) });
  return { sourceBinding: binding, ledger };
}

/**
 * Repair an unchanged registered source under read permission.
 * @param input - Member, canonical identity and idempotent press identity.
 * @returns Current source and accepted repair identity.
 * @throws {NotFoundError} When project read access is absent.
 * @throws {VideoPresentationSourceChanged} When the client fingerprint is stale.
 * @throws {Error} When registration, admission or queueing fails.
 */
export async function repairVideoPresentation(input: RepairVideoPresentationInput): Promise<VideoPresentationRepairResponse> {
  await assertAccess(input);
  const { row, binding } = await registeredSource(input.canonicalURL);
  if (binding.contentHash !== input.sourceFingerprint) throw new VideoPresentationSourceChanged(binding);
  const snapshot = await accept(row, { repair: true, requestId: input.requestId, userId: input.userId, projectId: input.projectId });
  return { ...response(binding, snapshot), attempt: snapshot.attempt === null ? null : { jobId: snapshot.attempt.jobId, deadlineAt: snapshot.attempt.deadlineAt } };
}

/**
 * Arrange platform-funded presentation work after registration.
 * @param input - Registered winner and any parent run's original deadline.
 * @returns The accepted work, or none for a gone or non-video asset.
 * @throws {Error} When durable admission or queueing fails.
 */
export async function ensureVideoPresentation(input: EnsureVideoPresentationInput): Promise<VideoPresentationAttempt | null> {
  const row = await findById(input.assetId);
  if (row === null || row.deletedAt !== null || row.kind !== 'video') return null;
  const snapshot = await accept(row, input);
  return snapshot.attempt === null ? null : { jobId: snapshot.attempt.jobId, deadlineAt: snapshot.attempt.deadlineAt };
}

/**
 * Execute the accepted metadata job and record one actual platform expense.
 * @param job - Original registered source, work identity and fixed deadline.
 * @returns Current readiness and independent expense acknowledgement.
 * @throws {Error} When ingest, unique usage persistence or acknowledgement fails.
 */
export async function runVideoPresentation(job: VideoPresentationJob): Promise<VideoPresentationExecutionResult> {
  const row = await findById(job.assetId);
  if (row === null || row.deletedAt !== null || row.kind !== 'video') return { status: 'gone', usageRecorded: false, usagePending: false };
  if (row.contentHash !== job.sourceFingerprint) return { status: 'stale', usageRecorded: false, usagePending: false };
  const identity = { storageKey: row.storageKey, sourceFingerprint: row.contentHash, jobId: job.jobId, deadlineAt: job.deadlineAt };
  const snapshot = await videoPresentationAtIngest(env.INGEST_BASE_URL, env.INGEST_SHARED_SECRET, {
    ...identity, action: job.deadlineAt <= Date.now() ? 'expire' : 'run',
  });
  if (snapshot.attempt?.jobId !== job.jobId) return { status: 'stale', usageRecorded: false, usagePending: false };
  const original = snapshot.presentation?.original;
  if (original !== undefined && row.width === null && row.height === null && row.durationSeconds === null) {
    await fillMediaNumbers(row.id, { width: original.width, height: original.height, durationSeconds: original.duration });
  }
  let usageRecorded = snapshot.attempt.usageRecorded === true;
  const fact = snapshot.usageFact;
  if (!usageRecorded && fact !== undefined) {
    if (fact.jobId !== job.jobId) throw new Error('Presentation usage differs from its original attempt');
    const recorder = createUsageRecorder({ operationKey: `video-presentation:${fact.jobId}`, feature: 'mini_tool', actorUserId: fact.actorUserId,
      projectId: fact.projectId, multiplier: 0, onMissingCost: () => { throw new Error('Presentation expense requires actual measured usage'); } });
    recorder.recordServiceCall({ source: 'container', service: 'video-presentation', provider: 'cloudflare', requests: 1,
      costUsd: containerCostUsd(fact.usage, fact.pricing.size, fact.pricing.prices), costSource: 'computed' });
    await recorder.settle();
    await videoPresentationAtIngest(env.INGEST_BASE_URL, env.INGEST_SHARED_SECRET, { ...identity, action: 'ack_usage' });
    usageRecorded = true;
  }
  const ready = snapshot.presentation?.state === 'native' || snapshot.presentation?.state === 'alpha_ready';
  return { status: ready ? 'ready' : 'failed', usageRecorded, usagePending: ready && !usageRecorded,
    ...(snapshot.attempt.error === undefined ? {} : { error: snapshot.attempt.error }) };
}
