// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

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

import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import type { ContainerOp } from "@shared/mini-tools/types.js";
import { opRuns } from "@ingest/jobs/op-args.js";
import { pickMediaMetadata, NOTHING_FOUND } from "@ingest/media-metadata.js";
import { coverArgs, probeArgs, readProbeOutput } from "@ingest/probe-command.js";
import { pngSize } from "@ingest/png-size.js";

/** What the Durable Object sends to `/run`. */
export interface RunBody {
  op: ContainerOp;
  params: Record<string, unknown>;
  input: string;
  outputs: { url: string; key: string; coverUrl?: string }[];
  reportUrl: string;
  toolTimeoutMs: number;
}

/** The most a cover frame may weigh. */
const COVER_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Run one tool to completion.
 * @param program - `ffmpeg` or `ffprobe`.
 * @param args - Its arguments.
 * @param timeoutMs - How long it may run.
 * @param maxBytes - The most stdout may hold.
 * @returns What it wrote to stdout.
 * @throws {Error} When it fails, times out or writes too much.
 */
function runTool(program: string, args: string[], timeoutMs: number, maxBytes = 4 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(program, args, { encoding: "buffer", maxBuffer: maxBytes, timeout: timeoutMs }, (error, stdout, stderr) => {
      if (error !== null) {
        reject(new Error(`${program} failed: ${error.message} ${stderr.toString("utf8").slice(0, 2000)}`));
        return;
      }
      resolve(stdout);
    });
  });
}

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
  } as RequestInit);
  if (!answered.ok) throw new Error(`the write of ${url} was answered ${answered.status}`);
}

/**
 * The CPU time the container's cgroup has counted.
 * @returns Microseconds, or null when the file is not there to read.
 */
async function cpuUsec(): Promise<number | null> {
  const stats = await readFile("/sys/fs/cgroup/cpu.stat", "utf8").catch(() => null);
  const line = stats?.split("\n").find((entry) => entry.startsWith("usage_usec "));
  const value = line === undefined ? NaN : Number(line.split(" ")[1]);
  return Number.isFinite(value) ? value : null;
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
  try {
    for (const output of job.outputs) {
      const file = join(dir, "out.mp4");
      for (const args of opRuns(job.op, job.params, job.input, file, dir)) {
        await runTool("ffmpeg", args, job.toolTimeoutMs);
      }
      await put(output.url, file);

      const probed = await runTool("ffprobe", probeArgs(file), job.toolTimeoutMs).catch(() => null);
      const numbers = pickMediaMetadata(probed === null ? NOTHING_FOUND : readProbeOutput(probed.toString("utf8")));
      let cover: { width: number | null; height: number | null } | null = null;
      if (output.coverUrl !== undefined && numbers.width !== null) {
        const frame = await runTool("ffmpeg", coverArgs(file), job.toolTimeoutMs, COVER_MAX_BYTES).catch(() => null);
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
    body: JSON.stringify({ ok, cpuUsec: await cpuUsec(), media }),
  }).catch((err: unknown) => console.error("mini_tool_report_failed", { err: String(err) }));
}
