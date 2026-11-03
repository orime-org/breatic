// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MiniToolPlanRecipe } from "@shared/upload/mini-tool-plan-types.js";
import type { ContainerFailure } from "@shared/mini-tools/types.js";
import type { PlanContainerOutput, MediaOfOutput } from "@ingest/jobs/container-report.js";
import { executePlanRecipe, inspectPlanInput, type PlanLimits, type PlanSource } from "@ingest/container/plan-recipes.js";
import { runPlanCommand } from "@ingest/container/plan-command.js";
import { download, put, cpuUsec } from "@ingest/container/mini-tool-run.js";
import { coverArgs } from "@ingest/probe-command.js";
import { pngSize } from "@ingest/png-size.js";

/** The internal, attempt-bound run sent by the validated job object. */
export interface PlanRunBody {
  schemaVersion: 2;
  attemptId: string;
  deadlineAt: number;
  limits: PlanLimits;
  inputs: { inputId: string; url: string }[];
  outputs: { outputIndex: number; key: string; url: string; contentType: string; coverUrl?: string; recipe: MiniToolPlanRecipe }[];
  reportUrl: string;
}
/** A downloaded source and its complete raw facts, scoped to one invocation. */
interface LocalPlanInput { file: string; facts: PlanSource }

/**
 * Attempt the independently optional cover without invalidating an already stored main object.
 * @param output - Its explicit cover capability and completed main file.
 * @param output.coverUrl - The issued cover URL.
 * @param output.file - The completed local main output.
 * @param directory - This invocation's temporary directory.
 * @param signal - The original job lifetime.
 * @param limits - The frozen process IO bounds.
 * @returns The actual written cover geometry, or null when the optional step failed.
 * @throws {never} Never; cover failures are logged and remain optional.
 */
async function writeCover(output: { coverUrl: string; file: string }, directory: string, signal: AbortSignal, limits: PlanLimits): Promise<MediaOfOutput["cover"]> {
  try {
    const bytes = await runPlanCommand("ffmpeg", coverArgs(output.file, "own-file"), { signal, stdoutBytes: limits.analysisStdoutBytes, stderrTailBytes: limits.stderrTailBytes });
    const size = pngSize(new Uint8Array(bytes));
    if (size === null) throw new Error("Optional cover is not a PNG");
    const file = join(directory, "cover.png");
    await writeFile(file, bytes);
    await put(output.coverUrl, file, signal);
    return { width: size.width, height: size.height };
  } catch (error) {
    console.error("mini_tool_plan_cover_failed", { err: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

/**
 * Execute an immutable local plan and report only the completed indexed subset.
 * @param job - The attempt, exact capabilities and original deadline.
 * @returns Nothing; the owned report travels through the outbound handler.
 * @throws {never} Never; failures are logged and reported against the original attempt.
 */
export async function runPlanJob(job: PlanRunBody): Promise<void> {
  const remaining = job.deadlineAt - Date.now();
  const signal = remaining <= 0 ? AbortSignal.abort(new DOMException("Planned job deadline passed", "AbortError")) : AbortSignal.timeout(remaining);
  const completed: PlanContainerOutput[] = [];
  const cache = new Map<string, LocalPlanInput>();
  let directory: string | undefined;
  let outputIndex: number | undefined;
  let ok = false;
  let reason: ContainerFailure = "tool_failed";
  try {
    signal.throwIfAborted();
    const bindings = new Map(job.inputs.map((input) => [input.inputId, input.url]));
    if (bindings.size !== job.inputs.length || job.outputs.some((output) => !bindings.has(output.recipe.inputId))) throw new Error("Planned recipe has an ambiguous or unbound input");
    directory = await mkdtemp(join(tmpdir(), "mini-tool-plan-"));
    for (const output of job.outputs) {
      outputIndex = output.outputIndex;
      signal.throwIfAborted();
      const url = bindings.get(output.recipe.inputId)!;
      let input = cache.get(url);
      if (input === undefined) {
        const file = join(directory, `source-${cache.size}`);
        try { await download(url, file, signal); }
        catch (error) { reason = "internal"; throw error; }
        input = { file, facts: await inspectPlanInput(file, signal, job.limits) };
        cache.set(url, input);
      }
      const file = join(directory, `output-${output.outputIndex}`);
      const metadata = await executePlanRecipe({ recipe: output.recipe, input: input.file, output: file, directory, facts: input.facts, signal, limits: job.limits });
      try { await put(output.url, file, signal); }
      catch (error) { reason = "internal"; throw error; }
      const cover = output.coverUrl !== undefined && metadata.width !== null
        ? await writeCover({ coverUrl: output.coverUrl, file }, directory, signal, job.limits) : null;
      completed.push({ outputIndex: output.outputIndex, storageKey: output.key, ...metadata, cover });
    }
    ok = true;
  } catch (error) {
    console.error("mini_tool_plan_run_failed", { attemptId: job.attemptId, outputIndex, err: error instanceof Error ? error.message : String(error) });
  } finally {
    if (directory !== undefined) {
      try { await rm(directory, { recursive: true, force: true }); }
      catch (error) { console.error("mini_tool_plan_cleanup_failed", { attemptId: job.attemptId, err: String(error) }); }
    }
  }
  try {
    const response = await fetch(job.reportUrl, {
      method: "POST", signal, headers: { "content-type": "application/json" },
      body: JSON.stringify({ schemaVersion: 2, attemptId: job.attemptId, ok, cpuUsec: await cpuUsec(), outputs: completed, ...(!ok && { reason }) }),
    });
    await response.body?.cancel();
    if (!response.ok) throw new Error(`Planned report was answered ${response.status}`);
  } catch (error) {
    console.error("mini_tool_plan_report_failed", { attemptId: job.attemptId, err: error instanceof Error ? error.message : String(error) });
  }
}
