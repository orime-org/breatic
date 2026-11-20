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
  videoPresentationWorkKeyFor, type MiniToolPlanJobReport, type MiniToolPlanJobRequest, type VideoPresentationChunkReport,
  type VideoPresentationChunkUnit, type VideoPresentationPrepareAnswer, type VideoPresentationPricing,
} from '@breatic/shared';
import { videoContainerJobId } from '@breatic/shared/mini-tools';
import { advanceMiniToolPlanJob, planReadUntil } from '@worker/handlers/mini-tool/advance-plan-job.js';
import { StillRunning } from '@worker/handlers/still-running.js';
import { gridCountOf, presentationRecipeOf, PresentationFactsUnavailable } from '@worker/handlers/frozen-plan-facts.js';
import { chunkInputId } from '@worker/handlers/video-presentation-recipes.js';

/** Everything one pickup acts with. */
interface Pickup {
  identity: { storageKey: string; sourceFingerprint: string; jobId: string };
  capability: { storageKey: string; sourceFingerprint: string; jobId: string; deadlineAt: number; token: string };
  answer: VideoPresentationPrepareAnswer;
  frozen: NonNullable<VideoPresentationPrepareAnswer['frozen']>;
}
type Unit = VideoPresentationPrepareAnswer['units'][string];
/** A stage of a presentation route. */
type Stage = NonNullable<VideoPresentationPrepareAnswer['plan']>['stages'][number];
/** The unit key suffix of each single unit. */
const SINGLE: Record<string, VideoPresentationChunkUnit> = {
  count: { kind: 'presentation-count' }, stitch: { kind: 'presentation-stitch' }, 'edit-stitch': { kind: 'presentation-edit-stitch' },
};

/**
 * The unit a DO unit key names.
 * @param jobId - The presentation job.
 * @param key - The unit key.
 * @returns The unit, or null for a key of another shape.
 * @throws {never} Never.
 */
function unitOf(jobId: string, key: string): VideoPresentationChunkUnit | null {
  const suffix = key.startsWith(`video-presentation:${jobId}:`) ? key.slice(`video-presentation:${jobId}:`.length) : null;
  if (suffix === null) return null;
  const single = SINGLE[suffix];
  if (single !== undefined) return single;
  const chunk = suffix.match(/^(chunk|edit):(\d+)$/);
  if (chunk === null) return null;
  return { kind: chunk[1] === 'edit' ? 'presentation-edit' : 'presentation-chunk', chunk: Number(chunk[2]) };
}

/**
 * The DO unit key of a unit (§5.4 job id without the attempt).
 * @param jobId - The presentation job.
 * @param unit - The unit.
 * @returns The key.
 * @throws {never} Never.
 */
function unitKey(jobId: string, unit: VideoPresentationChunkUnit): string {
  switch (unit.kind) {
    case 'presentation-count': return `video-presentation:${jobId}:count`;
    case 'presentation-chunk': return `video-presentation:${jobId}:chunk:${unit.chunk}`;
    case 'presentation-stitch': return `video-presentation:${jobId}:stitch`;
    case 'presentation-edit': return `video-presentation:${jobId}:edit:${unit.chunk}`;
    case 'presentation-edit-stitch': return `video-presentation:${jobId}:edit-stitch`;
  }
}

/**
 * The units a stage runs (§7.1.1, the DO's stage units): the count, the edit chunks, the edit stitch, the playback chunks
 * or the stitch; none for plan and publish.
 * @param stage - The stage.
 * @param work - The answer's work.
 * @returns The units.
 * @throws {never} Never.
 */
function stageUnits(stage: Stage, work: VideoPresentationPrepareAnswer['work']): VideoPresentationChunkUnit[] {
  switch (stage) {
    case 'count': return [{ kind: 'presentation-count' }];
    case 'edit': return work.kind === 'edit' ? work.editChunks.map((_window, chunk) => ({ kind: 'presentation-edit' as const, chunk })) : [];
    case 'edit_stitch': return [{ kind: 'presentation-edit-stitch' }];
    case 'encode': return work.kind === 'none' ? [] : work.chunks.map((_window, chunk) => ({ kind: 'presentation-chunk' as const, chunk }));
    case 'stitch': return [{ kind: 'presentation-stitch' }];
    default: return [];
  }
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
 * The kind of chunk a stitch unit joins: the playback chunks for the stitch, the edit chunks for the edit stitch.
 * @param unit - The unit.
 * @returns The chunk kind, or null for a unit that joins none.
 * @throws {never} Never.
 */
function joined(unit: VideoPresentationChunkUnit): VideoPresentationChunkUnit['kind'] | null {
  return unit.kind === 'presentation-stitch' ? 'presentation-chunk' : unit.kind === 'presentation-edit-stitch' ? 'presentation-edit' : null;
}

/**
 * The complete standard-4 request of one attempt: the frozen class and D, the attempt's own output key, and its recipe
 * on the candidate's grid (§7.17): its source inputs, and for a stitch each done chunk bound under its chunk id. A grid
 * count names its recipe as the request's count and declares no output.
 * @param pickup - The pickup.
 * @param unit - The unit.
 * @param jobId - The attempt's job id.
 * @returns The request, or null while a stitch's chunks are not all done.
 * @throws {PresentationFactsUnavailable} When the answer does not carry the plan's facts for the recipe.
 */
function requestFor(pickup: Pickup, unit: VideoPresentationChunkUnit, jobId: string): MiniToolPlanJobRequest | null {
  const { answer, identity, capability, frozen } = pickup;
  const chunkKind = joined(unit);
  const chunks = chunkKind === null ? [] : stageUnits(chunkKind === 'presentation-edit' ? 'edit' : 'encode', answer.work).map((chunk) => doneOutput(pickup, chunk));
  if (chunkKind !== null && (chunks.length === 0 || chunks.some((key) => key === null))) return null;
  const { recipe, inputs, contentType } = presentationRecipeOf(answer, unit, identity.storageKey);
  const request = {
    schemaVersion: 2 as const, jobId, containerClass: frozen.pricing.standard4.containerClass, deadlineAt: capability.deadlineAt, limits: getMiniToolsConfig().plan_limits,
    inputs: [...inputs, ...chunks.map((key, chunk) => ({ inputId: chunkInputId(chunk), storageKey: key! }))],
  };
  // A grid count declares no output and writes no object; its job report carries the count (§7.17 grid_count).
  if (recipe.kind === 'grid_count') return { ...request, outputs: [], count: recipe };
  if (contentType === null) throw new PresentationFactsUnavailable(`${unit.kind}:content_type`);
  return { ...request, outputs: [{ outputIndex: 0, storageKey: videoPresentationWorkKeyFor(identity.storageKey, jobId), contentType, recipe }] };
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
function advanceStage(pickup: Pickup, stage: Stage): Promise<boolean> {
  return stepVideoPresentationAtIngest(env.INGEST_BASE_URL, env.INGEST_SHARED_SECRET, { action: 'advance_stage', ...pickup.capability, stage });
}

/**
 * What a unit's Done report carries (§7.1.1): a stitch the carrier it wrote (alpha-packed with the geometry the container
 * reported, else native; the DO writes the manifest, §91 D3-3), an edit stitch the edit file, the count its measurement,
 * and a chunk nothing.
 * @param unit - The unit.
 * @param request - The attempt's request, whose edit stitch recipe names the edit tier.
 * @param report - The done job report.
 * @returns The receipts or the count.
 * @throws {PresentationFactsUnavailable} When the count's measurement is not in the report.
 */
function doneFacts(unit: VideoPresentationChunkUnit, request: MiniToolPlanJobRequest, report: Extract<MiniToolPlanJobReport, { state: 'done' }>): Pick<Extract<VideoPresentationChunkReport, { kind: 'Done' }>, 'receipts' | 'count'> {
  if (unit.kind === 'presentation-count') return { count: gridCountOf(report) };
  const output = report.outputs[0];
  if (output === undefined || (unit.kind !== 'presentation-stitch' && unit.kind !== 'presentation-edit-stitch')) return {};
  const measured = { storageKey: output.storageKey, sha256: output.sha256, sizeBytes: output.sizeBytes, contentType: output.contentType };
  if (unit.kind === 'presentation-edit-stitch') {
    const recipe = request.outputs[0]!.recipe;
    if (recipe.kind !== 'stitch' || !('edit' in recipe)) throw new Error('An edit stitch request carries its edit stitch recipe');
    return { receipts: [{ role: 'edit', ...measured, tier: recipe.edit.profile }] };
  }
  return { receipts: [{ role: 'carrier', ...measured, ...(output.packing === undefined ? { packing: 'native' as const } : { packing: 'alpha-packed' as const, geometry: output.packing }) }] };
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
    const request = requestFor(pickup, unit, attempt.jobId);
    if (request === null) { again = true; continue; }
    let report: MiniToolPlanJobReport | null;
    if (latestPending) {
      try { report = await advanceMiniToolPlanJob(request); } catch (error) {
        if (!(error instanceof StillRunning)) throw error;
        again = true;
        continue;
      }
      if (report.state === 'done') {
        await reportUnit(pickup, unit, { kind: 'Done', attempt: attempt.attempt, usage: report.usage.wallMs, ...doneFacts(unit, request, report) });
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
  const request = requestFor(pickup, unit, attemptJobId(pickup.identity.jobId, unit, 1));
  if (request === null) return;
  try { await advanceMiniToolPlanJob(request); } catch (error) { if (!(error instanceof StillRunning)) throw error; }
}

/**
 * Take the next allowed step of the route (§7.1.1): from plan, advance to the route's first working stage and dispatch its
 * units; in a working stage, dispatch any unit not yet opened, and once every unit is done advance to the next stage and
 * dispatch its units, or to publish.
 * @param pickup - The pickup.
 * @returns Whether this pickup must come back.
 * @throws {Error} When ingest or a job submission fails.
 */
async function nextStep(pickup: Pickup): Promise<boolean> {
  const { answer, identity } = pickup;
  const plan = answer.plan;
  const stage = answer.preparation?.stage ?? null;
  if (plan === null || stage === null || answer.work.kind === 'none') return false;
  /**
   * Advance to the stage after the current one and dispatch its units.
   * @returns Whether this pickup must come back.
   * @throws {Error} When ingest or a job submission fails.
   */
  const advance = async (): Promise<boolean> => {
    const next = plan.stages[plan.stages.indexOf(stage) + 1];
    if (next === undefined) return false;
    if (!await advanceStage(pickup, next)) {
      if (next === 'publish') logger.warn({ ctx: { ...identity, stage } }, 'video_presentation_publish_refused');
      return next !== 'publish';
    }
    for (const unit of stageUnits(next, answer.work)) await dispatch(pickup, unit);
    return next !== 'publish';
  };
  if (stage === 'plan') return advance();
  const units = stageUnits(stage, answer.work);
  if (units.length === 0) return false;
  const missing = units.filter((unit) => answer.units[unitKey(identity.jobId, unit)] === undefined);
  for (const unit of missing) await dispatch(pickup, unit);
  if (missing.length > 0) return true;
  // Every unit exists and none is open (settleUnit came back for those): only a stage whose units are all done moves on.
  if (units.some((unit) => answer.units[unitKey(identity.jobId, unit)]!.state !== 'done')) return false;
  return advance();
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
