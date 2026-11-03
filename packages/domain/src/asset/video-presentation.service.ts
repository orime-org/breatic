// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { randomUUID } from 'node:crypto';
import { budgetDeadlineFrom, ConflictError, NotFoundError, ValidationError, createQueue, defaultJobOpts, env, getMiniToolsConfig, getStorageAdapter, projectAuthService } from '@breatic/core';
import { alphaManifestKeyFor, alphaPackedKeyFor, t, videoPresentationAtIngest, videoPresentationAwaitsServer, videoPresentationResponseSchema,
  videoPresentationSourceBindingSchema, videoSourceLedgerKeyFor, videoSourceLedgerTableKeyFor, type VideoPresentationTableReadLimits,
  type StudioAssetEntity, type VideoPresentation, type VideoPresentationIngestPreparation, type VideoPresentationIngestRequest, type VideoPresentationPricing,
  type VideoPresentationIngestSnapshot, type VideoPresentationResponse, type VideoPresentationSourceBinding } from '@breatic/shared';
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
/**
 * The queue retains the accepted source identity. The deadline is known only when this admission's own job was accepted;
 * a job found by a read leaves it out (design §5.1 step 1: the deadline lives in the DO admission record).
 */
export interface VideoPresentationJob { assetId: string; sourceFingerprint: string; jobId: string; deadlineAt?: number }
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
 * Queue the job ingest accepted while it still has work: a preparation in flight, or a finished one whose measured
 * usage is not yet recorded.
 * @param row - The canonical registered winner, including dedup winners.
 * @param snapshot - Durable admission facts from its canonical-key owner.
 * @param proposed - The job this admission proposed and its deadline, when it admitted one.
 * @returns Nothing once queued.
 * @throws {Error} When the queue refuses durable work.
 */
async function enqueue(row: StudioAssetEntity, snapshot: VideoPresentationIngestSnapshot, proposed: { jobId: string; deadlineAt: number } | null): Promise<void> {
  const preparation = snapshot.preparation;
  if (preparation === null || (preparation.failure !== null && snapshot.usageFact?.jobId !== preparation.jobId)) return;
  queue ??= createQueue(VIDEO_PRESENTATION_QUEUE);
  const job: VideoPresentationJob = { assetId: row.id, sourceFingerprint: row.contentHash, jobId: preparation.jobId,
    ...(proposed?.jobId === preparation.jobId ? { deadlineAt: proposed.deadlineAt } : {}) };
  await queue.add('prepare', job, { ...defaultJobOpts(), jobId: preparation.jobId });
}

/**
 * The frozen price of one configured container class.
 * @param containerClass - The class name.
 * @returns Its size and prices.
 * @throws {Error} When the class is not configured.
 */
function priceOf(containerClass: string): VideoPresentationPricing {
  const config = getMiniToolsConfig();
  const size = config.classes[containerClass];
  if (size === undefined) throw new Error(`Container class ${containerClass} is not configured`);
  return { containerClass, size: { vcpu: size.vcpu, memory_gib: size.memory_gib, disk_gb: size.disk_gb }, prices: { ...config.prices } };
}

/**
 * Accept source-scoped platform work without resetting a current job (the one admission entry, repairs included).
 * @param row - Actual registered source, never a derivative.
 * @param options - Any parent deadline and explicit repair attribution.
 * @returns The snapshot after admission.
 * @throws {Error} When ingest admission or queueing fails.
 */
async function accept(row: StudioAssetEntity, options: AdmissionOptions): Promise<VideoPresentationIngestSnapshot> {
  const storage = await getStorageAdapter();
  const config = getMiniToolsConfig();
  const settings = config.presentation;
  const ledger = settings.source_ledger;
  const proposed = { jobId: `video-presentation-${options.requestId ?? randomUUID()}`, deadlineAt: options.parentDeadlineAt ?? budgetDeadlineFrom(Date.now()) };
  const request: VideoPresentationIngestRequest = {
    action: 'accept', storageKey: row.storageKey, sourceFingerprint: row.contentHash, ...proposed,
    original: originalOf(row), contentType: row.mimeType, knownAlpha: options.knownAlpha === true, repair: options.repair === true,
    registeredMetadata: { width: row.width, height: row.height, duration: row.durationSeconds },
    actorUserId: options.userId ?? row.producedByUserId, projectId: options.projectId ?? null,
    packedURL: storage.publicUrl(alphaPackedKeyFor(row.storageKey)), manifestURL: storage.publicUrl(alphaManifestKeyFor(row.storageKey)),
    // Every admission requests the ledger; the ingest store decides whether this source still needs one produced.
    sourceLedgerURL: storage.publicUrl(videoSourceLedgerKeyFor(row.storageKey)), sourceLedgerTableURL: storage.publicUrl(videoSourceLedgerTableKeyFor(row.storageKey)),
    limits: { ...config.plan_limits, maxSourceBytes: settings.max_source_bytes, maxPackedBytes: settings.max_packed_bytes, crf: settings.crf, preset: settings.preset,
      sourceLedger: { maxBytes: ledger.max_bytes, probeStdoutBytes: ledger.probe_stdout_bytes, metadataBytes: ledger.metadata_bytes,
        isoBoxCount: ledger.iso_box_count, matroskaElementCount: ledger.matroska_element_count, matroskaMaxBlocks: ledger.matroska_max_blocks } },
    // Both container prices are frozen together (design §5.1 step 1): basic probes and copies, standard-4 encodes.
    pricing: { basic: priceOf(settings.container_class), standard4: priceOf(config.encoding.encoder.container_class) },
    targetPolicyVersion: settings.policy_version,
    policy: { chunkRetries: config.encoding.chunk_retries, maxAutoRepairs: ledger.max_auto_repairs },
  };
  const snapshot = await videoPresentationAtIngest(env.INGEST_BASE_URL, env.INGEST_SHARED_SECRET, request);
  await enqueue(row, snapshot, proposed);
  return snapshot;
}

/**
 * The current read policy for a stored source frame table.
 * @returns The configured compact-table byte budget.
 * @throws {Error} When configuration cannot be read.
 */
function sourceLedgerReadLimits(): VideoPresentationTableReadLimits {
  return { maxBytes: getMiniToolsConfig().presentation.source_ledger.max_bytes };
}

/**
 * Mirror the snapshot in the public response (design §3.5 web→server row, §5.1 step 6): the registered binding, the
 * selected bundle, the target preparation and the selected version's ledger, polling exactly while the reader waits.
 * @param binding - Current registry identity.
 * @param snapshot - Validated durable source facts.
 * @returns The public response.
 * @throws {Error} When ingest violates the public source or geometry contract.
 */
function response(binding: VideoPresentationSourceBinding, snapshot: VideoPresentationIngestSnapshot): VideoPresentationResponse {
  return videoPresentationResponseSchema.parse({
    sourceBinding: binding, presentation: snapshot.presentation, preparation: snapshot.preparation, ledger: snapshot.ledger,
    pollAfterMs: videoPresentationAwaitsServer(snapshot) ? getMiniToolsConfig().poll_interval_ms : null,
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
    action: 'read', storageKey: row.storageKey, sourceFingerprint: row.contentHash, targetPolicyVersion: getMiniToolsConfig().presentation.policy_version,
  });
  // A source with nothing selected and no target work is admitted once; anything else, a failure included, is answered as it is.
  if (snapshot.presentation === null && snapshot.preparation === null) snapshot = await accept(row, {});
  else await enqueue(row, snapshot, null);
  return response(binding, snapshot);
}

/**
 * Repair an unchanged registered source under read permission.
 * @param input - Member, canonical identity and idempotent press identity.
 * @returns The same response as a read, naming the accepted job in its preparation.
 * @throws {NotFoundError} When project read access is absent.
 * @throws {VideoPresentationSourceChanged} When the client fingerprint is stale.
 * @throws {Error} When registration, admission or queueing fails.
 */
export async function repairVideoPresentation(input: RepairVideoPresentationInput): Promise<VideoPresentationResponse> {
  await assertAccess(input);
  const { row, binding } = await registeredSource(input.canonicalURL);
  if (binding.contentHash !== input.sourceFingerprint) throw new VideoPresentationSourceChanged(binding);
  const snapshot = await accept(row, { repair: true, requestId: input.requestId, userId: input.userId, projectId: input.projectId });
  return response(binding, snapshot);
}

/**
 * Arrange platform-funded presentation work after registration.
 * @param input - Registered winner and any parent run's original deadline.
 * @returns The target preparation after admission, or none for a gone or non-video asset.
 * @throws {Error} When durable admission or queueing fails.
 */
export async function ensureVideoPresentation(input: EnsureVideoPresentationInput): Promise<VideoPresentationIngestPreparation | null> {
  const row = await findById(input.assetId);
  if (row === null || row.deletedAt !== null || row.kind !== 'video') return null;
  return (await accept(row, input)).preparation;
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
  // ponytail: a job queued from a read has no deadline; the staged worker (E2) takes it from the DO's prepare answer.
  if (job.deadlineAt === undefined) return { status: 'stale', usageRecorded: false, usagePending: false };
  const identity = { storageKey: row.storageKey, sourceFingerprint: row.contentHash, jobId: job.jobId, deadlineAt: job.deadlineAt };
  const snapshot = await videoPresentationAtIngest(env.INGEST_BASE_URL, env.INGEST_SHARED_SECRET, {
    ...identity, action: job.deadlineAt <= Date.now() ? 'expire' : 'run',
  });
  if (snapshot.preparation?.jobId !== job.jobId) return { status: 'stale', usageRecorded: false, usagePending: false };
  const original = snapshot.presentation?.original;
  if (original !== undefined && row.width === null && row.height === null && row.durationSeconds === null) {
    await fillMediaNumbers(row.id, { width: original.width, height: original.height, durationSeconds: original.duration });
  }
  // The snapshot carries the job's usage fact only while it is unacknowledged.
  const fact = snapshot.usageFact;
  if (fact !== undefined) {
    if (fact.jobId !== job.jobId) throw new Error('Presentation usage differs from its original job');
    const recorder = createUsageRecorder({ operationKey: `video-presentation:${fact.jobId}`, feature: 'mini_tool', actorUserId: fact.actorUserId,
      projectId: fact.projectId, multiplier: 0, onMissingCost: () => { throw new Error('Presentation expense requires actual measured usage'); } });
    recorder.recordServiceCall({ source: 'container', service: 'video-presentation', provider: 'cloudflare', requests: 1,
      costUsd: containerCostUsd(fact.usage, fact.pricing.size, fact.pricing.prices), costSource: 'computed' });
    await recorder.settle();
    await videoPresentationAtIngest(env.INGEST_BASE_URL, env.INGEST_SHARED_SECRET, { ...identity, action: 'ack_usage' });
  }
  const failure = snapshot.preparation.failure;
  return { status: snapshot.presentation !== null && failure === null ? 'ready' : 'failed', usageRecorded: true, usagePending: false,
    ...(failure === null ? {} : { error: failure }) };
}
