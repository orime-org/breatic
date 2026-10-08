// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The media container's whole service (#209 + #210, design §4.2).
 *
 * One endpoint. It runs ffprobe over the object it was handed, lifts a cover
 * frame when asked for one, cuts a preview when asked for one and there is
 * still time, and answers with all three. It decides nothing about
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
import { execFile } from "node:child_process";
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
import { previewSource } from "@ingest/preview-step.js";
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
 * The most a preview may weigh. A 576-wide WebP of the noisiest frame measured
 * on this ffmpeg came to 111,560 bytes (inner#1320 design §5.1).
 */
const PREVIEW_MAX_BYTES = 2 * 1024 * 1024;

/** One run's request as it arrives: read before it is believed. */
type IncomingRequest = Partial<Record<keyof ProbeRequest, unknown>>;

/**
 * Run one tool and collect what it wrote.
 * @param program - `ffprobe` or `ffmpeg`.
 * @param args - Its argument list.
 * @param maxBytes - The most stdout may hold.
 * @param timeoutMs - How long it may run. It covers reading the object as well
 *   as the work, since both tools read over the network.
 * @param stdin - Bytes to hand the tool on stdin, when it reads from there.
 * @returns What it wrote, or null when it failed or produced nothing.
 */
async function run(
  program: string,
  args: string[],
  maxBytes: number,
  timeoutMs: number,
  stdin?: Uint8Array,
): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const child = execFile(
      program,
      args,
      { encoding: "buffer", maxBuffer: maxBytes, timeout: timeoutMs },
      (error, stdout) => {
        if (error !== null) {
          // The upload succeeds either way, so this is the only place the
          // reason exists: without it a video with no cover and a video whose
          // ffmpeg was killed look the same from outside. `signal` names a
          // deadline the tool was cut off at, `code` a refusal it decided on
          // its own, and neither is on the Worker's side of the wire.
          console.error("media_tool_failed", {
            program,
            signal: error.signal ?? null,
            code: error.code ?? null,
            err: error.message,
          });
          resolve(null);
          return;
        }
        if (stdout.length === 0) {
          console.error("media_tool_wrote_nothing", { program });
          resolve(null);
          return;
        }
        resolve(stdout);
      },
    );
    if (stdin !== undefined) child.stdin?.end(stdin);
  });
}

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
  const probed = await run(
    "ffprobe",
    probeArgs(objectUrl),
    4 * 1024 * 1024,
    timeoutMs,
  );
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

  const cut = await run(
    "ffmpeg",
    coverArgs(objectUrl),
    COVER_MAX_BYTES,
    timeoutMs,
  );
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
  const source = previewSource({
    wantPreview: asked.wantPreview,
    wantCover: asked.wantCover,
    cover: found.cover,
    report: found.report,
    deadlineAt: asked.deadlineAt,
    previewTimeoutMs: asked.previewTimeoutMs,
    now: Date.now(),
  });
  if (source === "late") {
    // The Worker drops the whole answer at its deadline, so this run keeps
    // the size and the cover and leaves the preview to the backfill.
    console.error("media_preview_skipped_deadline", {
      leftMs: asked.deadlineAt - Date.now(),
    });
    return null;
  }
  if (source === null) return null;
  const fromCover = source === "cover" ? found.cover : null;
  const cut = await run(
    "ffmpeg",
    previewArgs(fromCover === null ? asked.objectUrl : "pipe:0"),
    PREVIEW_MAX_BYTES,
    asked.previewTimeoutMs,
    fromCover ?? undefined,
  );
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
      previewTimeoutMs:
        typeof asked.previewTimeoutMs === "number" ? asked.previewTimeoutMs : 0,
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
