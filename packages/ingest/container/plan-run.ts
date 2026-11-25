// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { miniToolPlanRecipeInputs, type MiniToolPlanRecipe } from "@shared/upload/mini-tool-plan-types.js";
import type { ContainerFailure } from "@shared/mini-tools/types.js";
import type { PlanContainerCount, PlanContainerOutput, MediaOfOutput } from "@ingest/jobs/container-report.js";
import { countPresentationGrid, executePresentationRecipe, type PlanLimits } from "@ingest/container/presentation-recipes.js";
import { runPlanCommand } from "@ingest/container/plan-command.js";
import { download, put, putStream } from "@ingest/container/mini-tool-run.js";
import { readServedObject } from "@ingest/container/served-object-read.js";
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
 * The inputs a recipe reads through the loopback reader: every bound input except a stitch's chunks, which the concat
 * demuxer reads as local files and which together are about the size of the file the stitch writes.
 * @param recipe - The recipe.
 * @returns The input ids read in place.
 * @throws {never} Never.
 */
function servedInputs(recipe: MiniToolPlanRecipe): string[] {
  const chunks = new Set(recipe.kind === "stitch" ? recipe.chunks.map((chunk) => chunk.inputId) : []);
  return miniToolPlanRecipeInputs(recipe).filter((id) => !chunks.has(id));
}

/**
 * Run a read with each served input open through its own loopback reader (`readServedObject`), the way long-media
 * segments read their source: FFmpeg keeps its seeks, a dropped connection resumes with a Range request, and an answer
 * that cannot be completed fails the read whatever FFmpeg's exit says.
 * @param served - The input ids and the URLs the Worker serves them at, in order.
 * @param signal - The read's lifetime.
 * @param read - The read, given each input's loopback URL by id.
 * @returns What the read returned.
 * @throws {Error} `The stream read failed: ...` when a source answer could not be completed; what the read throws otherwise.
 */
async function withServedInputs<T>(served: readonly { id: string; url: string }[], signal: AbortSignal, read: (local: Map<string, string>) => Promise<T>): Promise<T> {
  /**
   * Open the next input inside the previous one's reader.
   * @param at - The next input's position.
   * @param local - The loopback URLs opened so far.
   * @returns What the read returned.
   */
  const open = (at: number, local: Map<string, string>): Promise<T> => {
    const next = served[at];
    if (next === undefined) return read(local);
    return readServedObject(next.url, signal, (url) => open(at + 1, new Map([...local, [next.id, url]])));
  };
  return open(0, new Map());
}

/**
 * Whether an error is the loopback reader's failed source read (`readServedObject`), which is ours, not the file's.
 * @param error - The error.
 * @returns True for a source read that could not be completed.
 * @throws {never} Never.
 */
function sourceReadFailed(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("The stream read failed");
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
     * Download a stitch chunk once per invocation.
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
      const count = job.count;
      try { counted = await withServedInputs([{ id: count.inputId, url: bindings.get(count.inputId)! }], signal, (inputs) => countPresentationGrid({ recipe: count, inputs, directory: workDirectory, signal, limits: job.limits })); }
      catch (error) { if (sourceReadFailed(error)) reason = "internal"; throw error; }
    }
    for (const output of job.outputs) {
      outputIndex = output.outputIndex;
      signal.throwIfAborted();
      const recipe = output.recipe;
      const file = join(directory, `output-${output.outputIndex}`);
      // Every recipe carries the grid frame numbers the worker wrote from the frozen plan; the container reads no frame table (§7.17).
      const served = servedInputs(recipe);
      const chunks = new Map<string, string>();
      for (const id of named(recipe)) if (!served.includes(id)) chunks.set(id, await fetchInput(id));
      // A recipe that streams its output uploads it while it runs; every other recipe leaves its output file to send here.
      let streamed = false;
      let streamFailure: unknown;
      /**
       * Upload this output while its recipe writes it.
       * @param body - The output stream.
       * @returns Nothing once stored.
       * @throws {Error} When the write fails.
       */
      const upload = async (body: Readable): Promise<void> => {
        streamed = true;
        try { await putStream(output.url, body, signal); }
        catch (error) { streamFailure = error; throw error; }
      };
      let metadata: MediaOfOutput;
      try {
        metadata = await withServedInputs(served.map((id) => ({ id, url: bindings.get(id)! })), signal,
          (opened) => executePresentationRecipe({ inputs: new Map([...chunks, ...opened]), output: file, directory: workDirectory, signal, limits: job.limits, recipe, upload }));
      } catch (error) { if (error === streamFailure || sourceReadFailed(error)) reason = "internal"; throw error; }
      if (!streamed) {
        try { await put(output.url, file, signal); }
        catch (error) { reason = "internal"; throw error; }
      }
      const cover = !streamed && output.coverUrl !== undefined && metadata.width !== null
        ? await writeCover({ coverUrl: output.coverUrl, file }, directory, signal, job.limits) : null;
      // A stored output leaves the disk before the next one is encoded, so the run directory holds one output at a time.
      await rm(file, { force: true });
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
