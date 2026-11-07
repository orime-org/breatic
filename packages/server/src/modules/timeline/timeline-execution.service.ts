// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The Timeline execution routes' logic (inner#1711 design §4).
 *
 * Accepting looks up the action first: an action already accepted answers its own row, or a conflict when its input
 * differs, and holds nothing. A new one holds its credits under a fresh execution id, then writes the execution and
 * this Project's grant in one transaction; every failure after the hold releases it. Reads answer through the grant
 * rows, so a duplicated Project resolves and previews what its source made while its execution list stays its own.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  AppError,
  ConflictError,
  NotFoundError,
  ValidationError,
  budgetDeadlineFrom,
  db,
  env,
  type DbTx,
  getTimelineConfig,
  logger,
  timelineExecutionRepo,
} from "@breatic/core";
import { creditHoldService, sumCreditsByOperationKeys, webAnimationSourceRepo } from "@breatic/domain";
import { ceilToCreditCent, extractPromptText, signPayload, t, type TimelineExecution, type TimelineRate } from "@breatic/shared";
import {
  TimelineExecutionInputSchema,
  encodePreviewToken,
  webAnimationDurationFrames,
  type TimelineExecutionCreateInput,
  type TimelineExecutionInput,
} from "@breatic/shared/space-content";
import { reserveForRun } from "@server/modules/payment/credit-precheck.service.js";
import * as projectService from "@server/modules/project/project.service.js";
import { publishSpaceTasksQuietly } from "@server/modules/task/publish-counts.js";
import * as grantRepo from "@server/modules/timeline/execution-grant.repo.js";

/** What accepting answered: the row, and whether this request created it. */
export interface AcceptedExecution {
  row: TimelineExecution;
  created: boolean;
}

/** A list row: the execution and the credits its usage rows add up to. */
export type ListedExecution = TimelineExecution & { usageCredits: number };

/** What a web clip's extent is resolved from (design §3.2). */
export interface WebSourceResolution {
  sources: Record<string, { durationFrames: number; fps: TimelineRate; viewport: { width: number; height: number } }>;
  executions: Record<string, { status: TimelineExecution["status"]; resultSourceVersionId: string | null; acceptedDurationFrames: number; fps: TimelineRate }>;
}

const TERMINAL: ReadonlySet<TimelineExecution["status"]> = new Set(["succeeded", "failed", "cancelled", "expired"]);

/** The insert lost to a concurrent accept of the same action; the transaction is rolled back and the winner read. */
class ActionTaken extends Error {
  /** The marker. */
  constructor() {
    super("timeline execution action taken");
    this.name = "ActionTaken";
  }
}

/**
 * The operation key an execution's usage rows and charge are recorded under.
 * @param executionId - The execution.
 * @returns The key.
 * @throws {never} Never.
 */
function operationKeyOf(executionId: string): string {
  return `timeline:${executionId}`;
}

/**
 * Freeze the dialog's input: the prompt as `extractPromptText` leaves it, inside the configured bounds.
 * @param body - The validated request.
 * @returns The frozen input.
 * @throws {ValidationError} When the prompt is empty or too long, or the duration is out of range.
 */
function freeze(body: TimelineExecutionCreateInput): TimelineExecutionInput {
  const config = getTimelineConfig().web_animation;
  const prompt = extractPromptText(body.prompt);
  const { min, max } = config.duration_seconds;
  if (prompt.length === 0 || prompt.length > config.prompt_max_length || body.durationSeconds < min || body.durationSeconds > max) {
    throw new ValidationError(t("server.error.validation"));
  }
  return { prompt, engine: body.engine, aspect: body.aspect, durationSeconds: body.durationSeconds, fps: { num: body.fps.num, den: body.fps.den } };
}

/**
 * Hash a frozen input in a fixed field order, so the same input always hashes the same.
 * @param input - The frozen input.
 * @returns `sha256:<hex>`.
 * @throws {never} Never.
 */
function hashInput(input: TimelineExecutionInput): string {
  const canonical = JSON.stringify([input.prompt, input.engine, input.aspect, input.durationSeconds, input.fps.num, input.fps.den]);
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

/**
 * Answer an action that already has a row.
 * @param row - Its row.
 * @param inputHash - The hash of this request's input.
 * @returns The row, unchanged.
 * @throws {ConflictError} When this request's input differs from the accepted one.
 */
function sameAction(row: TimelineExecution, inputHash: string): AcceptedExecution {
  if (row.inputHash !== inputHash) throw new ConflictError(t("server.error.conflict"));
  return { row, created: false };
}

/**
 * Release a hold this request took, logging when that fails: the hold expires with its budget either way.
 * @param executionId - The hold's key.
 * @param projectId - For the log.
 * @returns Nothing.
 */
async function releaseQuietly(executionId: string, projectId: string): Promise<void> {
  await creditHoldService.releaseHold(executionId).catch((err: unknown) => {
    logger.error({ err, executionId, projectId }, "timeline_execution_hold_release_failed");
  });
}

/**
 * Accept a web-animation execution, or answer the one this action already created.
 * @param userId - The caller.
 * @param body - The validated request.
 * @returns The row and whether this request created it.
 * @throws {NotFoundError} When the caller is not a member of the Project.
 * @throws {ForbiddenError} When the caller is below editor.
 * @throws {ValidationError} When the input is out of the configured bounds.
 * @throws {ConflictError} When the action was accepted with a different input.
 * @throws {AppError} 402 when the studio cannot cover the hold.
 */
export async function accept(userId: string, body: TimelineExecutionCreateInput & { projectId: string }): Promise<AcceptedExecution> {
  const { projectId, spaceId, actionId } = body;
  await projectService.assertAccess(projectId, userId, "editor");
  const input = freeze(body);
  const inputHash = hashInput(input);
  const existing = await timelineExecutionRepo.findByAction({ projectId, spaceId, actionId });
  if (existing !== undefined) return sameAction(existing, inputHash);

  const id = randomUUID();
  await reserveForRun(projectId, userId, id, getTimelineConfig().web_animation.reserve_credits);
  try {
    const row = await db.transaction(async (tx) => {
      const inserted = await timelineExecutionRepo.insert(
        {
          id,
          projectId,
          spaceId,
          actorUserId: userId,
          kind: "web_animation_create",
          engine: input.engine,
          actionId,
          input: { ...input },
          inputHash,
          deadlineAt: new Date(budgetDeadlineFrom(Date.now())),
        },
        tx,
      );
      if (inserted === null) throw new ActionTaken();
      await grantRepo.insertGrant({ executionId: id, projectId }, tx);
      return inserted;
    });
    return { row, created: true };
  } catch (err) {
    await releaseQuietly(id, projectId);
    if (!(err instanceof ActionTaken)) throw err;
    const winner = await timelineExecutionRepo.findByAction({ projectId, spaceId, actionId });
    if (winner === undefined) throw new AppError(500, t("server.error.internal"));
    return sameAction(winner, inputHash);
  }
}

/**
 * List a Space's executions in this Project, newest first, each with the credits its usage adds up to.
 * @param userId - The caller.
 * @param projectId - The Project.
 * @param spaceId - The Space.
 * @returns The rows.
 * @throws {NotFoundError} When the caller is not a member of the Project.
 */
export async function list(userId: string, projectId: string, spaceId: string): Promise<ListedExecution[]> {
  await projectService.assertAccess(projectId, userId, "viewer");
  const rows = await timelineExecutionRepo.listForSpace({ projectId, spaceId });
  const sums = await sumCreditsByOperationKeys(rows.map((row) => operationKeyOf(row.id)));
  return rows.map((row) => ({ ...row, usageCredits: ceilToCreditCent(Number(sums.get(operationKeyOf(row.id)) ?? 0)) }));
}

/**
 * Resolve the sources and executions a Project's web clips reference, through its grants.
 * @param userId - The caller.
 * @param projectId - The Project the clips are in.
 * @param sourceIds - Source versions the clips name.
 * @param executionIds - Executions placeholder clips name.
 * @returns What the Project holds a grant for; anything else is left out.
 * @throws {NotFoundError} When the caller is not a member of the Project.
 */
export async function resolveWebSources(
  userId: string,
  projectId: string,
  sourceIds: readonly string[],
  executionIds: readonly string[],
): Promise<WebSourceResolution> {
  await projectService.assertAccess(projectId, userId, "viewer");
  const [sources, executions] = await Promise.all([
    webAnimationSourceRepo.findByIds(sourceIds),
    timelineExecutionRepo.findByIds(executionIds),
  ]);
  const granted = await grantRepo.grantedExecutionIds(projectId, [...new Set([...sources.map((s) => s.executionId), ...executions.map((e) => e.id)])]);
  const resolution: WebSourceResolution = { sources: {}, executions: {} };
  for (const source of sources) {
    if (!granted.has(source.executionId)) continue;
    resolution.sources[source.id] = {
      durationFrames: source.durationFrames,
      fps: { num: source.fpsNum, den: source.fpsDen },
      viewport: { width: source.width, height: source.height },
    };
  }
  for (const execution of executions) {
    if (!granted.has(execution.id)) continue;
    const input = TimelineExecutionInputSchema.safeParse(execution.input);
    if (!input.success) {
      logger.error({ executionId: execution.id, issues: input.error.issues }, "timeline_execution_input_unreadable");
      continue;
    }
    resolution.executions[execution.id] = {
      status: execution.status,
      resultSourceVersionId: execution.resultSourceVersionId,
      acceptedDurationFrames: webAnimationDurationFrames(input.data),
      fps: input.data.fps,
    };
  }
  return resolution;
}

/**
 * Cancel an execution: one nothing has started ends at once and releases its hold; a running one is asked to stop.
 * @param userId - The caller.
 * @param executionId - The execution.
 * @returns The row after the request; a terminal row unchanged.
 * @throws {NotFoundError} When there is no such execution or the caller is not a member of its Project.
 * @throws {ForbiddenError} When the caller is below editor.
 */
export async function cancel(userId: string, executionId: string): Promise<TimelineExecution> {
  const row = await timelineExecutionRepo.findById(executionId);
  if (row === undefined) throw new NotFoundError(t("server.error.not_found"));
  await projectService.assertAccess(row.projectId, userId, "editor");
  if (TERMINAL.has(row.status)) return row;
  const result = await timelineExecutionRepo.transition({ id: executionId, event: { type: "cancel" } });
  if (!result.applied) return result.row;
  // A cancelled row has no attempt left to settle it; a cancelling one is settled by its attempt.
  if (result.row.status === "cancelled") await creditHoldService.releaseHold(executionId);
  await publishSpaceTasksQuietly(result.row.projectId, result.row.spaceId);
  return result.row;
}

/**
 * Sign a preview address for a source version this Project holds a grant for.
 * @param userId - The caller.
 * @param sourceId - The source version.
 * @param projectId - The Project the request is made from.
 * @returns The address, readable until the configured time runs out.
 * @throws {NotFoundError} When the caller is not a member, the source does not exist or the Project holds no grant for it.
 */
export async function previewUrl(userId: string, sourceId: string, projectId: string): Promise<string> {
  await projectService.assertAccess(projectId, userId, "viewer");
  const source = await webAnimationSourceRepo.findById(sourceId);
  if (source === undefined || !(await grantRepo.grantedExecutionIds(projectId, [source.executionId])).has(source.executionId)) {
    throw new NotFoundError(t("server.error.not_found"));
  }
  const exp = Date.now() + getTimelineConfig().web_animation.preview_token_ttl_ms;
  const signed = await signPayload({ sourceVersionId: source.id, packageKey: source.packageKey, exp }, env.INGEST_SHARED_SECRET);
  return `${env.WEB_ANIMATION_PREVIEW_BASE_URL}/web-animation/${encodePreviewToken(signed)}/index.html`;
}

/**
 * Give a Project copy every live grant its source holds, inside the copy's transaction.
 * @param sourceProjectId - The Project copied from.
 * @param copyProjectId - The copy.
 * @param tx - The copy's transaction.
 * @returns Nothing once the grants are written.
 * @throws {Error} When the write fails; the copy then rolls back.
 */
export async function copyGrants(sourceProjectId: string, copyProjectId: string, tx: DbTx): Promise<void> {
  await grantRepo.copyGrants(sourceProjectId, copyProjectId, tx);
}
