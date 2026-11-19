// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The render container's run (#1490 design §6.2): read the source package through `r2.local`, render it with the
 * HyperFrames producer at its frozen frame and length, check what ffprobe measures of the video, cut the first frame
 * as the cover, write both back through `r2.local` and report through `jobs.local`.
 */

import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  WebAnimationRenderProgressBody,
  WebAnimationRenderReportBody,
  WebAnimationRenderRunBody,
} from "@ingest/jobs/web-animation-run-body.js";

import { cpuUsec } from "./run-steps.js";

/** Where the image keeps what a render needs. */
export interface WebAnimationRenderSettings {
  /** The font sets, one directory per version. */
  fontsDir: string;
  ffmpegBin: string;
  ffprobeBin: string;
}

/** What ffprobe measured of a rendered video. */
export interface RenderedVideo {
  frames: number | null;
  width: number;
  height: number;
}

/** A render that ended with a reason the report names. */
class RenderStopped extends Error {
  /**
   * Name the reason.
   * @param reason - The failure reason.
   * @param detail - What went wrong.
   */
  constructor(readonly reason: string, detail: string) {
    super(detail);
    this.name = "RenderStopped";
  }
}

/** The producer as this runner calls it; it is installed in the image, beside the bundle. */
interface Producer {
  createRenderJob(options: { width: number; height: number; fps: number; quality: string; format: "mp4" }): unknown;
  executeRenderJob(job: unknown, projectDir: string, outputPath: string, onProgress?: (...args: unknown[]) => void): Promise<unknown>;
}

const PRODUCER_MODULE = "@hyperframes/producer";

/**
 * Judge the rendered video against the export: exactly the frozen frame count, width and height.
 * @param probe - What ffprobe measured.
 * @param expected - What the export froze.
 * @param expected.durationFrames - The frame count.
 * @param expected.width - The width.
 * @param expected.height - The height.
 * @returns Null when it matches, `frame_mismatch` otherwise.
 * @throws {never} Never.
 */
export function judgeWebAnimationRender(probe: RenderedVideo, expected: { durationFrames: number; width: number; height: number }): "frame_mismatch" | null {
  if (probe.frames !== expected.durationFrames || probe.width !== expected.width || probe.height !== expected.height) return "frame_mismatch";
  return null;
}

/**
 * Mark every composition host `data-no-timeline`. The runner's packages animate with CSS and the Web Animations API
 * and never register `window.__timelines`, so without the mark the producer waits 45 s per host before it renders.
 * Scripts, styles and comments are skipped, so a selector or string in the inlined runtime is never taken for a host.
 * @param html - The source package.
 * @returns The package with each unmarked host marked.
 * @throws {never} Never.
 */
export function markCompositionsWithoutTimeline(html: string): string {
  const masked = html.replace(/<!--[\s\S]*?-->|<(script|style)\b[\s\S]*?<\/\1\s*>/gi, (block) => " ".repeat(block.length));
  let marked = "";
  let from = 0;
  for (const tag of masked.matchAll(/<[a-z][\w-]*[^<>]*>/gi)) {
    if (!/\sdata-composition-id(?=[\s=>/])/i.test(tag[0]) || /\sdata-no-timeline(?=[\s=>/])/i.test(tag[0])) continue;
    const at = tag.index + tag[0].search(/[\s/>]/);
    marked += `${html.slice(from, at)} data-no-timeline`;
    from = at;
  }
  return marked + html.slice(from);
}

/**
 * Run a program and collect what it printed.
 * @param bin - The program.
 * @param args - Its arguments.
 * @returns Its stdout.
 * @throws {Error} When it exits other than 0.
 */
function exec(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk: Buffer) => { out += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { err += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`${bin} exited ${String(code)}: ${err.slice(-500)}`))));
  });
}

/**
 * Measure a video's frame count, size and length.
 * @param ffprobe - The ffprobe binary.
 * @param path - The video.
 * @returns What it measured.
 * @throws {Error} When ffprobe fails.
 */
async function probeVideo(ffprobe: string, path: string): Promise<RenderedVideo & { durationSeconds: number }> {
  const out = JSON.parse(await exec(ffprobe, [
    "-v", "error", "-select_streams", "v:0", "-count_frames",
    "-show_entries", "stream=nb_read_frames,width,height", "-show_entries", "format=duration", "-of", "json", path,
  ])) as { streams?: Array<{ nb_read_frames?: string; width?: number; height?: number }>; format?: { duration?: string } };
  const stream = out.streams?.[0];
  const frames = Number(stream?.nb_read_frames);
  return {
    frames: Number.isInteger(frames) ? frames : null,
    width: stream?.width ?? 0,
    height: stream?.height ?? 0,
    durationSeconds: Number(out.format?.duration ?? 0),
  };
}

/**
 * Measure a picture's size.
 * @param ffprobe - The ffprobe binary.
 * @param path - The picture.
 * @returns Its width and height.
 * @throws {Error} When ffprobe fails.
 */
async function probeImage(ffprobe: string, path: string): Promise<{ width: number; height: number }> {
  const out = JSON.parse(await exec(ffprobe, ["-v", "error", "-show_entries", "stream=width,height", "-of", "json", path])) as {
    streams?: Array<{ width?: number; height?: number }>;
  };
  return { width: out.streams?.[0]?.width ?? 0, height: out.streams?.[0]?.height ?? 0 };
}

/**
 * Send JSON to the Worker's report host; a failed post is logged, because the report is the only path left.
 * @param url - Where.
 * @param body - What.
 * @returns Nothing.
 */
async function post(url: string, body: WebAnimationRenderProgressBody | WebAnimationRenderReportBody): Promise<void> {
  const answered = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
    .catch((err: unknown) => err);
  if (!(answered instanceof Response) || !answered.ok) {
    console.error("web_animation_render_post_failed", { url, answered: answered instanceof Response ? answered.status : String(answered) });
  }
}

/**
 * Write one output through `r2.local`.
 * @param url - Where.
 * @param bytes - The bytes.
 * @param contentType - What they are.
 * @returns Nothing.
 * @throws {RenderStopped} `save_failed` when the Worker does not take it.
 */
async function put(url: string, bytes: Buffer, contentType: string): Promise<void> {
  const answered = await fetch(url, { method: "PUT", headers: { "content-type": contentType }, body: new Uint8Array(bytes) });
  if (!answered.ok) throw new RenderStopped("save_failed", `the write of ${url} was answered ${answered.status}`);
}

/**
 * Render one export and report it.
 * @param job - The run.
 * @param settings - Where the image keeps the font sets and ffmpeg.
 * @returns Nothing; the outcome travels in the report.
 */
export async function runWebAnimationRender(job: WebAnimationRenderRunBody, settings: WebAnimationRenderSettings): Promise<void> {
  const work = await mkdtemp(join(tmpdir(), "web-animation-render-"));
  let report: WebAnimationRenderReportBody = { ok: false, failureReason: "internal", cpuUsec: null, video: null, cover: null };
  try {
    const source = await fetch(job.packageUrl, { method: "GET" });
    if (!source.ok) throw new RenderStopped("render_failed", `the package was answered ${source.status}`);
    const project = join(work, "project");
    await mkdir(project, { recursive: true });
    await writeFile(join(project, "index.html"), markCompositionsWithoutTimeline(await source.text()));
    // The package's stylesheet names `../fonts/v<n>/`, which the producer's server serves from the project's root.
    await cp(join(settings.fontsDir, `v${job.fontSetVersion}`), join(project, "fonts", `v${job.fontSetVersion}`), { recursive: true });

    await post(job.progressUrl, { phase: "rendering", progress: 0 });
    const producer = (await import(PRODUCER_MODULE)) as Producer;
    const videoPath = join(work, "out.mp4");
    let reported = 0;
    try {
      const render = producer.createRenderJob({ width: job.width, height: job.height, fps: job.fps.num / job.fps.den, quality: job.quality, format: "mp4" });
      await producer.executeRenderJob(render, project, videoPath, (...args: unknown[]) => {
        const fraction = args.find((arg): arg is number => typeof arg === "number" && arg >= 0 && arg <= 1);
        if (fraction === undefined || fraction - reported < 0.05) return;
        reported = fraction;
        void post(job.progressUrl, { phase: "rendering", progress: fraction });
      });
    } catch (err) {
      throw new RenderStopped("render_failed", String(err));
    }

    const video = await probeVideo(settings.ffprobeBin, videoPath);
    const mismatch = judgeWebAnimationRender(video, job);
    if (mismatch !== null) throw new RenderStopped(mismatch, `rendered ${String(video.frames)} frames at ${video.width}x${video.height}`);
    const coverPath = join(work, "cover.png");
    await exec(settings.ffmpegBin, ["-v", "error", "-i", videoPath, "-frames:v", "1", coverPath]);
    const cover = await probeImage(settings.ffprobeBin, coverPath);

    await post(job.progressUrl, { phase: "saving", progress: 1 });
    await put(job.videoUrl, await readFile(videoPath), "video/mp4");
    await put(job.coverUrl, await readFile(coverPath), "image/png");
    report = { ok: true, failureReason: null, cpuUsec: null, video: { width: video.width, height: video.height, durationSeconds: video.durationSeconds }, cover };
  } catch (err) {
    console.error("web_animation_render_failed", String(err));
    report = { ...report, ok: false, failureReason: err instanceof RenderStopped ? err.reason : "internal" };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  await post(job.reportUrl, { ...report, cpuUsec: await cpuUsec() });
}
