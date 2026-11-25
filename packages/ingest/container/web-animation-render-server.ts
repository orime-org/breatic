// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The render container's whole service (#1490 design §6.2): one endpoint that takes a render, answers 202 and carries
 * it on until it reports through `jobs.local`. One container runs one export, so a second run is refused.
 *
 * Bundled into one file at image build time with the Worker's shared agreement (`web-animation-run-body.ts`); the
 * producer is installed beside the bundle, and the image's environment says where the font sets and ffmpeg are.
 */

import { createServer } from "node:http";

import {
  WEB_ANIMATION_PORT,
  WEB_ANIMATION_RUN_PATH,
  type WebAnimationRenderRunBody,
} from "@ingest/jobs/web-animation-run-body.js";

import { runWebAnimationRender, type WebAnimationRenderSettings } from "./web-animation-render.js";

/**
 * One setting from the image's environment.
 * @param name - The variable.
 * @returns Its value.
 * @throws {Error} When the image does not set it.
 */
function setting(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is not set in the image`);
  return value;
}

const settings: WebAnimationRenderSettings = {
  fontsDir: setting("WEB_ANIMATION_FONTS_DIR"),
  ffmpegBin: setting("WEB_ANIMATION_FFMPEG_BIN"),
  ffprobeBin: setting("WEB_ANIMATION_FFPROBE_BIN"),
};

let running = false;

createServer((req, res) => {
  if (req.method !== "POST" || req.url !== WEB_ANIMATION_RUN_PATH) {
    res.writeHead(404).end();
    return;
  }
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => {
    let job: WebAnimationRenderRunBody;
    try {
      job = JSON.parse(Buffer.concat(chunks).toString("utf8")) as WebAnimationRenderRunBody;
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (running) {
      res.writeHead(409).end();
      return;
    }
    running = true;
    res.writeHead(202).end();
    void runWebAnimationRender(job, settings);
  });
}).listen(WEB_ANIMATION_PORT, "0.0.0.0");
