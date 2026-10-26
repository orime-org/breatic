// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The media container's whole service (#209 + #210, design §4.2).
 *
 * Two endpoints. The probe runs ffprobe over the object it was handed, lifts
 * a cover frame with ffmpeg when asked for one, cuts a preview with vips when
 * asked for one and there is still time, reads an audio object's peaks when
 * asked for them, and answers with all of it. The run
 * takes one mini-tool job (inner#888), answers 202, and reports on its own
 * when the job ends. It decides nothing about
 * what the media is: which stream carries the dimensions and whether a cover
 * is wanted are the caller's judgements, made where the stored bytes have
 * already been read.
 *
 * It reads the object over plain HTTP from a hostname the Worker intercepts,
 * so it holds no credentials and has no route to the internet. The Worker
 * serves exactly the one key this run is about (`serveOneObject`). When the
 * probe carries an upright order, the picture is first turned with vips, the
 * turned picture is probed and previewed, and it is PUT to `upright.local`,
 * which the Worker accepts for this run's one upright key only.
 *
 * Bundled into one file at image build time, which is why it imports from the
 * Worker's source: the argument lists and the answer format are one agreement
 * between the two sides, and a second copy in here would drift from it.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
  buildProbeAnswer,
  PROBE_PATH,
  PROBE_PORT,
} from "@ingest/probe-answer.js";
import {
  PREVIEW_MAX_BYTES,
  PROBE_MAX_BYTES,
  peaksArgs,
  probeArgs,
  coverArgs,
  previewArgs,
  agentPictureArgs,
  readProbeOutput,
} from "@ingest/probe-command.js";
import { peaksSampleCount } from "@ingest/peaks-step.js";
import { previewSource } from "@ingest/preview-step.js";
import type { UprightOrder } from "@ingest/upright-run.js";
import { runUpright, type UprightDeps } from "./upright-probe.js";
import { openObject, runTool } from "./run-tool.js";
import { streamPeaks } from "./stream-peaks.js";
import { NOTHING_FOUND, pickMediaMetadata } from "@ingest/media-metadata.js";
import type { ProbeReport } from "@ingest/media-metadata.js";
import type { ProbeRequest } from "@ingest/probe-answer.js";
import { RUN_PATH } from "@ingest/jobs/op-args.js";
import { runJob, type RunBody } from "./mini-tool-run.js";

/**
 * The most a cover frame may weigh.
 *
 * One PNG frame of an ordinary video is well under this. A frame that is not —
 * an enormous resolution, a crafted file — stops here rather than being sent
 * to the Worker and stored.
 */
const COVER_MAX_BYTES = 10 * 1024 * 1024;

/** One run's request as it arrives: read before it is believed. */
type IncomingRequest = Partial<Record<keyof ProbeRequest, unknown>>;

/**
 * Probe one object, and lift a cover frame when one is wanted and there is a
 * stream to lift it from.
 * @param objectUrl - Where to read it.
 * @param wantCover - Whether the caller wants a frame.
 * @param signal - The run's deadline.
 * @returns What ffprobe found and the frame, when there is one.
 */
async function probe(
  objectUrl: string,
  wantCover: boolean,
  signal: AbortSignal,
): Promise<{ report: ProbeReport; cover: Uint8Array | null }> {
  const probed = await runTool("ffprobe", probeArgs(objectUrl), {
    maxBytes: PROBE_MAX_BYTES,
    signal,
  });
  const report =
    probed === null
      ? NOTHING_FOUND
      : readProbeOutput(probed.toString("utf8"));

  // Nothing to lift a frame from: an audio file with no art, or one whose only
  // video stream is attached album art. `pickMediaMetadata` is the one place
  // that judgement is made. An image passes this check — it probes as an
  // ordinary video stream and needs its width read the same way; what keeps it
  // out of cover cutting is `wantCover`, decided from what the stored bytes
  // read as.
  const hasFrame = pickMediaMetadata(report).width !== null;
  if (!wantCover || !hasFrame) return { report, cover: null };

  const cut = await runTool("ffmpeg", coverArgs(objectUrl), {
    maxBytes: COVER_MAX_BYTES,
    signal,
  });
  return { report, cover: cut === null ? null : new Uint8Array(cut) };
}

/**
 * Cut a preview, when `previewSource` says what from.
 * @param asked - What this run was asked.
 * @param found - What the probe and the cover call produced.
 * @param found.report - What ffprobe found.
 * @param found.cover - The cover frame, when one was cut.
 * @param signal - The run's deadline, shared by the read and vips so a read
 *   cut off by it never hands vips a short picture.
 * @returns The WebP bytes, or null when none was cut.
 */
async function cutPreview(
  asked: ProbeRequest,
  found: { report: ProbeReport; cover: Uint8Array | null },
  signal: AbortSignal,
): Promise<Uint8Array | null> {
  // One reading of the clock decides whether there is time left for a preview.
  const clock = { deadlineAt: asked.deadlineAt, now: Date.now() };
  const source = previewSource({
    wantPreview: asked.wantPreview,
    wantCover: asked.wantCover,
    cover: found.cover,
    report: found.report,
    ...clock,
  });
  if (source === "late") {
    // The deadline has come and the Worker has stopped waiting, so no preview
    // is cut; the backfill cuts it later.
    console.error("media_preview_skipped_deadline", {
      leftMs: clock.deadlineAt - clock.now,
    });
    return null;
  }
  if (source === null) return null;
  const input =
    source === "cover" ? found.cover : await openObject(asked.objectUrl, signal);
  if (input === null) return null;
  const cut = await runTool("vips", previewArgs(), {
    maxBytes: PREVIEW_MAX_BYTES,
    signal,
    input,
  });
  return cut === null ? null : new Uint8Array(cut);
}

/**
 * Read an upright order off the request, when it carries a whole one.
 * @param sent - What arrived.
 * @returns The order, or null.
 */
function uprightOrderOf(sent: unknown): UprightOrder | null {
  if (typeof sent !== "object" || sent === null) return null;
  const order = sent as Partial<Record<keyof UprightOrder, unknown>>;
  if (
    typeof order.writeUrl !== "string" ||
    typeof order.contentType !== "string" ||
    typeof order.lossless !== "boolean" ||
    typeof order.quality !== "number" ||
    typeof order.maxBytes !== "number"
  ) {
    return null;
  }
  return {
    writeUrl: order.writeUrl,
    contentType: order.contentType,
    lossless: order.lossless,
    quality: order.quality,
    maxBytes: order.maxBytes,
  };
}

/**
 * Read the supported JPEG specification at the container boundary.
 * @param sent - Untrusted decoded request field.
 * @returns The complete version-one specification, when valid.
 * @throws {never} Never.
 */
function pictureSpecOf(sent: unknown): ProbeRequest["agentPicture"] {
  if (typeof sent !== "object" || sent === null) return undefined;
  const spec = sent as Record<string, unknown>;
  if (spec.version !== 1 || typeof spec.longEdge !== "number" || !Number.isInteger(spec.longEdge) || spec.longEdge < 1 ||
    typeof spec.quality !== "number" || !Number.isInteger(spec.quality) || spec.quality < 1 || spec.quality > 100) return undefined;
  return { version: 1, longEdge: spec.longEdge, quality: spec.quality };
}

/**
 * Produce the separate static JPEG directly from the authorized object stream.
 * @param request - The authorized source and specification.
 * @param signal - Original media-task deadline.
 * @returns JPEG bytes or none when generation failed or was not requested.
 * @throws {never} Tool and source failures are recorded by their boundaries.
 */
async function cutAgentPicture(request: ProbeRequest, signal: AbortSignal): Promise<Uint8Array | null> {
  if (request.agentPicture === undefined || signal.aborted) return null;
  const input = await openObject(request.objectUrl, signal);
  if (input === null) return null;
  const cut = await runTool("vips", agentPictureArgs(request.agentPicture), {
    input, signal, maxBytes: PREVIEW_MAX_BYTES,
  });
  return cut === null ? null : new Uint8Array(cut);
}

/** What an upright run reaches out to, in this container. */
const UPRIGHT_DEPS: UprightDeps = {
  openObject,
  runTool,
  writeTemp: async (bytes) => {
    const dir = await mkdtemp(join(tmpdir(), "upright-"));
    const path = join(dir, "picture");
    await writeFile(path, bytes);
    return { path, remove: () => rm(dir, { recursive: true, force: true }) };
  },
  put: async (url, headers, body) => {
    try {
      const answered = await fetch(url, { method: "PUT", headers, body });
      await answered.body?.cancel();
      if (answered.status !== 200) console.error("media_upright_write_refused", { status: answered.status });
      return answered.status;
    } catch (err) {
      console.error("media_upright_write_failed", { err: err instanceof Error ? err.message : String(err) });
      return 0;
    }
  },
};

/**
 * Send one answer.
 * @param res - The response to write.
 * @param answer - What to send.
 */
function send(res: ServerResponse, answer: Response): void {
  res.writeHead(200, { "content-type": answer.headers.get("content-type") ?? "" });
  const body = answer.body;
  if (body === null) {
    res.end();
    return;
  }
  Readable.fromWeb(body).pipe(res);
}

createServer((req, res) => {
  if (req.method === "POST" && req.url === RUN_PATH) {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      let job: RunBody;
      try {
        job = JSON.parse(Buffer.concat(chunks).toString("utf8")) as RunBody;
      } catch {
        res.writeHead(400).end();
        return;
      }
      // Taken before it runs: the object that sent it marks the job running
      // on this answer, and the run reports on its own when it ends.
      res.writeHead(202).end();
      await runJob(job);
    })();
    return;
  }
  if (req.method !== "POST" || req.url !== PROBE_PATH) {
    res.writeHead(404).end();
    return;
  }
  void (async () => {
    let asked: IncomingRequest;
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      asked = JSON.parse(
        Buffer.concat(chunks).toString("utf8"),
      ) as IncomingRequest;
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (typeof asked.objectUrl !== "string" || typeof asked.deadlineAt !== "number") {
      res.writeHead(400).end();
      return;
    }
    const request: ProbeRequest = {
      objectUrl: asked.objectUrl,
      wantCover: asked.wantCover === true,
      wantPreview: asked.wantPreview === true,
      wantPeaks: asked.wantPeaks === true,
      deadlineAt: asked.deadlineAt,
      ...(pictureSpecOf(asked.agentPicture) !== undefined && { agentPicture: pictureSpecOf(asked.agentPicture) }),
    };
    // Every tool in this run is held to the task's deadline and nothing else
    // (inner#1367). A timer cannot be set to a negative span, so a run that
    // arrives at or past the deadline is cut at once.
    const signal = AbortSignal.timeout(Math.max(1, request.deadlineAt - Date.now()));

    const upright = uprightOrderOf(asked.upright);
    if (upright !== null) {
      // The probe and the preview are of the turned picture, which is written
      // back last with its pixel size (inner#1367 §4.4).
      const ran = await runUpright(request.objectUrl, upright, request, signal, UPRIGHT_DEPS);
      send(res, buildProbeAnswer(ran.report, null, ran.preview, ran.outcome));
      return;
    }

    const found = await probe(request.objectUrl, request.wantCover, signal);
    const preview = await cutPreview(request, found, signal);
    const samples = peaksSampleCount({ wantPeaks: request.wantPeaks === true, report: found.report });
    const peaks =
      samples === null ? null : await streamPeaks("ffmpeg", peaksArgs(request.objectUrl), samples, signal);
    const agentPicture = await cutAgentPicture(request, signal);
    send(res, buildProbeAnswer(found.report, found.cover, preview, null, peaks, agentPicture));
  })();
}).listen(PROBE_PORT);
