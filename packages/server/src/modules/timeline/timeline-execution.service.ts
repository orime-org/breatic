// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The Timeline execution routes' logic (inner#1711 design §4).
 *
 * Accepting looks up the action first: an action already accepted answers its own row, or a conflict when its input
 * differs. A new one, like an Agent chat turn, is admitted once, here, within the monthly spend limits and on a balance
 * above zero, and holds no credits; it writes the execution and this Project's grant in one transaction, and settlement
 * later charges actual use. Reads answer through the grant rows, so a duplicated Project resolves and previews what its
 * source made while its execution list stays its own.
 */

import { createHash } from "node:crypto";
import {
  AppError,
  ConflictError,
  NotFoundError,
  ValidationError,
  announceExecutionChange,
  budgetDeadlineFrom,
  db,
  env,
  getTimelineConfig,
  logger,
  timelineExecutionRepo,
} from "@breatic/core";
import { SMALLEST_CREDIT, keyOwnerOf, resolveKeys, sumCreditsByOperationKeys, timelineOperationKey, webAnimationSourceRepo } from "@breatic/domain";
import { ACCOUNT_KEY_FAILURE_KINDS, ceilToCreditCent, extractPromptText, signPayload, t, type TimelineExecution, type TimelineExecutionRow, type TimelineWebResolution } from "@breatic/shared";

/** The failures of the payer's own key or its upstream (inner#1953). */
const KEY_FAILURES: ReadonlySet<string> = new Set(ACCOUNT_KEY_FAILURE_KINDS);
import {
  TimelineExecutionInputSchema,
  encodePreviewToken,
  webAnimationDurationFrames,
  type TimelineExecutionCreateInput,
  type TimelineExecutionInput,
} from "@breatic/shared/space-content";
import { precheckCredits } from "@server/modules/credit/credit-precheck.service.js";
import * as projectService from "@server/modules/project/project.service.js";
import * as grantRepo from "@server/modules/timeline/execution-grant.repo.js";

/** What accepting answered: the row, and whether this request created it. */
export interface AcceptedExecution {
  row: TimelineExecution;
  created: boolean;
}

/** The insert lost to a concurrent accept of the same action; the transaction is rolled back and the winner read. */
class ActionTaken extends Error {
  /** The marker. */
  constructor() {
    super("timeline execution action taken");
    this.name = "ActionTaken";
  }
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
 * Accept a web-animation execution, or answer the one this action already created.
 * @param userId - The caller.
 * @param body - The validated request.
 * @returns The row and whether this request created it.
 * @throws {NotFoundError} When the caller is not a member of the Project.
 * @throws {ForbiddenError} When the caller is below editor.
 * @throws {ValidationError} When the input is out of the configured bounds.
 * @throws {ConflictError} When the action was accepted with a different input.
 * @throws {SpendCapReachedError} 402 when the caller or the studio has spent its monthly limit.
 * @throws {AppError} 402 when the studio's balance is not above zero.
 */
export async function accept(userId: string, body: TimelineExecutionCreateInput & { projectId: string }): Promise<AcceptedExecution> {
  const { projectId, spaceId, actionId } = body;
  await projectService.assertAccess(projectId, userId, "editor");
  const input = freeze(body);
  const inputHash = hashInput(input);
  const existing = await timelineExecutionRepo.findByAction({ projectId, spaceId, actionId });
  if (existing !== undefined) return sameAction(existing, inputHash);

  // Admitted once, as an Agent chat turn is (chat.ts): the spend limits, then a balance above zero; one that then
  // waits for a running slot starts without a second check (design 3.10). Payments off: no check. Asked on the payer's
  // own OpenRouter key too: the render container runs on ours (inner#1953).
  await precheckCredits(projectId, userId, SMALLEST_CREDIT);
  // The key row its language-model calls run on, settled at acceptance and read back by id (inner#1953).
  const { keyId: llmKeyId } = await resolveKeys({ projectId }, { kind: "llm" });
  try {
    const row = await db.transaction(async (tx) => {
      const inserted = await timelineExecutionRepo.insert(
        {
          projectId,
          spaceId,
          actorUserId: userId,
          kind: "web_animation_create",
          engine: input.engine,
          actionId,
          input: { ...input },
          inputHash,
          deadlineAt: new Date(budgetDeadlineFrom(Date.now())),
          llmKeyId,
        },
        tx,
      );
      if (inserted === null) throw new ActionTaken();
      await grantRepo.insertGrant({ executionId: inserted.id, projectId }, tx);
      return inserted;
    });
    return { row, created: true };
  } catch (err) {
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
export async function list(userId: string, projectId: string, spaceId: string): Promise<TimelineExecutionRow[]> {
  await projectService.assertAccess(projectId, userId, "viewer");
  const rows = await timelineExecutionRepo.listForSpace({ projectId, spaceId });
  const sums = await sumCreditsByOperationKeys(rows.map((row) => timelineOperationKey(row.id)));
  return Promise.all(rows.map(async (row) => ({
    ...row,
    usageCredits: ceilToCreditCent(Number(sums.get(timelineOperationKey(row.id)) ?? 0)),
    // A failure of the payer's own key says whose key it was, which the Studio may since have handed to another admin.
    ...(await keyOwnerFor(row)),
  })));
}

/**
 * Whose key a failure of the payer's own key failed on, read from the language-model key row the execution recorded.
 * @param row - An execution.
 * @returns The owner beside a key failure; nothing for any other row.
 */
async function keyOwnerFor(row: TimelineExecution): Promise<{ failureKeyOwner?: string }> {
  if (row.failureReason === null || !KEY_FAILURES.has(row.failureReason)) return {};
  const owner = await keyOwnerOf(await timelineExecutionRepo.llmKeyIdOf(row.id));
  return owner === undefined ? {} : { failureKeyOwner: owner };
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
): Promise<TimelineWebResolution> {
  await projectService.assertAccess(projectId, userId, "viewer");
  const [sources, executions] = await Promise.all([
    webAnimationSourceRepo.findByIds(sourceIds),
    timelineExecutionRepo.findByIds(executionIds),
  ]);
  const granted = await grantRepo.grantedExecutionIds(projectId, [...new Set([...sources.map((s) => s.executionId), ...executions.map((e) => e.id)])]);
  const resolution: TimelineWebResolution = { sources: {}, executions: {} };
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
 * Cancel an execution: one nothing has started ends at once; a running one is asked to stop.
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
  const result = await timelineExecutionRepo.transition({ id: executionId, event: { type: "cancel" } });
  if (!result.applied) return result.row;
  try {
    await announceExecutionChange(result.row);
  } catch (err) {
    // The cancel stands; the Timeline's open tabs read the next change, and a tab opened later reads the list.
    logger.error({ err, executionId: result.row.id, projectId: result.row.projectId, spaceId: result.row.spaceId }, "execution_change_publish_failed");
  }
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
