// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The media container's whole service (#209 + #210, design §4.2).
 *
 * One endpoint. It runs ffprobe over the object it was handed, lifts a cover
 * frame when asked for one, and answers with both. It decides nothing about
 * what the media is: which stream carries the dimensions and whether a cover
 * is wanted are the caller's judgements, made where the ticket's content type
 * is known.
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
import { buildProbeAnswer } from "@ingest/probe-answer.js";
import { probeArgs, coverArgs, readProbeOutput } from "@ingest/probe-command.js";
import { pickMediaMetadata } from "@ingest/media-metadata.js";
import type { ProbeReport } from "@ingest/media-metadata.js";

/** The port the Worker's container class connects to. */
const PORT = 8080;

/**
 * How long one tool may run.
 *
 * ffmpeg reads the object over the network, so this covers the reads as well
 * as the work. The Worker has its own deadline around the whole call; this one
 * keeps a single tool from holding the container past it.
 */
const TOOL_TIMEOUT_MS = 60_000;

/**
 * The most a cover frame may weigh.
 *
 * One PNG frame of an ordinary video is well under this. A frame that is not —
 * an enormous resolution, a crafted file — stops here rather than being sent
 * to the Worker and stored.
 */
const COVER_MAX_BYTES = 10 * 1024 * 1024;

/** What one run was asked to do. */
interface ProbeRequest {
  /** Where to read the object, which is a hostname the Worker intercepts. */
  objectUrl?: unknown;
  /** Whether to lift a cover frame, decided from the ticket's content type. */
  wantCover?: unknown;
}

/**
 * Run one tool and collect what it wrote.
 * @param program - `ffprobe` or `ffmpeg`.
 * @param args - Its argument list.
 * @param maxBytes - The most stdout may hold.
 * @returns What it wrote, or null when it failed or produced nothing.
 */
async function run(
  program: string,
  args: string[],
  maxBytes: number,
): Promise<Buffer | null> {
  return new Promise((resolve) => {
    execFile(
      program,
      args,
      { encoding: "buffer", maxBuffer: maxBytes, timeout: TOOL_TIMEOUT_MS },
      (error, stdout) => {
        if (error !== null || stdout.length === 0) {
          resolve(null);
          return;
        }
        resolve(stdout);
      },
    );
  });
}

/**
 * Probe one object, and lift a cover frame when one is wanted and there is a
 * stream to lift it from.
 * @param objectUrl - Where to read it.
 * @param wantCover - Whether the caller wants a frame.
 * @returns What ffprobe found and the frame, when there is one.
 */
async function probe(
  objectUrl: string,
  wantCover: boolean,
): Promise<{ report: ProbeReport; cover: Uint8Array | null }> {
  const probed = await run("ffprobe", probeArgs(objectUrl), 4 * 1024 * 1024);
  const report =
    probed === null
      ? { streams: [], durationSeconds: null }
      : readProbeOutput(probed.toString("utf8"));

  // Nothing to lift a frame from: an audio file, an image, or a video whose
  // only video stream is attached album art. `pickMediaMetadata` is the one
  // place that judgement is made.
  const hasFrame = pickMediaMetadata(report).width !== null;
  if (!wantCover || !hasFrame) return { report, cover: null };

  const cut = await run("ffmpeg", coverArgs(objectUrl), COVER_MAX_BYTES);
  return { report, cover: cut === null ? null : new Uint8Array(cut) };
}

createServer((req, res) => {
  if (req.method !== "POST" || req.url !== "/probe") {
    res.writeHead(404).end();
    return;
  }
  void (async () => {
    let asked: ProbeRequest;
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      asked = JSON.parse(Buffer.concat(chunks).toString("utf8")) as ProbeRequest;
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (typeof asked.objectUrl !== "string") {
      res.writeHead(400).end();
      return;
    }

    const found = await probe(asked.objectUrl, asked.wantCover === true);
    const answer = buildProbeAnswer(found.report, found.cover);
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
}).listen(PORT);
