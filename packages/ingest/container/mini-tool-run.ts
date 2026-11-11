// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * One mini-tool run inside the container (inner#888 §8.1 step 4).
 *
 * The source is read over HTTP from a hostname the Worker intercepts, the
 * output is written to a local file and then sent back the same way, and the
 * Worker hashes and types it at the edge as it lands. The media numbers and
 * the cover are read here, off the file just written, so no second container
 * is started for them. The run reports how it went last, with the CPU time
 * the container's cgroup counted.
 */

import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

import type { ContainerFailure, ContainerOp } from "@shared/mini-tools/types.js";
import { clipRefusal, inputRefusal, lengthArgs, mediumOf, opSteps, outputFileName, outputRefusal, readProgressLength, type ExtraInput } from "@ingest/jobs/op-args.js";
import { pickMediaMetadata, NOTHING_FOUND, type ProbeReport } from "@ingest/media-metadata.js";
import { coverArgs, probeArgs, readProbeOutput } from "@ingest/probe-command.js";
import { pngSize } from "@ingest/png-size.js";

import { cpuUsec, runCommand, runSteps } from "./run-steps.js";

/** What the Durable Object sends to `/run`. */
export interface RunBody {
  op: ContainerOp;
  params: Record<string, unknown>;
  input: string;
  /** The inputs after the source, in order: a join's further clips (inner#1825 §6.4). */
  extra?: string[];
  outputs: { url: string; key: string; coverUrl?: string }[];
  reportUrl: string;
}

/** The most a cover frame may weigh. */
const COVER_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Send a local file to the Worker.
 * @param url - Where it goes.
 * @param file - The file.
 * @returns Nothing.
 * @throws {Error} When the Worker does not take it.
 */
async function put(url: string, file: string): Promise<void> {
  const size = (await stat(file)).size;
  const answered = await fetch(url, {
    method: "PUT",
    headers: { "content-length": String(size) },
    body: Readable.toWeb(createReadStream(file)) as ReadableStream<Uint8Array>,
    duplex: "half",
  });
  if (!answered.ok) throw new Error(`the write of ${url} was answered ${answered.status}`);
}

/** The operations that lay clips end to end by their lengths. */
const JOINS: ReadonlySet<ContainerOp> = new Set<ContainerOp>(["join", "audio_join"]);

/**
 * Download the source into the job's directory, whole, before any run reads it.
 * @param url - Where the Durable Object serves the source.
 * @param file - The local copy to write.
 * @throws {Error} When the answer is not 200 or fewer bytes arrive than it announced.
 */
async function download(url: string, file: string): Promise<void> {
  const answered = await fetch(url);
  if (!answered.ok || answered.body === null) throw new Error(`the read of ${url} was answered ${answered.status}`);
  await pipeline(Readable.fromWeb(answered.body as NodeReadableStream<Uint8Array>), createWriteStream(file));
  const announced = Number(answered.headers.get("content-length"));
  const arrived = (await stat(file)).size;
  if (Number.isFinite(announced) && announced > 0 && arrived !== announced) {
    throw new Error(`the read of ${url} stopped at ${arrived} of ${announced} bytes`);
  }
}

/**
 * Run one job and report it.
 * @param job - The job.
 * @returns Nothing; the outcome travels in the report.
 */
export async function runJob(job: RunBody): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "mini-tool-"));
  const media: Record<string, unknown> = {};
  let ok = false;
  let reason: ContainerFailure | undefined;
  try {
    // Moving bytes in and out is ours; a failure there is internal, not the file's.
    const ours = (err: unknown): never => {
      reason = "internal";
      throw err;
    };
    /**
     * Download one input and probe it, refusing one the operation cannot take.
     * @param url - Where the Durable Object serves it.
     * @param file - The local copy to write.
     * @param first - Whether it is the source.
     * @returns Its probe.
     * @throws {Error} When the download fails or the input is refused.
     */
    const fetched = async (url: string, file: string, first: boolean): Promise<ProbeReport> => {
      await download(url, file).catch(ours);
      const probed = readProbeOutput((await runCommand("ffprobe", probeArgs(file, "own-file"))).stdout.toString("utf8"));
      const refused = (first ? inputRefusal(job.op, probed) : null) ?? clipRefusal(job.op, probed);
      if (refused !== null) {
        reason = refused;
        throw new Error(`input refused: ${refused}`);
      }
      if (!JOINS.has(job.op) || probed.durationSeconds !== null) return probed;
      // A join lays clips end to end by their lengths; a container that states
      // none (a browser recorder's WebM) is read through to learn it.
      const measured = readProgressLength((await runCommand("ffmpeg", lengthArgs(file))).stdout.toString("utf8"));
      if (measured === null) {
        reason = "tool_failed";
        throw new Error("input refused: a clip's length cannot be read");
      }
      return { ...probed, durationSeconds: measured };
    };
    const input = join(dir, "source");
    const source = await fetched(job.input, input, true);
    const extra: ExtraInput[] = [];
    for (const [i, url] of (job.extra ?? []).entries()) {
      const path = join(dir, `source-${i + 1}`);
      extra.push({ path, probe: await fetched(url, path, false) });
    }
    for (const output of job.outputs) {
      const file = join(dir, outputFileName(job.op));
      // An operation runs as long as its job's deadline allows; the Durable
      // Object destroys the container when that passes.
      await runSteps(opSteps(job.op, job.params, input, file, dir, source, extra));
      const probed = await runCommand("ffprobe", probeArgs(file, "own-file")).then((out) => out.stdout, () => null);
      const report = probed === null ? NOTHING_FOUND : readProbeOutput(probed.toString("utf8"));
      const empty = outputRefusal(report, mediumOf(job.op));
      if (empty !== null) {
        reason = empty;
        throw new Error(`output refused: ${empty}`);
      }
      await put(output.url, file).catch(ours);
      const numbers = pickMediaMetadata(report);
      let cover: { width: number | null; height: number | null } | null = null;
      if (output.coverUrl !== undefined && numbers.width !== null) {
        const frame = await runCommand("ffmpeg", coverArgs(file, "own-file"), COVER_MAX_BYTES).then((out) => out.stdout, () => null);
        if (frame !== null && frame.length > 0) {
          const coverFile = join(dir, "cover.png");
          await writeFile(coverFile, frame);
          // A cover that does not land leaves the output standing (storage rule ③).
          const landed = await put(output.coverUrl, coverFile).then(() => true, () => false);
          const size = pngSize(new Uint8Array(frame));
          if (landed) cover = { width: size?.width ?? null, height: size?.height ?? null };
        }
      }
      media[output.key] = { ...numbers, cover };
    }
    ok = true;
  } catch (err) {
    console.error("mini_tool_run_failed", { op: job.op, err: err instanceof Error ? err.message : String(err) });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  await fetch(job.reportUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ok, cpuUsec: await cpuUsec(), media, ...(reason !== undefined && { reason }) }),
  }).catch((err: unknown) => console.error("mini_tool_report_failed", { err: String(err) }));
}
