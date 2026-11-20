// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { miniToolPlanRecipeInputs, type MiniToolPlanRecipe } from "@shared/upload/mini-tool-plan-types.js";
import type { ContainerFailure } from "@shared/mini-tools/types.js";
import type { PlanContainerCount, PlanContainerOutput, MediaOfOutput } from "@ingest/jobs/container-report.js";
import { countPresentationGrid, executePresentationRecipe, type PlanLimits } from "@ingest/container/presentation-recipes.js";
import { runPlanCommand } from "@ingest/container/plan-command.js";
import { download, put } from "@ingest/container/mini-tool-run.js";
import { cpuUsec } from "@ingest/container/run-steps.js";
import { coverArgs, probeArgs, readProbeOutput } from "@ingest/probe-command.js";
import { pngSize } from "@ingest/png-size.js";

/** The internal, attempt-bound run sent by the validated job object; a grid count names its recipe as `count` and has no output. */
export interface PlanRunBody {
  schemaVersion: 2;
  attemptId: string;
  deadlineAt: number;
  limits: PlanLimits;
  inputs: { inputId: string; url: string }[];
  outputs: { outputIndex: number; key: string; url: string; contentType: string; coverUrl?: string; recipe: MiniToolPlanRecipe }[];
  count?: Extract<MiniToolPlanRecipe, { kind: "grid_count" }>;
  reportUrl: string;
}
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
    const options = { signal, stdoutBytes: limits.analysisStdoutBytes, stderrTailBytes: limits.stderrTailBytes };
    const report = readProbeOutput((await runPlanCommand("ffprobe", probeArgs(output.file, "own-file"), options)).toString("utf8"));
    const bytes = await runPlanCommand("ffmpeg", coverArgs(output.file, "own-file", report), options);
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
  let counted: PlanContainerCount | undefined;
  const files = new Map<string, string>();
  let directory: string | undefined;
  let outputIndex: number | undefined;
  let ok = false;
  let reason: ContainerFailure = "tool_failed";
  try {
    signal.throwIfAborted();
    const bindings = new Map(job.inputs.map((input) => [input.inputId, input.url]));
    const named = miniToolPlanRecipeInputs;
    const recipes = [...job.outputs.map((output) => output.recipe), ...(job.count === undefined ? [] : [job.count])];
    if (bindings.size !== job.inputs.length || recipes.some((recipe) => named(recipe).some((id) => !bindings.has(id)))) throw new Error("Planned recipe has an ambiguous or unbound input");
    const workDirectory = await mkdtemp(join(tmpdir(), "mini-tool-plan-"));
    directory = workDirectory;
    /**
     * Download a bound input once per invocation.
     * @param inputId - The bound input.
     * @returns Its local file.
     * @throws {Error} When the download fails, reported as internal.
     */
    const fetchInput = async (inputId: string): Promise<string> => {
      const url = bindings.get(inputId)!;
      let file = files.get(url);
      if (file === undefined) {
        file = join(workDirectory, `source-${files.size}`);
        try { await download(url, file, signal); }
        catch (error) { reason = "internal"; throw error; }
        files.set(url, file);
      }
      return file;
    };
    if (job.count !== undefined) {
      // §7.17 grid_count: decode the one input and report the count; no object is written.
      const inputs = new Map([[job.count.inputId, await fetchInput(job.count.inputId)]]);
      counted = await countPresentationGrid({ recipe: job.count, inputs, directory, signal, limits: job.limits });
    }
    for (const output of job.outputs) {
      outputIndex = output.outputIndex;
      signal.throwIfAborted();
      const recipe = output.recipe;
      const file = join(directory, `output-${output.outputIndex}`);
      // Every recipe carries the grid frame numbers the worker wrote from the frozen plan; the container reads no frame table (§7.17).
      const inputs = new Map<string, string>();
      for (const id of named(recipe)) inputs.set(id, await fetchInput(id));
      const request = { inputs, output: file, directory, signal, limits: job.limits };
      const metadata = await executePresentationRecipe({ ...request, recipe });
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
      body: JSON.stringify({ schemaVersion: 2, attemptId: job.attemptId, ok, cpuUsec: await cpuUsec(), outputs: completed,
        ...(ok && counted !== undefined && { count: counted }), ...(!ok && { reason }) }),
    });
    await response.body?.cancel();
    if (!response.ok) throw new Error(`Planned report was answered ${response.status}`);
  } catch (error) {
    console.error("mini_tool_plan_report_failed", { attemptId: job.attemptId, err: error instanceof Error ? error.message : String(error) });
  }
}
