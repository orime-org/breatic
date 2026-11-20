// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The web-animation execution routes' logic (inner#1711 design §4; #1490 design §4, §6.3, §6.4).
 *
 * Accepting looks up the action first: an action already accepted answers its own row, or a conflict when its input
 * differs. An export then looks for a live export of the same source in the same Motion Space that this Project holds
 * a grant for, and answers it. Only a new row needs a balance above zero (no credits are held; settlement later
 * charges actual use) and, for an export, storage left; the row starts `queued` and is written with this Project's
 * grant in one transaction, an export with the upload its video is written to, and its job is added once that commits. Reads answer through the grants, as
 * the one row view, so a duplicated Project sees, modifies and exports what its source made and cancels only its own.
 */

import { createHash } from "node:crypto";
import {
  AppError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
  addTimelineExecutionJob,
  announceExecutionChange,
  budgetDeadlineFrom,
  db,
  env,
  getStorageConfig,
  getTimelineConfig,
  logger,
  projectAssetReferenceService,
  timelineExecutionRepo,
} from "@breatic/core";
import {
  SMALLEST_CREDIT,
  sumCreditsByOperationKeys,
  timelineOperationKey,
  uploadGrantService,
  webAnimationSourceRepo,
} from "@breatic/domain";
import {
  ceilToCreditCent,
  extractPromptText,
  signPayload,
  t,
  type TimelineExecution,
  type TimelineWebResolution,
  type TimelineWebResolutionOrigin,
  type WebAnimationSourceVersion,
} from "@breatic/shared";
import {
  encodePreviewToken,
  executionInputOf,
  webAnimationDurationFrames,
  type WebAnimationExecutionInput,
  type WebAnimationExecutionRequest,
  type WebAnimationRowView,
} from "@breatic/shared/space-content";
import { assertStorageAllowance } from "@server/modules/asset/storageQuota.service.js";
import { precheckCredits } from "@server/modules/payment/credit-precheck.service.js";
import * as projectService from "@server/modules/project/project.service.js";
import * as grantRepo from "@server/modules/web-animation/web-animation-grants.repo.js";
import { timelineQueue } from "@server/modules/web-animation/timeline-queue.js";

/** What accepting answered: the row, and whether this request created it. */
export interface AcceptedExecution {
  row: WebAnimationRowView;
  created: boolean;
}

/** One page of a list. */
export interface ExecutionPage {
  rows: WebAnimationRowView[];
  nextCursor: string | null;
  /** Counted for a Motion Space list's first page only; null on later pages and for the Timeline picker's results. */
  totals: grantRepo.GroupTotals | null;
}

/** The insert lost to a concurrent accept; the transaction is rolled back and the winner read. */
class InsertLost extends Error {
  /** The marker. */
  constructor() {
    super("web animation execution insert lost");
    this.name = "InsertLost";
  }
}

/** A frozen input before the export's video key is minted, and its engine. */
interface Frozen {
  input: Record<string, unknown>;
  engine: TimelineExecution["engine"];
}

/**
 * Tell the execution's Space that it changed, and carry on if Redis refuses: the open tabs read the next change.
 * @param row - The execution as written.
 */
async function announceQuietly(row: TimelineExecution): Promise<void> {
  try {
    await announceExecutionChange(row);
  } catch (err) {
    logger.error({ err, executionId: row.id, projectId: row.projectId, spaceId: row.spaceId }, "execution_change_publish_failed");
  }
}

/**
 * Bound a typed text as the configuration allows, after `extractPromptText`.
 * @param raw - What the user typed.
 * @returns The text frozen.
 * @throws {ValidationError} When it is empty or too long.
 */
function freezeText(raw: string): string {
  const text = extractPromptText(raw);
  if (text.length === 0 || text.length > getTimelineConfig().web_animation.prompt_max_length) throw new ValidationError(t("server.error.validation"));
  return text;
}

/**
 * Check a requested length against the configured range.
 * @param durationSeconds - The length asked for.
 * @throws {ValidationError} When it lies outside the range.
 */
function checkDuration(durationSeconds: number): void {
  const { min, max } = getTimelineConfig().web_animation.duration_seconds;
  if (durationSeconds < min || durationSeconds > max) throw new ValidationError(t("server.error.validation"));
}

/**
 * Read a source version this Project holds a grant for.
 * @param projectId - The Project.
 * @param sourceVersionId - The version.
 * @returns It.
 * @throws {NotFoundError} When it does not exist or the Project holds no grant for it.
 */
async function grantedVersion(projectId: string, sourceVersionId: string): Promise<WebAnimationSourceVersion> {
  const version = await webAnimationSourceRepo.findById(sourceVersionId);
  if (version === undefined || !(await grantRepo.grantedExecutionIds(projectId, [version.executionId])).has(version.executionId)) {
    throw new NotFoundError(t("server.error.not_found"));
  }
  return version;
}

/**
 * Freeze what a request asks for: texts as `extractPromptText` leaves them inside the configured bounds, a create at
 * the configured frame rate, a modification at its base's, an export at its source's frame and length.
 * @param projectId - The Project accepting.
 * @param request - The read request.
 * @returns The frozen input without the export's video key, and its engine.
 * @throws {ValidationError} When a text or the length is out of bounds.
 * @throws {NotFoundError} When the base or source version is not this Project's to use.
 */
async function freeze(projectId: string, request: WebAnimationExecutionRequest): Promise<Frozen> {
  switch (request.kind) {
    case "web_animation_create": {
      checkDuration(request.durationSeconds);
      const fps = getTimelineConfig().web_animation.fps;
      const input = { prompt: freezeText(request.prompt), engine: request.engine, aspect: request.aspect, durationSeconds: request.durationSeconds, fps };
      return { input, engine: request.engine };
    }
    case "web_animation_modify": {
      checkDuration(request.durationSeconds);
      const instruction = freezeText(request.instruction);
      const base = await grantedVersion(projectId, request.baseSourceVersionId);
      const fps = { num: base.fpsNum, den: base.fpsDen };
      const input = { baseSourceVersionId: base.id, instruction, engine: request.engine, aspect: request.aspect, durationSeconds: request.durationSeconds, fps };
      return { input, engine: request.engine };
    }
    case "web_animation_export": {
      const source = await grantedVersion(projectId, request.sourceVersionId);
      const fps = { num: source.fpsNum, den: source.fpsDen };
      const input = { sourceVersionId: source.id, width: source.width, height: source.height, fps, durationFrames: source.durationFrames };
      return { input, engine: null };
    }
  }
}

/**
 * Hash a frozen input with its kind, so the same input always hashes the same, any field that differs changes it and
 * an action replayed as another kind differs. `freeze` builds every input in a fixed key order.
 * @param kind - The kind.
 * @param input - The frozen input, before the export's video key is minted.
 * @returns `sha256:<hex>`.
 * @throws {never} Never.
 */
function hashInput(kind: TimelineExecution["kind"], input: Record<string, unknown>): string {
  return `sha256:${createHash("sha256").update(JSON.stringify([kind, input])).digest("hex")}`;
}

/**
 * Open the upload an export's video is written to; the cover is written beside it at `coverKeyFor` and filed by the
 * video's own report, as a mini-tool's video output is (`container-outputs.service.ts`).
 * @param projectId - The Project the video belongs to.
 * @param userId - Who exported.
 * @param deadlineAt - When the export runs out.
 * @returns The video's key.
 * @throws {NotFoundError} When the Project does not exist.
 */
async function openVideoUpload(projectId: string, userId: string, deadlineAt: Date): Promise<string> {
  const { key } = await uploadGrantService.issueUploadGrant({
    projectId,
    actingUserId: userId,
    declaredSize: getStorageConfig().upload.max_upload_bytes,
    taskType: "video",
    ext: ".mp4",
    expiresAt: deadlineAt,
    context: { assetSource: "ai", derived: true, generationTaskId: null },
  });
  return key;
}

/**
 * Accept a web-animation execution, or answer the row this action, or this export, already has.
 * @param userId - The caller.
 * @param body - The read request and its Project.
 * @returns The row as the routes answer it, and whether this request created it.
 * @throws {NotFoundError} When the caller is not a member, or the base or source is not the Project's to use.
 * @throws {ForbiddenError} When the caller is below editor.
 * @throws {ValidationError} When the input is out of the configured bounds.
 * @throws {ConflictError} When the action was accepted with a different input.
 * @throws {AppError} 402 when the studio's balance is not above zero, 507 when an export has no storage left.
 */
export async function accept(userId: string, body: WebAnimationExecutionRequest & { projectId: string }): Promise<AcceptedExecution> {
  const { projectId, spaceId, actionId, kind, origin } = body;
  await projectService.assertAccess(projectId, userId, "editor");
  const frozen = await freeze(projectId, body);
  const inputHash = hashInput(kind, frozen.input);
  const sourceVersionId = body.kind === "web_animation_export" ? body.sourceVersionId : null;
  /**
   * Answer a row as the routes do.
   * @param row - The row.
   * @param created - Whether this request created it.
   * @returns The answer.
   */
  const answer = async (row: TimelineExecution, created: boolean): Promise<AcceptedExecution> => {
    const [view] = await toRowViews([row], { projectId, spaceId });
    if (view === undefined) throw new AppError(500, t("server.error.internal"));
    return { row: view, created };
  };
  /**
   * The row this request already has: the action's own, or a conflict when its input differs; for an export, a video
   * already made, or being made, of the same source here. Asked before any balance or storage check, and again when
   * the insert loses to a concurrent accept.
   * @returns The answer, or undefined when there is none.
   */
  const existing = async (): Promise<AcceptedExecution | undefined> => {
    const replayed = await timelineExecutionRepo.findByAction({ projectId, spaceId, actionId });
    if (replayed !== undefined) {
      if (replayed.inputHash !== inputHash) throw new ConflictError(t("server.error.conflict"));
      return answer(replayed, false);
    }
    if (sourceVersionId === null) return undefined;
    const [live] = await grantRepo.findLiveExports({ projectId, spaceId, sourceVersionIds: [sourceVersionId] });
    return live === undefined ? undefined : answer(live, false);
  };
  const found = await existing();
  if (found !== undefined) return found;

  // A new execution needs a balance above zero to start, as an Agent chat turn does (chat.ts). Payments off: no check.
  await precheckCredits(projectId, userId, SMALLEST_CREDIT);
  if (sourceVersionId !== null) await assertStorageAllowance(projectId, "generate");
  const deadlineAt = new Date(budgetDeadlineFrom(Date.now()));
  try {
    const row = await db.transaction(async (tx) => {
      const input = sourceVersionId === null ? frozen.input : { ...frozen.input, videoKey: await openVideoUpload(projectId, userId, deadlineAt) };
      const inserted = await timelineExecutionRepo.insert(
        { projectId, spaceId, actorUserId: userId, kind, engine: frozen.engine, actionId, input, inputHash, deadlineAt, origin },
        tx,
      );
      if (inserted === null) throw new InsertLost();
      await grantRepo.insertGrant({ executionId: inserted.id, projectId, executionCreatedAt: inserted.createdAt, executionOrigin: inserted.origin }, tx);
      return inserted;
    });
    // The row runs as soon as its job is in the queue; a failed add is left to the worker's sweep.
    await addTimelineExecutionJob(timelineQueue(), row.id).catch((err: unknown) => {
      logger.error({ err, executionId: row.id, projectId, spaceId, userId }, "web_animation_execution_enqueue_failed");
    });
    await announceQuietly(row);
    return answer(row, true);
  } catch (err) {
    if (!(err instanceof InsertLost)) throw err;
    const winner = await existing();
    if (winner === undefined) throw new AppError(500, t("server.error.internal"));
    return winner;
  }
}

/**
 * The request text an execution was asked with: a create's prompt, a modification's instruction.
 * @param input - Its input.
 * @returns The text, or null for an export.
 * @throws {never} Never.
 */
function requestOf(input: WebAnimationExecutionInput): string | null {
  if (input.kind === "web_animation_create") return input.prompt;
  if (input.kind === "web_animation_modify") return input.instruction;
  return null;
}

/**
 * Read an execution's input, logging one whose stored input does not fit its kind.
 * @param row - The execution.
 * @returns Its input, or null when it cannot be read.
 * @throws {never} Never.
 */
function readInput(row: TimelineExecution): WebAnimationExecutionInput | null {
  try {
    return executionInputOf(row);
  } catch (err) {
    logger.error({ err, executionId: row.id }, "web_animation_execution_input_unreadable");
    return null;
  }
}

/** What a row's base or source resolves to: the execution and its input. */
interface Resolved { execution: TimelineExecution; input: WebAnimationExecutionInput }

/**
 * Resolve the executions behind source versions and, for a modification, its own base, and cache them: the row view
 * names at most a row's base or source and that source's base, so two levels are read whatever the chain's length.
 * @param versionIds - The versions.
 * @param byVersion - What is already resolved, by version id; filled in place.
 * @param depth - How many levels to read, these versions included.
 * @returns Nothing.
 * @throws {Error} When a read fails.
 */
async function resolveVersions(versionIds: readonly string[], byVersion: Map<string, Resolved>, depth = 2): Promise<void> {
  const wanted = [...new Set(versionIds)].filter((id) => !byVersion.has(id));
  if (wanted.length === 0) return;
  const versions = await webAnimationSourceRepo.findByIds(wanted);
  const executions = new Map((await timelineExecutionRepo.findByIds(versions.map((v) => v.executionId))).map((row) => [row.id, row]));
  const bases: string[] = [];
  for (const version of versions) {
    const execution = executions.get(version.executionId);
    const input = execution === undefined ? null : readInput(execution);
    if (execution === undefined || input === null) continue;
    byVersion.set(version.id, { execution, input });
    if (input.kind === "web_animation_modify") bases.push(input.baseSourceVersionId);
  }
  if (bases.length > 0 && depth > 1) await resolveVersions(bases, byVersion, depth - 1);
}

/**
 * A modification's base as the row view names it.
 * @param input - The modification's input.
 * @param byVersion - Resolved versions.
 * @returns The base, or undefined when it cannot be resolved.
 * @throws {never} Never.
 */
function baseRef(input: Extract<WebAnimationExecutionInput, { kind: "web_animation_modify" }>, byVersion: Map<string, Resolved>): { executionId: string; request: string } | undefined {
  const base = byVersion.get(input.baseSourceVersionId);
  const request = base === undefined ? null : requestOf(base.input);
  return base === undefined || request === null ? undefined : { executionId: base.execution.id, request };
}

/**
 * Turn rows into the row view every route answers (#1490 design §4.4). A row whose base or source cannot be read is
 * logged and left out. Every row passed in is one the asking Project holds a grant for; the video of a succeeded export
 * another Project made is filed in the asking Project, so the video the view names opens there.
 * @param rows - The rows.
 * @param scope - Who asks.
 * @param scope.projectId - The Project asking, which decides `ownProject`.
 * @param scope.spaceId - The Motion Space asking, which decides `export`; null on routes the Timeline asks.
 * @returns The views, in the rows' order.
 * @throws {Error} When a read or the video's filing fails.
 */
async function toRowViews(rows: readonly TimelineExecution[], scope: { projectId: string; spaceId: string | null }): Promise<WebAnimationRowView[]> {
  const inputs = new Map<string, WebAnimationExecutionInput>();
  for (const row of rows) {
    const input = readInput(row);
    if (input !== null) inputs.set(row.id, input);
  }
  const byVersion = new Map<string, Resolved>();
  await resolveVersions([...inputs.values()].flatMap((input) => (
    input.kind === "web_animation_modify" ? [input.baseSourceVersionId] : input.kind === "web_animation_export" ? [input.sourceVersionId] : []
  )), byVersion);
  const exports = new Map<string, { executionId: string; status: TimelineExecution["status"] }>();
  if (scope.spaceId !== null) {
    const results = rows.filter((row) => row.kind !== "web_animation_export" && row.resultSourceVersionId !== null).map((row) => row.resultSourceVersionId!);
    for (const live of await grantRepo.findLiveExports({ projectId: scope.projectId, spaceId: scope.spaceId, sourceVersionIds: results })) {
      const source = String((live.input as { sourceVersionId?: unknown }).sourceVersionId);
      if (!exports.has(source)) exports.set(source, { executionId: live.id, status: live.status });
    }
  }
  // A Project duplicated while an export rendered holds its grant but not its video, whose reference the finish wrote
  // for the exporting Project only; the read files it, as the copy would have had it copied.
  const inherited = rows.flatMap((row) => (
    row.kind === "web_animation_export" && row.status === "succeeded" && row.resultAssetId !== null && row.projectId !== scope.projectId ? [row.resultAssetId] : []
  ));
  if (inherited.length > 0) await projectAssetReferenceService.referenceRegisteredProjectMedia({ projectId: scope.projectId, assetIds: inherited });
  const sums = await sumCreditsByOperationKeys(rows.map((row) => timelineOperationKey(row.id)));
  const views: WebAnimationRowView[] = [];
  for (const row of rows) {
    const input = inputs.get(row.id);
    if (input === undefined) continue;
    const { kind: _kind, ...stored } = input;
    const common = {
      id: row.id,
      spaceId: row.spaceId,
      status: row.status,
      phase: row.phase,
      failureReason: row.failureReason,
      createdAt: row.createdAt,
      resultSourceVersionId: row.resultSourceVersionId,
      resultAssetId: row.resultAssetId,
      input: stored,
      ownProject: row.projectId === scope.projectId,
      usageCredits: ceilToCreditCent(Number(sums.get(timelineOperationKey(row.id)) ?? 0)),
    };
    const exportOf = scope.spaceId === null ? {} : { export: (row.resultSourceVersionId === null ? undefined : exports.get(row.resultSourceVersionId)) ?? null };
    if (input.kind === "web_animation_create") {
      views.push({ ...common, kind: input.kind, request: input.prompt, ...exportOf } as WebAnimationRowView);
      continue;
    }
    if (input.kind === "web_animation_modify") {
      const base = baseRef(input, byVersion);
      if (base === undefined) { logger.error({ executionId: row.id }, "web_animation_base_unresolved"); continue; }
      views.push({ ...common, kind: input.kind, request: input.instruction, base, ...exportOf } as WebAnimationRowView);
      continue;
    }
    const source = byVersion.get(input.sourceVersionId);
    const request = source === undefined ? null : requestOf(source.input);
    if (source === undefined || request === null) { logger.error({ executionId: row.id }, "web_animation_source_unresolved"); continue; }
    const base = source.input.kind === "web_animation_modify" ? baseRef(source.input, byVersion) : undefined;
    views.push({
      ...common, kind: input.kind,
      source: { executionId: source.execution.id, request, ...(base !== undefined && { base }) },
    } as WebAnimationRowView);
  }
  return views;
}

/**
 * The page size a list request may ask for.
 * @param limit - What it asked for, if anything.
 * @returns The configured size, or the request's within the configured ceiling.
 * @throws {never} Never.
 */
function pageSize(limit: number | undefined): number {
  const { page_size, page_max } = getTimelineConfig().assets;
  return Math.min(limit ?? page_size, page_max);
}

/**
 * Read a page as row views, with the group totals on a Motion Space list's first page, the only page that shows them.
 * @param params - The page.
 * @returns The page.
 * @throws {ValidationError} When the cursor is not one the list wrote.
 */
async function readPage(params: grantRepo.ListParams): Promise<ExecutionPage> {
  let page: grantRepo.ListPage;
  try {
    page = await grantRepo.listPage(params);
  } catch (err) {
    if (err instanceof grantRepo.BadCursorError) throw new ValidationError(t("server.error.validation"));
    throw err;
  }
  const [rows, totals] = await Promise.all([
    toRowViews(page.rows, { projectId: params.projectId, spaceId: params.scope === "results" ? null : params.spaceId }),
    params.cursor === null && params.scope !== "results" ? grantRepo.countGroups(params) : null,
  ]);
  return { rows, nextCursor: page.nextCursor, totals };
}

/**
 * List a Motion Space's own executions, or the Timeline-made group, through this Project's grants.
 * @param userId - The caller.
 * @param query - The page.
 * @param query.projectId - The Project.
 * @param query.spaceId - The Motion Space.
 * @param query.scope - The Space's own rows, or the Timeline-made group.
 * @param query.group - Rows in progress, rows that succeeded, or rows that failed.
 * @param query.cursor - Where the page starts.
 * @param query.limit - The page size asked for.
 * @returns The page.
 * @throws {NotFoundError} When the caller is not a member of the Project.
 * @throws {ValidationError} When the cursor is not one the list wrote.
 */
export async function listSpace(
  userId: string,
  query: { projectId: string; spaceId: string; scope: "space" | "timeline"; group: grantRepo.ListGroup; cursor?: string; limit?: number },
): Promise<ExecutionPage> {
  await projectService.assertAccess(query.projectId, userId, "viewer");
  return readPage({ ...query, cursor: query.cursor ?? null, limit: pageSize(query.limit) });
}

/**
 * List the creates and modifications the Timeline picker offers, through this Project's grants.
 * @param userId - The caller.
 * @param query - The page.
 * @param query.projectId - The Project.
 * @param query.cursor - Where the page starts.
 * @param query.limit - The page size asked for.
 * @returns The page.
 * @throws {NotFoundError} When the caller is not a member of the Project.
 * @throws {ValidationError} When the cursor is not one the list wrote.
 */
export async function listResults(userId: string, query: { projectId: string; cursor?: string; limit?: number }): Promise<ExecutionPage> {
  await projectService.assertAccess(query.projectId, userId, "viewer");
  return readPage({ projectId: query.projectId, spaceId: null, scope: "results", group: "succeeded", cursor: query.cursor ?? null, limit: pageSize(query.limit) });
}

/**
 * Read one execution this Project holds a grant for, with the export it has in the asking Motion Space.
 * @param userId - The caller.
 * @param executionId - The execution.
 * @param projectId - The Project.
 * @param spaceId - The Motion Space asking.
 * @returns Its row view.
 * @throws {NotFoundError} When the caller is not a member, or the Project holds no grant for it.
 */
export async function getOne(userId: string, executionId: string, projectId: string, spaceId: string): Promise<WebAnimationRowView> {
  await projectService.assertAccess(projectId, userId, "viewer");
  const row = await timelineExecutionRepo.findById(executionId);
  if (row === undefined || !(await grantRepo.grantedExecutionIds(projectId, [row.id])).has(row.id)) throw new NotFoundError(t("server.error.not_found"));
  const [view] = await toRowViews([row], { projectId, spaceId });
  if (view === undefined) throw new NotFoundError(t("server.error.not_found"));
  return view;
}

/**
 * Resolve the sources and executions a Project's web clips reference, through its grants, with what made each so the
 * Timeline can name a copy and show its request. An export is no web source and is left out.
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
  const [sources, executions] = await Promise.all([webAnimationSourceRepo.findByIds(sourceIds), timelineExecutionRepo.findByIds(executionIds)]);
  const granted = await grantRepo.grantedExecutionIds(projectId, [...new Set([...sources.map((s) => s.executionId), ...executions.map((e) => e.id)])]);
  const byVersion = new Map<string, Resolved>();
  const inputs = executions.map((execution) => [execution, readInput(execution)] as const);
  await resolveVersions([
    ...sources.map((source) => source.id),
    ...inputs.flatMap(([, input]) => (input?.kind === "web_animation_modify" ? [input.baseSourceVersionId] : [])),
  ], byVersion);
  /**
   * What made an execution, as the resolution names it.
   * @param execution - The execution.
   * @param input - Its input.
   * @returns Its origin, or null for an export.
   */
  const originOf = (execution: TimelineExecution, input: WebAnimationExecutionInput): TimelineWebResolutionOrigin | null => {
    if (input.kind === "web_animation_export") return null;
    const base = input.kind === "web_animation_modify" ? baseRef(input, byVersion) : undefined;
    return { executionId: execution.id, spaceId: execution.spaceId, origin: execution.origin, kind: input.kind, request: requestOf(input) ?? "", ...(base !== undefined && { base }) };
  };
  const resolution: TimelineWebResolution = { sources: {}, executions: {} };
  for (const source of sources) {
    const made = byVersion.get(source.id);
    const origin = made === undefined ? null : originOf(made.execution, made.input);
    if (!granted.has(source.executionId) || origin === null) continue;
    resolution.sources[source.id] = {
      ...origin,
      durationFrames: source.durationFrames,
      fps: { num: source.fpsNum, den: source.fpsDen },
      viewport: { width: source.width, height: source.height },
    };
  }
  for (const [execution, input] of inputs) {
    const origin = input === null ? null : originOf(execution, input);
    if (!granted.has(execution.id) || input === null || origin === null || input.kind === "web_animation_export") continue;
    resolution.executions[execution.id] = {
      ...origin,
      status: execution.status,
      resultSourceVersionId: execution.resultSourceVersionId,
      acceptedDurationFrames: webAnimationDurationFrames(input),
      fps: input.fps,
      phase: execution.phase,
      failureReason: execution.failureReason,
    };
  }
  return resolution;
}

/**
 * Cancel an execution: one nothing has started ends at once; a running one is asked to stop. A duplicated Project
 * sees what its source made but cancels only its own rows.
 * @param userId - The caller.
 * @param executionId - The execution.
 * @param projectId - The Project the request is made from.
 * @returns The row after the request; a terminal row unchanged.
 * @throws {NotFoundError} When there is no such execution, or the caller is not a member of the Project.
 * @throws {ForbiddenError} When the caller is below editor, or the row belongs to another Project.
 */
export async function cancel(userId: string, executionId: string, projectId: string): Promise<TimelineExecution> {
  const row = await timelineExecutionRepo.findById(executionId);
  if (row === undefined) throw new NotFoundError(t("server.error.not_found"));
  await projectService.assertAccess(projectId, userId, "editor");
  if (row.projectId !== projectId) {
    if (!(await grantRepo.grantedExecutionIds(projectId, [row.id])).has(row.id)) throw new NotFoundError(t("server.error.not_found"));
    throw new ForbiddenError(t("server.error.forbidden"));
  }
  const result = await timelineExecutionRepo.transition({ id: executionId, event: { type: "cancel" } });
  if (!result.applied) return result.row;
  await announceQuietly(result.row);
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
  const source = await grantedVersion(projectId, sourceId);
  const exp = Date.now() + getTimelineConfig().web_animation.preview_token_ttl_ms;
  const signed = await signPayload({ sourceVersionId: source.id, packageKey: source.packageKey, exp }, env.INGEST_SHARED_SECRET);
  return `${env.WEB_ANIMATION_PREVIEW_BASE_URL}/web-animation/${encodePreviewToken(signed)}/index.html`;
}
