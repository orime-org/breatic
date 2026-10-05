// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Make every voice sample and every camera command preview clip (inner#1241)
 * the catalog names that its fixed public address (`base_url` in
 * config/voice-samples.json, #2239) does not serve yet. Run as
 * `pnpm voice-samples` by whoever adds voices or camera commands to the
 * catalog, with storage settings that publish to that address; every
 * deployment plays them from there. A run with any still missing exits
 * non-zero.
 */

// MUST be first: reads process.env + initCore before any env.* read.
import "@worker/bootstrap-config.js";

import { getStorageAdapter, logger } from "@breatic/core";
import { getFullModelConfig, getVoiceSampleConfig, voiceSampleUrl } from "@breatic/domain";
import { httpRequest } from "@breatic/shared";

import { acquireSemaphore, resolveModel } from "@worker/providers/shared.js";
import { runPrediction } from "@worker/providers/wavespeed.js";
import { planCameraPreviews } from "@worker/voice-samples/camera-previews.js";
import { planVoiceSamples, type VoiceSampleJob } from "@worker/voice-samples/plan.js";
import {
  assertUploadsReachSampleAddress,
  servedFromHead,
  syncVoiceSamples,
  type SyncReport,
} from "@worker/voice-samples/sync.js";

/** Passes a failing sample gets; upstream rate limits clear between them. */
const ATTEMPTS = 3;

/**
 * Make one sample's bytes through the model's own provider.
 * @param modality - The catalog the model is in: `tts` for a voice, `video` for a camera clip.
 * @param job - The sample.
 * @returns The bytes the prediction answers.
 * @throws {Error} When the prediction fails or answers no output.
 */
async function generate(modality: "tts" | "video", job: VoiceSampleJob): Promise<Buffer> {
  const resolved = resolveModel(modality, job.model);
  const release = await acquireSemaphore(resolved.providerName, resolved.maxConcurrency);
  try {
    const { outputs } = await runPrediction(resolved, resolved.modelId, job.body);
    const url = outputs[0];
    if (typeof url !== "string") throw new Error(`${job.key}: the prediction answered no output`);
    const res = await httpRequest(url, {}, { replaySafe: true });
    if (!res.ok) throw new Error(`${job.key}: fetching the output answered ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  } finally {
    release();
  }
}

/**
 * Sync one kind of sample against the sample address.
 * @param jobs - The samples.
 * @param modality - The catalog their models are in.
 * @param contentType - What their bytes are stored as.
 * @param upload - Stores bytes under a key with a content type.
 * @returns What the sync did.
 */
async function syncKind(
  jobs: readonly VoiceSampleJob[],
  modality: "tts" | "video",
  contentType: string,
  upload: (key: string, bytes: Buffer, contentType: string) => Promise<void>,
): Promise<SyncReport> {
  return syncVoiceSamples(jobs, {
    exists: async (key) =>
      servedFromHead(key, (await httpRequest(voiceSampleUrl(key), { method: "HEAD" }, { replaySafe: true })).status),
    generate: (job) => generate(modality, job),
    upload: (key, bytes) => upload(key, bytes, contentType),
    attempts: ATTEMPTS,
  });
}

/**
 * Run the sync and exit with its outcome.
 * @returns Nothing; the process exits.
 */
async function main(): Promise<void> {
  const storage = await getStorageAdapter();
  assertUploadsReachSampleAddress((key) => storage.publicUrl(key), voiceSampleUrl);
  const upload = async (key: string, bytes: Buffer, contentType: string): Promise<void> => {
    await storage.upload(key, bytes, contentType);
  };
  const kinds = [
    { kind: "voice", modality: "tts", contentType: "audio/mpeg",
      jobs: planVoiceSamples(getFullModelConfig("tts").models, getVoiceSampleConfig()) },
    { kind: "camera_preview", modality: "video", contentType: "video/mp4",
      jobs: planCameraPreviews(getFullModelConfig("video").models) },
  ] as const;
  let missing = 0;
  for (const { kind, modality, contentType, jobs } of kinds) {
    const report = await syncKind(jobs, modality, contentType, upload);
    logger.info({ kind, total: jobs.length, present: report.present, made: report.made, failed: report.failed.length }, "voice_samples_synced");
    for (const miss of report.failed) logger.error({ kind, key: miss.key, error: miss.error }, "voice_sample_missing");
    missing += report.failed.length;
  }
  process.exit(missing === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  logger.error({ err }, "voice_samples_sync_failed");
  process.exit(1);
});
