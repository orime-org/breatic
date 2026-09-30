// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * One-shot deploy step: make every voice sample the catalog names that this
 * deployment's bucket does not serve yet (#2156, design §16.4). Runs from
 * docker compose after each deploy, and locally as `pnpm voice-samples`.
 *
 * The application services do not wait for it: a sample still missing plays
 * nothing, and the next run makes it. A run with samples still missing exits
 * non-zero so `docker compose ps` shows it.
 */

// MUST be first: reads process.env + initCore before any env.* read.
import "@worker/bootstrap-config.js";

import { getStorageAdapter, logger } from "@breatic/core";
import { getFullModelConfig } from "@breatic/domain";
import { httpRequest } from "@breatic/shared";

import { acquireSemaphore, resolveModel } from "@worker/providers/shared.js";
import { runPrediction } from "@worker/providers/wavespeed.js";
import { planVoiceSamples, type VoiceSampleJob } from "@worker/voice-samples/plan.js";
import { loadVoiceSampleConfig, servedFromHead, syncVoiceSamples } from "@worker/voice-samples/sync.js";

/** Passes a failing sample gets; upstream rate limits clear between them. */
const ATTEMPTS = 3;

/**
 * Make one sample's bytes through the model's own provider.
 * @param job - The sample.
 * @returns The mp3 bytes.
 * @throws {Error} When the prediction fails or answers no audio.
 */
async function generate(job: VoiceSampleJob): Promise<Buffer> {
  const resolved = resolveModel("tts", job.model);
  const release = await acquireSemaphore(resolved.providerName, resolved.maxConcurrency);
  try {
    const { outputs } = await runPrediction(resolved, resolved.modelId, job.body);
    const url = outputs[0];
    if (typeof url !== "string") throw new Error(`${job.key}: the prediction answered no audio`);
    const res = await httpRequest(url, {}, { replaySafe: true });
    if (!res.ok) throw new Error(`${job.key}: fetching the audio answered ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  } finally {
    release();
  }
}

/**
 * Run the sync and exit with its outcome.
 * @returns Nothing; the process exits.
 */
async function main(): Promise<void> {
  const storage = await getStorageAdapter();
  const jobs = planVoiceSamples(getFullModelConfig("tts").models, await loadVoiceSampleConfig());
  const report = await syncVoiceSamples(jobs, {
    exists: async (key) =>
      servedFromHead(key, (await httpRequest(storage.publicUrl(key), { method: "HEAD" }, { replaySafe: true })).status),
    generate,
    upload: async (key, bytes) => {
      await storage.upload(key, bytes, "audio/mpeg");
    },
    attempts: ATTEMPTS,
  });
  logger.info({ total: jobs.length, present: report.present, made: report.made, failed: report.failed.length }, "voice_samples_synced");
  for (const miss of report.failed) logger.error({ key: miss.key, error: miss.error }, "voice_sample_missing");
  process.exit(report.failed.length === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  logger.error({ err }, "voice_samples_sync_failed");
  process.exit(1);
});
