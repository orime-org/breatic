// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The staged presentation job (inner#1306; frames-split design §5.1 steps 1, 2 and 2a, §5.4, §7.1, §7.1.1, §7.6).
 *
 * One durable job per presentation jobId, after `advance-plan-job.ts`: each pickup reads the DO once through `prepare`
 * (D comes only from its capability), settles the attempts the DO knows from their `/jobs` reports, and submits only the
 * next allowed stage or attempt, throwing StillRunning while work is in flight. Sub-jobs run on the frozen standard-4
 * class under §5.4 ids, their output key from the shared key function; each attempt's measured usage is recorded once
 * as a platform expense keyed by its full job id, then marked with `report_chunk Rec`. The DO assembles and publishes
 * the bundle; the worker only forwards the job DO's measured output receipts and syncs the presentation pins from each answer. At D the job fails `expired`.
 */

import { DelayedError, type Job } from 'bullmq';
import { env, getMiniToolsConfig, logger } from '@breatic/core';
import { assetRepo, containerCostUsd, createUsageRecorder, syncPresentationPins, type VideoPresentationJob } from '@breatic/domain';
import {
  prepareVideoPresentationAtIngest, readMiniToolPlanJob, stepVideoPresentationAtIngest, untilDeadline, videoPresentationAtIngest,
  videoPresentationWorkKeyFor, type MiniToolPlanJobReport, type MiniToolPlanJobRequest, type MiniToolPlanRecipe, type VideoPresentationChunkReport,
  type VideoPresentationChunkUnit, type VideoPresentationLedger, type VideoPresentationPrepareAnswer, type VideoPresentationPricing,
} from '@breatic/shared';
import { videoContainerJobId } from '@breatic/shared/mini-tools';
import { advanceMiniToolPlanJob, planReadUntil } from '@worker/handlers/mini-tool/advance-plan-job.js';
import { StillRunning } from '@worker/handlers/still-running.js';
import { audioOf, carrierTarget, chunkInputId, FullLedgerInvalid, readJobLedger, SOURCE_INPUT_ID, windowDuration, windowEntries } from '@worker/handlers/video-presentation-recipes.js';

/** Everything one pickup acts with. */
interface Pickup {
  identity: { storageKey: string; sourceFingerprint: string; jobId: string };
  capability: { storageKey: string; sourceFingerprint: string; jobId: string; deadlineAt: number; token: string };
  answer: VideoPresentationPrepareAnswer;
  frozen: NonNullable<VideoPresentationPrepareAnswer['frozen']>;
  /** The job's full ledger, read once per pickup when a recipe needs it. */
  ledger?: Promise<VideoPresentationLedger>;
}
type Unit = VideoPresentationPrepareAnswer['units'][string];

/**
 * The unit a DO unit key names.
 * @param jobId - The presentation job.
 * @param key - The unit key.
 * @returns The unit, or null for a key of another shape.
 * @throws {never} Never.
 */
function unitOf(jobId: string, key: string): VideoPresentationChunkUnit | null {
  const suffix = key.startsWith(`video-presentation:${jobId}:`) ? key.slice(`video-presentation:${jobId}:`.length) : null;
  if (suffix === 'stitch') return { kind: 'presentation-stitch' };
  if (suffix === 'copy') return { kind: 'presentation-copy' };
  const chunk = suffix?.match(/^chunk:(\d+)$/)?.[1];
  return chunk === undefined ? null : { kind: 'presentation-chunk', chunk: Number(chunk) };
}

/**
 * The DO unit key of a unit (§5.4 job id without the attempt).
 * @param jobId - The presentation job.
 * @param unit - The unit.
 * @returns The key.
 * @throws {never} Never.
 */
function unitKey(jobId: string, unit: VideoPresentationChunkUnit): string {
  return unit.kind === 'presentation-chunk' ? `video-presentation:${jobId}:chunk:${unit.chunk}` : `video-presentation:${jobId}:${unit.kind === 'presentation-stitch' ? 'stitch' : 'copy'}`;
}

/**
 * The §5.4 job id of one attempt.
 * @param jobId - The presentation job.
 * @param unit - The unit.
 * @param attempt - The attempt number.
 * @returns The container job id.
 * @throws {RangeError} When the identity is malformed.
 */
function attemptJobId(jobId: string, unit: VideoPresentationChunkUnit, attempt: number): string {
  return videoContainerJobId({ ...unit, jobId, attempt });
}

/**
 * The job's full ledger, read once per pickup: only the candidate's own ledger, keyed by the plan's toolInputId, once it is
 * ready; until then the pickup waits (E2-6). The selected version's ledger is never a stand-in: with the same toolInputId it
 * is the same ledger, with another it is another plan's. A ready ledger that fails its receipt is the DO's to check and
 * repair (§91 D3b-9; design §7.4 `Check`, §7.1 `Lt`): the pickup logs it, asks the DO to read, which runs Check against R2,
 * and waits for the repaired receipt.
 * @param pickup - The pickup.
 * @returns The validated full ledger.
 * @throws {StillRunning} While the candidate's ledger is not ready, or after it failed its receipt and the DO was asked to check it.
 * @throws {Error} When the read fails in transport.
 */
function ledgerOf(pickup: Pickup): Promise<VideoPresentationLedger> {
  const { answer, capability, identity } = pickup;
  const candidate = answer.candidateLedger;
  // Wait for the candidate's own ledger: no read, no check request and no log until it is ready.
  if (candidate?.state !== 'ready') return Promise.reject(new StillRunning(Date.now() + getMiniToolsConfig().poll_interval_ms));
  const receipt = candidate.receipt;
  pickup.ledger ??= readJobLedger(receipt, planReadUntil(capability.deadlineAt)).catch(async (error: unknown) => {
    if (!(error instanceof FullLedgerInvalid)) throw error;
    logger.error({ err: error, ctx: { ...identity, toolInputId: answer.plan?.toolInputId, receiptSha256: receipt.sha256 } }, 'video_presentation_ledger_invalid');
    const policy = answer.preparation?.targetPolicyVersion;
    if (policy !== undefined) {
      await videoPresentationAtIngest(env.INGEST_BASE_URL, env.INGEST_SHARED_SECRET, { action: 'read', storageKey: identity.storageKey, sourceFingerprint: identity.sourceFingerprint, targetPolicyVersion: policy });
    }
    throw new StillRunning(Date.now() + getMiniToolsConfig().poll_interval_ms);
  });
  return pickup.ledger;
}

/**
 * The complete standard-4 request of one attempt: the frozen class and D, the attempt's own output key, and its recipe
 * built from the full ledger (§7.17, §91 D3b): the source as input, and for a stitch each done chunk bound beside it.
 * @param pickup - The pickup.
 * @param unit - The unit.
 * @param jobId - The attempt's job id.
 * @returns The request, or null when the recipe cannot be formed from the DO's answer.
 * @throws {Error} When the full ledger cannot be read or is not the planned one.
 */
async function requestFor(pickup: Pickup, unit: VideoPresentationChunkUnit, jobId: string): Promise<MiniToolPlanJobRequest | null> {
  const { answer, identity, capability, frozen } = pickup;
  const windows = answer.work.kind === 'encode' ? answer.work.chunks : [];
  const inputs = [{ inputId: SOURCE_INPUT_ID, storageKey: identity.storageKey }];
  let recipe: MiniToolPlanRecipe;
  if (unit.kind === 'presentation-copy') {
    // The audio choice is the DO's, from the probe's audioCopyable (§7.17 copy_carrier row); encoding uses the stitch's entries.
    const ledger = await ledgerOf(pickup);
    const choice = answer.copyAudio;
    if (choice === undefined) return null;
    recipe = { kind: 'copy_carrier', inputId: SOURCE_INPUT_ID, colorMatrix: ledger.plan.colorMatrix, origin: ledger.plan.originMapping.origin,
      audio: choice === null ? null : choice === 'copy' ? { kind: 'copy' } : { kind: 'encode', ...audioOf(ledger) } };
  }
  else if (unit.kind === 'presentation-chunk') {
    const window = windows[unit.chunk];
    if (window === undefined) return null;
    const ledger = await ledgerOf(pickup);
    recipe = { kind: 'chunk_encode', inputId: SOURCE_INPUT_ID, window: { start: window.start, end: window.end }, timescale: ledger.plan.presentation.timescale,
      entries: windowEntries(ledger, window), target: carrierTarget(ledger, frozen.carrier) };
  } else {
    const chunks = windows.map((_window, chunk) => doneOutput(pickup, { kind: 'presentation-chunk', chunk }));
    if (chunks.length === 0 || chunks.some((key) => key === null)) return null;
    const ledger = await ledgerOf(pickup);
    inputs.push(...chunks.map((key, chunk) => ({ inputId: chunkInputId(chunk), storageKey: key! })));
    recipe = { kind: 'stitch', inputId: SOURCE_INPUT_ID, chunks: windows.map((window, chunk) => ({ inputId: chunkInputId(chunk), duration: windowDuration(ledger, window) })),
      audio: audioOf(ledger), target: carrierTarget(ledger, frozen.carrier) };
  }
  return {
    schemaVersion: 2, jobId, containerClass: frozen.pricing.standard4.containerClass, deadlineAt: capability.deadlineAt, limits: getMiniToolsConfig().plan_limits,
    inputs, outputs: [{ outputIndex: 0, storageKey: videoPresentationWorkKeyFor(identity.storageKey, jobId), contentType: 'video/mp4', recipe }],
  };
}

/**
 * The output key of a unit's done attempt.
 * @param pickup - The pickup.
 * @param unit - The unit.
 * @returns The key, or null while the unit is not done.
 * @throws {never} Never.
 */
function doneOutput(pickup: Pickup, unit: VideoPresentationChunkUnit): string | null {
  const done = pickup.answer.units[unitKey(pickup.identity.jobId, unit)]?.attempts.find((attempt) => attempt.state === 'done');
  return done === undefined ? null : videoPresentationWorkKeyFor(pickup.identity.storageKey, done.jobId);
}

/**
 * Record one measured container usage as a platform expense (multiplier 0) under its operation key.
 * @param pickup - The pickup.
 * @param operationKey - The full job id, or `video-presentation:<jobId>` for the basic execution.
 * @param usage - The measured usage.
 * @param usage.wallMs - Wall time in milliseconds.
 * @param usage.cpuUsec - CPU time in microseconds.
 * @param pricing - The frozen price of the class it ran on.
 * @returns Nothing once settled.
 * @throws {Error} When persistence fails.
 */
async function recordUsage(pickup: Pickup, operationKey: string, usage: { wallMs: number; cpuUsec: number | null }, pricing: VideoPresentationPricing): Promise<void> {
  const recorder = createUsageRecorder({ operationKey, feature: 'mini_tool', actorUserId: pickup.frozen.actorUserId, projectId: pickup.frozen.projectId,
    multiplier: 0, onMissingCost: () => { throw new Error('Presentation expense requires actual measured usage'); } });
  recorder.recordServiceCall({ source: 'container', service: 'video-presentation', provider: 'cloudflare', requests: 1,
    costUsd: containerCostUsd(usage, pricing.size, pricing.prices), costSource: 'computed' });
  await recorder.settle();
}

/**
 * Send one unit report.
 * @param pickup - The pickup.
 * @param unit - The unit.
 * @param report - The report.
 * @returns Whether the DO accepted it.
 * @throws {Error} When ingest refuses.
 */
function reportUnit(pickup: Pickup, unit: VideoPresentationChunkUnit, report: VideoPresentationChunkReport): Promise<boolean> {
  return stepVideoPresentationAtIngest(env.INGEST_BASE_URL, env.INGEST_SHARED_SECRET, { action: 'report_chunk', ...pickup.capability, unit, report });
}

/**
 * Advance the candidate to a stage.
 * @param pickup - The pickup.
 * @param stage - The stage.
 * @returns Whether the DO accepted it.
 * @throws {Error} When ingest refuses.
 */
function advanceStage(pickup: Pickup, stage: 'dispatch_copy' | 'encode' | 'stitch' | 'publish'): Promise<boolean> {
  return stepVideoPresentationAtIngest(env.INGEST_BASE_URL, env.INGEST_SHARED_SECRET, { action: 'advance_stage', ...pickup.capability, stage });
}

/**
 * Settle one unit: report the latest attempt's result and record every measured attempt usage not yet recorded.
 * @param pickup - The pickup.
 * @param unit - The unit.
 * @param state - The DO's unit state.
 * @returns Whether this pickup must come back for it.
 * @throws {Error} When ingest, the job report or usage persistence fails.
 */
async function settleUnit(pickup: Pickup, unit: VideoPresentationChunkUnit, state: Unit): Promise<boolean> {
  let again = false;
  for (const attempt of state.attempts) {
    const latestPending = attempt.state === 'pending' && attempt.attempt === state.attempt && state.state === 'open';
    if (!latestPending && attempt.usageRecorded) continue;
    const request = await requestFor(pickup, unit, attempt.jobId);
    if (request === null) { again = true; continue; }
    let report: MiniToolPlanJobReport | null;
    if (latestPending) {
      try { report = await advanceMiniToolPlanJob(request); } catch (error) {
        if (!(error instanceof StillRunning)) throw error;
        again = true;
        continue;
      }
      if (report.state === 'done') {
        const output = report.outputs[0];
        // The one carrier the job wrote: alpha-packed with the geometry the container reported, else native; the DO writes the manifest (§91 D3-3).
        const carrier = output === undefined ? undefined : { role: 'carrier' as const, storageKey: output.storageKey, sha256: output.sha256, sizeBytes: output.sizeBytes, contentType: output.contentType,
          ...(output.packing === undefined ? { packing: 'native' as const } : { packing: 'alpha-packed' as const, geometry: output.packing }) };
        const receipt = unit.kind !== 'presentation-chunk' && carrier !== undefined ? { receipts: [carrier] } : {};
        await reportUnit(pickup, unit, { kind: 'Done', attempt: attempt.attempt, usage: report.usage.wallMs, ...receipt });
      } else {
        await reportUnit(pickup, unit, { kind: 'Fail', attempt: attempt.attempt, code: report.reason, usage: report.usage?.wallMs ?? null });
      }
      again = true;
    } else {
      report = await readMiniToolPlanJob(env.INGEST_BASE_URL, env.INGEST_SHARED_SECRET, request, untilDeadline(planReadUntil(pickup.capability.deadlineAt)));
    }
    const usage = report !== null && (report.state === 'done' || report.state === 'failed') ? report.usage : undefined;
    // An unfinished attempt holds the job (§7.1.1 `Rec`). An ended one with no usage had a container that never
    // started or vanished unmeasured; there is nothing to record and nothing to wait for.
    if (usage === undefined) { again = true; continue; }
    if (usage === null) continue;
    await recordUsage(pickup, attempt.jobId, usage, pickup.frozen.pricing.standard4);
    await reportUnit(pickup, unit, { kind: 'Rec', attempt: attempt.attempt });
  }
  return again;
}

/**
 * Open a unit's first attempt (Sub) and submit it.
 * @param pickup - The pickup.
 * @param unit - The unit.
 * @returns Nothing once submitted.
 * @throws {Error} When ingest or the job submission fails permanently.
 */
async function dispatch(pickup: Pickup, unit: VideoPresentationChunkUnit): Promise<void> {
  if (!await reportUnit(pickup, unit, { kind: 'Sub' })) return;
  const request = await requestFor(pickup, unit, attemptJobId(pickup.identity.jobId, unit, 1));
  if (request === null) return;
  try { await advanceMiniToolPlanJob(request); } catch (error) { if (!(error instanceof StillRunning)) throw error; }
}

/**
 * Take the next allowed step of the route: dispatch the copy, the chunks or the stitch, or advance to publish.
 * @param pickup - The pickup.
 * @returns Whether this pickup must come back.
 * @throws {Error} When ingest or a job submission fails.
 */
async function nextStep(pickup: Pickup): Promise<boolean> {
  const { answer, identity } = pickup;
  const plan = answer.plan;
  const stage = answer.preparation?.stage ?? null;
  if (plan === null || answer.work.kind === 'none') return false;
  // Sub-jobs read the full ledger; nothing is dispatched until the candidate's own ledger is ready (E2-6) and has been read
  // against its receipt (§91 D3b-9), before any stage moves.
  if (answer.candidateLedger?.state !== 'ready') return true;
  await ledgerOf(pickup);
  /**
   * The DO's state of one unit of this job.
   * @param unit - The unit.
   * @returns Its state, or undefined before its first attempt.
   * @throws {never} Never.
   */
  const unitState = (unit: VideoPresentationChunkUnit): Unit | undefined => answer.units[unitKey(identity.jobId, unit)];
  const last: VideoPresentationChunkUnit = answer.work.kind === 'dispatch_copy' ? { kind: 'presentation-copy' } : { kind: 'presentation-stitch' };
  if (stage === 'plan') {
    if (!await advanceStage(pickup, answer.work.kind)) return true;
    if (answer.work.kind === 'dispatch_copy') await dispatch(pickup, last);
    else for (const [chunk] of answer.work.chunks.entries()) await dispatch(pickup, { kind: 'presentation-chunk', chunk });
    return true;
  }
  if (stage === 'encode' && answer.work.kind === 'encode') {
    const chunks = answer.work.chunks.map((_window, chunk) => ({ kind: 'presentation-chunk' as const, chunk }));
    const missing = chunks.filter((unit) => unitState(unit) === undefined);
    for (const unit of missing) await dispatch(pickup, unit);
    if (missing.length > 0) return true;
    // Every chunk exists and none is open (settleUnit came back for those): the DO refuses stitch until all are done.
    if (await advanceStage(pickup, 'stitch')) await dispatch(pickup, last);
    return true;
  }
  if (stage === 'dispatch_copy' || stage === 'stitch') {
    const state = unitState(last);
    if (state === undefined) { await dispatch(pickup, last); return true; }
    if (state.state !== 'done') return false;
    if (!await advanceStage(pickup, 'publish')) logger.warn({ ctx: { ...identity, stage } }, 'video_presentation_publish_refused');
  }
  return false;
}

/**
 * One pickup of a staged presentation job.
 * @param data - The queued job identity; the deadline comes from the DO.
 * @returns Nothing when the job is over.
 * @throws {StillRunning} While work is in flight or usage is unmeasured.
 * @throws {Error} When ingest, a job submission or usage persistence fails.
 */
export async function advanceVideoPresentation(data: VideoPresentationJob): Promise<void> {
  const row = await assetRepo.findById(data.assetId);
  if (row === null || row.deletedAt !== null || row.kind !== 'video' || row.contentHash !== data.sourceFingerprint) return;
  const identity = { storageKey: row.storageKey, sourceFingerprint: row.contentHash, jobId: data.jobId };
  const answer = await prepareVideoPresentationAtIngest(env.INGEST_BASE_URL, env.INGEST_SHARED_SECRET, { action: 'prepare', ...identity });
  // Candidate and selected pins follow what the DO answered, before anything this pickup sends (§7.15 single writer).
  await syncPresentationPins(data.jobId, answer);
  if (answer.capability === null || answer.frozen === null) return;
  const capability = { ...identity, deadlineAt: answer.capability.deadlineAt, token: answer.capability.token };
  const pickup: Pickup = { identity, capability, answer, frozen: answer.frozen };
  const fact = answer.usageFact;
  if (fact !== undefined && fact.jobId === data.jobId) {
    await recordUsage(pickup, `video-presentation:${data.jobId}`, fact.usage, fact.pricing);
    await videoPresentationAtIngest(env.INGEST_BASE_URL, env.INGEST_SHARED_SECRET, { action: 'ack_usage', ...identity, deadlineAt: capability.deadlineAt });
  }
  const current = answer.preparation?.jobId === data.jobId;
  const failed = !current || answer.preparation?.failure !== null;
  if (!failed && Date.now() >= capability.deadlineAt) {
    await videoPresentationAtIngest(env.INGEST_BASE_URL, env.INGEST_SHARED_SECRET, { action: 'fail', ...identity, deadlineAt: capability.deadlineAt, code: 'expired' });
    return;
  }
  let again = false;
  for (const [key, state] of Object.entries(answer.units)) {
    const unit = unitOf(data.jobId, key);
    if (unit !== null && await settleUnit(pickup, unit, state)) again = true;
  }
  if (!again && !failed) again = await nextStep(pickup);
  if (again) throw new StillRunning(Date.now() + getMiniToolsConfig().poll_interval_ms);
}

/**
 * Run one pickup without opening a billed user task; StillRunning moves the job back to the delayed queue.
 * @param job - The queued presentation job.
 * @param token - The worker lock token.
 * @returns Nothing once the job is over.
 * @throws {DelayedError} When the job was moved back to wait.
 * @throws {Error} When infrastructure or usage persistence needs a queue retry.
 */
export async function runVideoPresentation(job: Job<VideoPresentationJob>, token?: string): Promise<void> {
  try {
    await advanceVideoPresentation(job.data);
  } catch (err) {
    if (err instanceof StillRunning && token !== undefined) {
      await job.moveToDelayed(err.resumeAt, token);
      throw new DelayedError();
    }
    logger.error({ err, ctx: job.data }, 'video_presentation_attempt_failed');
    throw err;
  }
}
