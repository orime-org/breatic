// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The mini-tool container job protocol between our worker and the ingest
 * Worker (inner#888 §8.1). Both ends read these shapes, and they run on two
 * runtimes, so the shapes live here.
 *
 * A job is named by its id and answered by its container class: the same id
 * submitted again answers the same job, and a job is only ever read from the
 * class it was submitted to.
 */

import { z } from "zod";

import type { ContainerOp } from "@shared/mini-tools/types.js";
import {
  askWorker,
  ingestMeasurements,
  UploadHttpError,
  type IngestMeasurements,
  type MediaLimits,
} from "@shared/upload/ingest-client.js";

/** One output a job writes. */
export interface MiniToolJobOutput {
  storageKey: string;
  contentType: string;
  /** Where a video's cover goes; a cover that fails leaves the output standing. */
  coverKey?: string;
}

/** What the worker submits. */
export interface MiniToolJobRequest {
  jobId: string;
  containerClass: string;
  /** Epoch ms; the job fails when it is reached. */
  deadlineAt: number;
  op: ContainerOp;
  params: Record<string, unknown>;
  input: { storageKey: string };
  outputs: MiniToolJobOutput[];
  limits: MediaLimits;
}

/** What the container measured about its own run. */
export interface ContainerUsage {
  /** From just before the container started to its destroy, cold start included. */
  wallMs: number;
  /** cgroup `cpu.stat` `usage_usec`; null when the container could not read it. */
  cpuUsec: number | null;
}

/** What a job answers. */
export type MiniToolJobReport =
  | { state: "starting" | "running" }
  | { state: "done"; outputs: (IngestMeasurements & { storageKey: string })[]; usage: ContainerUsage }
  | { state: "failed"; reason: "tool_failed"; usage: ContainerUsage | null };

const usage = z.object({
  wallMs: z.number().nonnegative(),
  cpuUsec: z.number().nonnegative().nullable(),
});

const report = z.discriminatedUnion("state", [
  z.object({ state: z.literal("starting") }),
  z.object({ state: z.literal("running") }),
  z.object({
    state: z.literal("done"),
    outputs: z.array(ingestMeasurements.extend({ storageKey: z.string().min(1).max(500) })),
    usage,
  }),
  z.object({ state: z.literal("failed"), reason: z.literal("tool_failed"), usage: usage.nullable() }),
]);

/**
 * Read a report.
 * @param answered - What the Worker sent.
 * @returns The report.
 * @throws {Error} When it is not one.
 */
export function readMiniToolJobReport(answered: unknown): MiniToolJobReport {
  const read = report.safeParse(answered);
  if (!read.success) throw new Error("The ingest Worker answered a job report this side cannot read");
  return read.data as MiniToolJobReport;
}

/**
 * Submit a job. Submitting the same id again answers the job that already
 * holds it, so a retried delivery starts nothing new.
 * @param baseUrl - The ingest Worker's base address.
 * @param secret - The secret the Worker also holds.
 * @param job - The job.
 * @returns The job's report.
 * @throws {UploadHttpError} When the Worker refuses, 503 when the container could not start.
 * @throws {unknown} The transport's own failure when no delivery produced a response.
 */
export async function submitMiniToolJob(
  baseUrl: string,
  secret: string,
  job: MiniToolJobRequest,
): Promise<MiniToolJobReport> {
  const answered = await askWorker<unknown>(
    `${baseUrl}/jobs`,
    {
      method: "POST",
      headers: { "x-ingest-secret": secret, "content-type": "application/json" },
      body: JSON.stringify(job),
    },
    { replaySafe: true },
  );
  return readMiniToolJobReport(answered);
}

/**
 * Read a job.
 * @param baseUrl - The ingest Worker's base address.
 * @param secret - The secret the Worker also holds.
 * @param containerClass - The class it was submitted to.
 * @param jobId - Its id.
 * @returns The report, or null when that class holds no such job.
 * @throws {UploadHttpError} When the Worker refuses for any other reason.
 * @throws {unknown} The transport's own failure when no delivery produced a response.
 */
export async function readMiniToolJob(
  baseUrl: string,
  secret: string,
  containerClass: string,
  jobId: string,
): Promise<MiniToolJobReport | null> {
  try {
    const answered = await askWorker<unknown>(
      `${baseUrl}/jobs/${encodeURIComponent(containerClass)}/${encodeURIComponent(jobId)}`,
      { method: "GET", headers: { "x-ingest-secret": secret } },
      { replaySafe: true },
    );
    return readMiniToolJobReport(answered);
  } catch (err) {
    if (err instanceof UploadHttpError && err.status === 404) return null;
    throw err;
  }
}
