// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Run one mini-tool container job (inner#888 §8.1).
 *
 * The job's id, class, deadline and output keys are written to the task's
 * `container_job` step before the first submission, so a retried attempt
 * submits the same job and reads the same keys: nothing runs twice and no
 * second set of outputs is written. A done report is filed output by output
 * through the same report handler every upload goes through, and the run is
 * charged for the seconds the report says it used.
 */

import { setTimeout as sleep } from "node:timers/promises";

import { env, getMiniToolsConfig, logger } from "@breatic/core";
import {
  assetService,
  createUsageRecorder,
  creditsForUsd,
  ingestReportService,
  openContainerOutputs,
  upstreamStepRepo,
} from "@breatic/domain";
import {
  readMiniToolJob,
  submitMiniToolJob,
  UploadHttpError,
  type ContainerUsage,
  type MiniToolJobOutput,
  type MiniToolJobReport,
} from "@breatic/shared";
import {
  type ContainerOp,
  type MiniToolSpec,
} from "@breatic/shared/mini-tools";

import { containerCostUsd } from "@worker/handlers/container/billing.js";
import { storedAsOutput } from "@worker/handlers/persisted-output.js";
import type { PersistedOutput } from "@worker/handlers/persisted-output.js";

/** A container run that ended without its outputs; the message is the row's cause code. */
export class ContainerJobFailed extends Error {
  /**
   * @param reason - The cause code the task row holds.
   */
  constructor(readonly reason: string) {
    super(reason);
    this.name = "ContainerJobFailed";
  }
}

/** What the step keeps so a retry finds the same job. */
interface StoredJob {
  jobId: string;
  containerClass: string;
  deadlineAt: number;
  outputs: MiniToolJobOutput[];
}

/** One run's inputs. */
export interface ContainerRunInput {
  taskId: string;
  userId: string;
  projectId: string;
  params: Record<string, unknown>;
  sourceKey: string;
}

/**
 * The job a step already holds.
 * @param output - The step's output.
 * @returns The job, or null when none was opened yet.
 */
function storedJob(output: Record<string, unknown>): StoredJob | null {
  const job = output as Partial<StoredJob>;
  return typeof job.jobId === "string" &&
    typeof job.containerClass === "string" &&
    typeof job.deadlineAt === "number" &&
    Array.isArray(job.outputs)
    ? (job as StoredJob)
    : null;
}

/**
 * Find this task's job, or open it: the deadline and the output keys are
 * fixed once, on the first attempt.
 * @param spec - The tool.
 * @param op - Its operation.
 * @param input - The run.
 * @returns The step's id and the job.
 */
async function jobFor(spec: MiniToolSpec, op: ContainerOp, input: ContainerRunInput): Promise<{ stepId: string; job: StoredJob }> {
  const plan = getMiniToolsConfig().ops[op];
  const [step] = await upstreamStepRepo.ensureSteps(input.taskId, [
    { kind: "container_job", endpoint: plan.container_class, itemIndex: null },
  ]);
  if (!step) throw new Error(`task ${input.taskId} has no container step`);
  if (step.status === "failed") throw new ContainerJobFailed("tool_failed");
  const held = storedJob(step.output);
  if (held) return { stepId: step.id, job: held };
  const deadlineAt = Date.now() + plan.job_deadline_ms;
  const job: StoredJob = {
    jobId: `task:${input.taskId}`,
    containerClass: plan.container_class,
    deadlineAt,
    outputs: await openContainerOutputs({
      projectId: input.projectId,
      actingUserId: input.userId,
      taskId: input.taskId,
      deadlineAt,
      outputs: spec.outputs,
    }),
  };
  await upstreamStepRepo.recordInline(step.id, { ...job }, 0);
  return { stepId: step.id, job };
}

/**
 * Submit the job when its class holds none, then wait for it to end.
 * @param op - The operation.
 * @param input - The run.
 * @param job - The job.
 * @returns The ending report.
 * @throws {ContainerJobFailed} When the deadline passes with the job still going.
 */
async function awaitJob(op: ContainerOp, input: ContainerRunInput, job: StoredJob): Promise<MiniToolJobReport> {
  const { poll_interval_ms: poll } = getMiniToolsConfig();
  const giveUpAt = job.deadlineAt + poll * 2;
  while (Date.now() < giveUpAt) {
    let report = await readMiniToolJob(env.INGEST_BASE_URL, env.INGEST_SHARED_SECRET, job.containerClass, job.jobId);
    if (report === null) {
      try {
        report = await submitMiniToolJob(env.INGEST_BASE_URL, env.INGEST_SHARED_SECRET, {
          jobId: job.jobId,
          containerClass: job.containerClass,
          deadlineAt: job.deadlineAt,
          op,
          params: input.params,
          input: { storageKey: input.sourceKey },
          outputs: job.outputs,
          limits: assetService.mediaLimits(),
        });
      } catch (err) {
        // The container could not start; the next poll submits again.
        if (!(err instanceof UploadHttpError && err.status === 503)) throw err;
        logger.warn({ taskId: input.taskId, jobId: job.jobId }, "mini_tool_container_start_refused");
        report = null;
      }
    }
    if (report !== null && (report.state === "done" || report.state === "failed")) return report;
    await sleep(poll);
  }
  throw new ContainerJobFailed("tool_failed");
}

/**
 * Write the run's one usage row and work out its credits.
 * @param input - The run.
 * @param op - The operation.
 * @param containerClass - The class it ran in.
 * @param usage - What the container measured.
 * @returns The credits the run costs.
 */
async function charge(input: ContainerRunInput, op: ContainerOp, containerClass: string, usage: ContainerUsage): Promise<number> {
  const config = getMiniToolsConfig();
  const size = config.classes[containerClass];
  if (!size) throw new Error(`container class ${containerClass} is not in config/mini-tools.yaml`);
  const costUsd = containerCostUsd(usage, size, config.prices);
  const recorder = createUsageRecorder({
    operationKey: `task:${input.taskId}`,
    feature: "mini_tool",
    actorUserId: input.userId,
    projectId: input.projectId,
    onMissingCost: (row) => logger.error({ row, taskId: input.taskId }, "agent_usage_cost_missing"),
  });
  recorder.recordServiceCall({
    source: "container",
    service: `cloudflare-container:${op}`,
    provider: "cloudflare",
    requests: 1,
    costUsd,
    costSource: "computed",
  });
  await recorder.settle();
  return creditsForUsd(costUsd, env.CREDIT_MULTIPLIER);
}

/**
 * Run one container tool on the task's source.
 * @param spec - The tool.
 * @param op - Its operation.
 * @param input - The run.
 * @returns The stored outputs, in output order, and the credits to charge.
 * @throws {ContainerJobFailed} When the job failed or ran out of time, or an output was refused.
 */
export async function runContainerJob(
  spec: MiniToolSpec,
  op: ContainerOp,
  input: ContainerRunInput,
): Promise<[Record<string, unknown>, number]> {
  const { stepId, job } = await jobFor(spec, op, input);
  const report = await awaitJob(op, input, job);
  if (report.state === "failed") {
    // A failed run is not charged; its row is still written, to reconcile the bill.
    if (report.usage) await charge(input, op, job.containerClass, report.usage);
    await upstreamStepRepo.markFailed(stepId, report.reason);
    throw new ContainerJobFailed(report.reason);
  }
  if (report.state !== "done") throw new ContainerJobFailed("tool_failed");

  const outputs: PersistedOutput[] = [];
  for (const written of job.outputs) {
    const measured = report.outputs.find((output) => output.storageKey === written.storageKey);
    if (!measured) throw new ContainerJobFailed("tool_failed");
    const outcome = await ingestReportService.applyIngestReport({ ...measured, outcome: "completed" });
    if (outcome.status !== "registered" && outcome.status !== "already_registered") {
      await charge(input, op, job.containerClass, report.usage);
      throw new ContainerJobFailed(outcome.status === "rejected" ? outcome.reason : "internal");
    }
    outputs.push(
      storedAsOutput({
        fileUrl: outcome.fileUrl,
        coverUrl: outcome.coverUrl,
        width: outcome.width,
        height: outcome.height,
        durationSeconds: outcome.durationSeconds,
        mimeType: outcome.mimeType,
        sizeBytes: outcome.sizeBytes,
        assetId: outcome.assetId,
        kind: outcome.kind,
      }),
    );
  }
  const credits = await charge(input, op, job.containerClass, report.usage);
  await upstreamStepRepo.markDone(stepId, { state: "done" });
  return [{ outputs, cost: 0 }, credits];
}
