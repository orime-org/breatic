// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The media container's whole service (#209 + #210, design §4.2).
 *
 * One endpoint. It runs ffprobe over the object it was handed, lifts a cover
 * frame with ffmpeg when asked for one, cuts a preview with vips when asked
 * for one and there is still time, and answers with all three. It decides nothing about
 * what the media is: which stream carries the dimensions and whether a cover
 * is wanted are the caller's judgements, made where the stored bytes have
 * already been read.
 *
 * It reads the object over plain HTTP from a hostname the Worker intercepts,
 * so it holds no credentials and has no route to the internet. The Worker
 * serves exactly the one key this run is about (`serveOneObject`).
 *
 * Bundled into one file at image build time, which is why it imports from the
 * Worker's source: the argument lists and the answer format are one agreement
 * between the two sides, and a second copy in here would drift from it.
 */

import { createServer } from "node:http";
import { Readable } from "node:stream";
import {
  buildProbeAnswer,
  PROBE_PATH,
  PROBE_PORT,
} from "@ingest/probe-answer.js";
import {
  probeArgs,
  coverArgs,
  previewArgs,
  readProbeOutput,
} from "@ingest/probe-command.js";
import { previewSource, previewTimeLeft } from "@ingest/preview-step.js";
import { openObject, runTool } from "./run-tool.js";
import { NOTHING_FOUND, pickMediaMetadata } from "@ingest/media-metadata.js";
import type { ProbeReport } from "@ingest/media-metadata.js";
import type { ProbeRequest } from "@ingest/probe-answer.js";

/**
 * The most a cover frame may weigh.
 *
 * One PNG frame of an ordinary video is well under this. A frame that is not —
 * an enormous resolution, a crafted file — stops here rather than being sent
 * to the Worker and stored.
 */
const COVER_MAX_BYTES = 10 * 1024 * 1024;

/**
 * The most a preview may weigh. The largest preview is 576x16383, and that
 * size cut from pure noise came to 5,176,264 bytes (inner#1320 round 5); an
 * ordinary 576-wide frame is around 100 KB.
 */
const PREVIEW_MAX_BYTES = 8 * 1024 * 1024;

/** One run's request as it arrives: read before it is believed. */
type IncomingRequest = Partial<Record<keyof ProbeRequest, unknown>>;

/**
 * Probe one object, and lift a cover frame when one is wanted and there is a
 * stream to lift it from.
 * @param objectUrl - Where to read it.
 * @param wantCover - Whether the caller wants a frame.
 * @param timeoutMs - How long each tool may run.
 * @returns What ffprobe found and the frame, when there is one.
 */
async function probe(
  objectUrl: string,
  wantCover: boolean,
  timeoutMs: number,
): Promise<{ report: ProbeReport; cover: Uint8Array | null }> {
  const probed = await runTool("ffprobe", probeArgs(objectUrl), {
    maxBytes: 4 * 1024 * 1024,
    signal: AbortSignal.timeout(timeoutMs),
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
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { report, cover: cut === null ? null : new Uint8Array(cut) };
}

/**
 * Cut a preview, when `previewSource` says what from.
 * @param asked - What this run was asked.
 * @param found - What the probe and the cover call produced.
 * @param found.report - What ffprobe found.
 * @param found.cover - The cover frame, when one was cut.
 * @returns The WebP bytes, or null when none was cut.
 */
async function cutPreview(
  asked: ProbeRequest,
  found: { report: ProbeReport; cover: Uint8Array | null },
): Promise<Uint8Array | null> {
  // One reading of the clock decides both whether there is time and how much.
  const clock = { deadlineAt: asked.deadlineAt, now: Date.now() };
  const source = previewSource({
    wantPreview: asked.wantPreview,
    wantCover: asked.wantCover,
    cover: found.cover,
    report: found.report,
    ...clock,
  });
  if (source === "late") {
    // The Worker drops the whole answer at its deadline, so this run keeps
    // the size and the cover and leaves the preview to the backfill.
    console.error("media_preview_skipped_deadline", {
      leftMs: clock.deadlineAt - clock.now,
    });
    return null;
  }
  if (source === null) return null;
  // The read and vips share this signal, so a read cut off by it never hands
  // vips a short picture.
  const signal = AbortSignal.timeout(previewTimeLeft(clock));
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

createServer((req, res) => {
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
    if (
      typeof asked.objectUrl !== "string" ||
      typeof asked.toolTimeoutMs !== "number"
    ) {
      res.writeHead(400).end();
      return;
    }
    const request: ProbeRequest = {
      objectUrl: asked.objectUrl,
      wantCover: asked.wantCover === true,
      toolTimeoutMs: asked.toolTimeoutMs,
      wantPreview: asked.wantPreview === true,
      deadlineAt: typeof asked.deadlineAt === "number" ? asked.deadlineAt : 0,
    };

    const found = await probe(
      request.objectUrl,
      request.wantCover,
      request.toolTimeoutMs,
    );
    const preview = await cutPreview(request, found);
    const answer = buildProbeAnswer(found.report, found.cover, preview);
    res.writeHead(200, {
      "content-type": answer.headers.get("content-type") ?? "",
    });
    const body = answer.body;
    if (body === null) {
      res.end();
      return;
    }
    Readable.fromWeb(body).pipe(res);
  })();
}).listen(PROBE_PORT);
