// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The web-animation container's whole service (inner#1711 design §6): one endpoint that takes a run, answers 202 and
 * carries the run on until it reports through `jobs.local`. One container runs one job, so a second run is refused.
 *
 * Bundled into one file at image build time with the Worker's shared agreement (`web-animation-run-body.ts`); the
 * image's environment says where dsh, Chromium, the runtime and the font set are.
 */

import { createServer } from "node:http";

import {
  WEB_ANIMATION_PORT,
  WEB_ANIMATION_RUN_PATH,
  type WebAnimationRunBody,
} from "@ingest/jobs/web-animation-run-body.js";

import { runWebAnimation, type WebAnimationRunnerSettings } from "./web-animation-run.js";

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

const settings: WebAnimationRunnerSettings = {
  fontsDir: setting("WEB_ANIMATION_FONTS_DIR"),
  runtimeFile: setting("WEB_ANIMATION_RUNTIME_FILE"),
  dshBin: setting("WEB_ANIMATION_DSH_BIN"),
  dshProfile: setting("WEB_ANIMATION_DSH_PROFILE"),
  chromiumBin: setting("WEB_ANIMATION_CHROMIUM_BIN"),
  home: setting("WEB_ANIMATION_HOME"),
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
    let job: WebAnimationRunBody;
    try {
      job = JSON.parse(Buffer.concat(chunks).toString("utf8")) as WebAnimationRunBody;
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
    runWebAnimation(job, settings).catch((err: unknown) => {
      console.error("web_animation_runner_failed", { err: err instanceof Error ? err.message : String(err) });
    });
  });
}).listen(WEB_ANIMATION_PORT);
