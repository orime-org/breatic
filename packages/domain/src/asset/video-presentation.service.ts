// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash, randomUUID } from 'node:crypto';
import { budgetDeadlineFrom, ConflictError, NotFoundError, ValidationError, createQueue, defaultJobOpts, env, getMiniToolsConfig, getStorageAdapter, projectAuthService } from '@breatic/core';
import { t, videoPresentationAtIngest, videoPresentationAwaitsServer, videoPresentationResponseSchema,
  videoPresentationSourceBindingSchema,
  type StudioAssetEntity, type VideoPresentationOriginal, type VideoPresentationIngestPreparation, type VideoPresentationIngestRequest, type VideoPresentationPricing,
  type VideoPresentationIngestSnapshot, type VideoPresentationResponse, type VideoPresentationSourceBinding } from '@breatic/shared';
import { findById, findCoverOf, findLiveByStorageKey } from '@domain/asset/asset.repo.js';
import { videoEncoderRates } from '@domain/asset/video-encoder-rates.js';
import { select as selectPresentationPin, versionObjectKeys } from '@domain/presentation/presentation-pin.service.js';

/** An authorized read of a canonical registered video. */
export interface ResolveVideoPresentationInput { projectId: string; userId: string; canonicalURL: string }
/** An explicit repair retains the press identity across delivery retries. */
export interface RepairVideoPresentationInput extends ResolveVideoPresentationInput { sourceFingerprint: string; requestId: string }
/** An automatic registration or first-read metadata preparation. */
export interface EnsureVideoPresentationInput { assetId: string; parentDeadlineAt?: number; conditional?: boolean }
/** The queue retains the accepted source and job identity; the deadline lives in the DO admission record (design §5.1 step 1). */
export interface VideoPresentationJob { assetId: string; sourceFingerprint: string; jobId: string }
/** Internal admission context; explicit repairs retain their actual requester. */
interface AdmissionOptions { parentDeadlineAt?: number; repair?: boolean; requestId?: string; userId?: string; projectId?: string; expect?: 'first' | 'readmit' }
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
function originalOf(row: StudioAssetEntity): VideoPresentationOriginal | null {
  return Number.isSafeInteger(row.width) && Number.isSafeInteger(row.height) && row.width !== null && row.height !== null && row.width > 0 && row.height > 0 &&
    row.durationSeconds !== null && Number.isFinite(row.durationSeconds) && row.durationSeconds > 0 ? { width: row.width, height: row.height, duration: row.durationSeconds } : null;
}

/**
 * Queue the job ingest accepted while it still has work: a preparation in flight, or a finished one whose measured
 * usage, its own or a sub-job attempt's, is not yet recorded (§7.1.1).
 * @param row - The canonical registered winner, including dedup winners.
 * @param snapshot - Durable admission facts from its canonical-key owner.
 * @returns Nothing once queued.
 * @throws {Error} When the queue refuses durable work.
 */
async function enqueue(row: StudioAssetEntity, snapshot: VideoPresentationIngestSnapshot): Promise<void> {
  const preparation = snapshot.preparation;
  const usageOutstanding = snapshot.usageFact?.jobId === preparation?.jobId || snapshot.attemptUsageOutstanding === true;
  if (preparation === null || (preparation.failure !== null && !usageOutstanding)) return;
  queue ??= createQueue(VIDEO_PRESENTATION_QUEUE);
  const job: VideoPresentationJob = { assetId: row.id, sourceFingerprint: row.contentHash, jobId: preparation.jobId };
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
 * @throws {AggregateError} When queueing fails and failing the accepted candidate at ingest fails too.
 */
async function accept(row: StudioAssetEntity, options: AdmissionOptions): Promise<VideoPresentationIngestSnapshot> {
  const storage = await getStorageAdapter();
  const config = getMiniToolsConfig();
  const settings = config.presentation;
  const proposed = { jobId: presentationJobId(options.requestId), deadlineAt: options.parentDeadlineAt ?? budgetDeadlineFrom(Date.now()) };
  const request: VideoPresentationIngestRequest = {
    action: 'accept', storageKey: row.storageKey, sourceFingerprint: row.contentHash, ...proposed,
    original: originalOf(row), contentType: row.mimeType, repair: options.repair === true,
    ...(options.expect === undefined ? {} : { expect: options.expect }),
    registeredMetadata: { width: row.width, height: row.height, duration: row.durationSeconds },
    actorUserId: options.userId ?? row.producedByUserId, projectId: options.projectId ?? null,
    // One public base; ingest derives every object URL from it. publicUrl(key) is the base joined to the key.
    publicBaseURL: storage.publicUrl(row.storageKey).slice(0, -`/${row.storageKey}`.length),
    // The probe's output cap is presentation.probe_output_max_bytes (frames-split §8.2).
    limits: { ...config.plan_limits, probeStdoutBytes: settings.probe_output_max_bytes, maxSourceBytes: settings.max_source_bytes,
      maxPackedBytes: settings.max_packed_bytes, crf: settings.crf, preset: settings.preset },
    // Both container prices are frozen together (design §5.1 step 1): basic probes, standard-4 counts and encodes.
    pricing: { basic: priceOf(settings.container_class), standard4: priceOf(config.encoding.encoder.container_class) },
    targetPolicyVersion: settings.policy_version,
    // Ledger auto-repairs are gone with the ledger (frames-split §8.2): an invalid P is readmitted at most once (§3.5).
    policy: { chunkRetries: config.encoding.chunk_retries },
    // The rate table frozen at admission carries every decode key and edit tier (§5.4 estimate row).
    encoding: {
      chunkShare: config.encoding.chunk_share, maxParallelChunks: config.encoding.max_parallel_chunks,
      encoder: { ...videoEncoderRates(config), aacEncodeSecondsPerSecond: config.encoding.encoder.aac_encode_seconds_per_second },
      edit: { crf: settings.edit.crf, preset: settings.edit.preset, proresProfile: settings.edit.prores_profile, bytesPerPixel: settings.edit.bytes_per_pixel,
        maxEditBytes: settings.max_edit_bytes },
      carrier: { maxShortSide: settings.carrier.max_short_side, color: settings.carrier.color },
    },
    // The probe's sample count, the single-frame duration and the rate cap are frozen with the job (design §5.1 step 2, §4.1).
    probe: { sampleFrames: settings.probe_sample_frames, singleFrameDurationMs: settings.single_frame_duration_ms, maxFps: settings.max_fps },
  };
  const snapshot = await videoPresentationAtIngest(env.INGEST_BASE_URL, env.INGEST_SHARED_SECRET, request);
  try {
    await enqueue(row, snapshot);
  } catch (err) {
    // Only the queued job advances a candidate: one the queue refused would wait for it until D, so it fails now.
    if (snapshot.preparation?.jobId === proposed.jobId) {
      await videoPresentationAtIngest(env.INGEST_BASE_URL, env.INGEST_SHARED_SECRET, {
        action: 'fail', storageKey: row.storageKey, sourceFingerprint: row.contentHash, ...proposed, code: 'presentation_failed',
      }).catch((failure: unknown) => { throw new AggregateError([err, failure], 'The queue refused the accepted presentation job and failing it at ingest failed'); });
    }
    throw err;
  }
  return snapshot;
}

/**
 * The job id of one admission: a repair press keeps its id across delivery retries, digested so that no client string
 * reaches the queue's job id (BullMQ refuses most ids containing ':').
 * @param requestId - The press identity of an explicit repair.
 * @returns The job id.
 * @throws {never} Never.
 */
function presentationJobId(requestId: string | undefined): string {
  return `video-presentation-${requestId === undefined ? randomUUID() : createHash('sha256').update(requestId).digest('hex').slice(0, 32)}`;
}

/**
 * Mirror the snapshot in the public response (design §3.5 web→server row, §5.1 step 6): the registered binding, the
 * selected bundle and the target preparation, polling exactly while the user waits, and the video's cover.
 * @param row - The registered video.
 * @param binding - Current registry identity.
 * @param snapshot - Validated durable source facts.
 * @returns The public response.
 * @throws {Error} When ingest violates the public source or geometry contract.
 */
async function response(row: StudioAssetEntity, binding: VideoPresentationSourceBinding, snapshot: VideoPresentationIngestSnapshot): Promise<VideoPresentationResponse> {
  // The cover is read as material facts read it (`material-facts.ts`): the registered cover's own URL.
  const cover = await findCoverOf(row.id);
  return videoPresentationResponseSchema.parse({
    sourceBinding: binding, presentation: snapshot.presentation, preparation: snapshot.preparation,
    pollAfterMs: videoPresentationAwaitsServer(snapshot) ? getMiniToolsConfig().poll_interval_ms : null,
    coverURL: cover?.fileUrl ?? null,
  });
}

/**
 * Resolve project-authorized registry and presentation truth.
 * @param input - Current project member and selected canonical address.
 * @returns Registered identity with nullable trusted presentation.
 * @throws {NotFoundError} When project read access is absent.
 * @throws {ValidationError} When the URL has no live registered video.
 * @throws {Error} When ingest, queueing, its trusted response or the selected pin's persistence fails.
 */
export async function resolveVideoPresentation(input: ResolveVideoPresentationInput): Promise<VideoPresentationResponse> {
  await assertAccess(input);
  const { row, binding } = await registeredSource(input.canonicalURL);
  return followSelected(row, await response(row, binding, await readThenAdmit(row, {})));
}

/**
 * Redo Mv by versionId from a validated answer (frames-split §7.15): the discovery read is a write point of the selected
 * pin, so a selected row a stale worker sync left on another version follows P again. The same version changes nothing.
 * @param row - The registered source.
 * @param answered - The validated response.
 * @returns The response, once the selected pin follows its presentation.
 * @throws {Error} When persistence fails.
 */
async function followSelected(row: StudioAssetEntity, answered: VideoPresentationResponse): Promise<VideoPresentationResponse> {
  const selected = answered.presentation;
  if (selected !== null) {
    await selectPresentationPin({ canonicalKey: row.storageKey, toolInputId: selected.toolInputId, versionId: selected.versionId, objectKeys: versionObjectKeys(selected) });
  }
  return answered;
}

/**
 * Read the snapshot and admit only under a condition the DO re-checks (§3.5): nothing selected and nothing prepared, or
 * the DO's readmit fact; anything else, a failure included, is answered as it is.
 * @param row - The registered source.
 * @param options - Admission context for an admission the read allows.
 * @returns The snapshot after any admission.
 * @throws {Error} When ingest or queueing fails.
 */
async function readThenAdmit(row: StudioAssetEntity, options: AdmissionOptions): Promise<VideoPresentationIngestSnapshot> {
  const snapshot = await videoPresentationAtIngest(env.INGEST_BASE_URL, env.INGEST_SHARED_SECRET, {
    action: 'read', storageKey: row.storageKey, sourceFingerprint: row.contentHash, targetPolicyVersion: getMiniToolsConfig().presentation.policy_version,
  });
  if (snapshot.presentation === null && snapshot.preparation === null) return accept(row, { ...options, expect: 'first' });
  if (snapshot.presentation === null && snapshot.readmit) return accept(row, { ...options, expect: 'readmit' });
  await enqueue(row, snapshot);
  return snapshot;
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
  return followSelected(row, await response(row, binding, snapshot));
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
  // A dedup winner or a replayed terminal is not a new upload's initialization: it admits only as a discovery read would (§3.5).
  const { conditional, ...options } = input;
  return (await (conditional === true ? readThenAdmit(row, options) : accept(row, options))).preparation;
}
