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

import { UpstreamTaskFailed } from "@worker/providers/http.js";
import { acquireSemaphore, resolveModel, type ResumeContext } from "@worker/providers/shared.js";
import { runPrediction } from "@worker/providers/wavespeed.js";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { spawnCollected } from "@worker/handlers/local/runtime/spawn.js";
import { cleanupJobTempDir, createJobTempDir } from "@worker/handlers/local/runtime/tempdir.js";
import { planCameraPreviews, previewTranscodeArgs } from "@worker/voice-samples/camera-previews.js";
import { planVoiceSamples, type VoiceSampleJob } from "@worker/voice-samples/plan.js";
import {
  assertUploadsReachSampleAddress,
  resumablePredict,
  servedFromHead,
  syncVoiceSamples,
  type SyncReport,
} from "@worker/voice-samples/sync.js";

/** Passes a failing sample gets; upstream rate limits clear between them. */
const ATTEMPTS = 3;

/**
 * Run one sample's paid prediction through the model's own provider.
 * @param modality - The catalog the model is in: `tts` for a voice, `video` for a camera clip.
 * @param job - The sample.
 * @param resume - The upstream task an earlier pass already submitted for it.
 * @returns Where the prediction's output is.
 * @throws {Error} When the prediction fails or answers no output.
 */
async function predict(modality: "tts" | "video", job: VoiceSampleJob, resume: ResumeContext): Promise<string> {
  const resolved = resolveModel(modality, job.model);
  const release = await acquireSemaphore(resolved.providerName, resolved.maxConcurrency);
  try {
    const { outputs } = await runPrediction(resolved, resolved.modelId, job.body, resume);
    const url = outputs[0];
    if (typeof url !== "string") throw new Error(`${job.key}: the prediction answered no output`);
    return url;
  } finally {
    release();
  }
}

/**
 * Fetch a prediction's output.
 * @param url - Where the prediction put it.
 * @returns Its bytes.
 * @throws {Error} When the fetch fails.
 */
async function download(url: string): Promise<Buffer> {
  const res = await httpRequest(url, {}, { replaySafe: true });
  if (!res.ok) throw new Error(`${url}: fetching the output answered ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Turn a clip into its preview with ffmpeg (inner#1241).
 * @param name - Names the temp directory.
 * @param writeInput - Writes the clip to the path it is given.
 * @returns The preview's bytes.
 * @throws {Error} When ffmpeg fails.
 */
async function transcode(name: string, writeInput: (path: string) => Promise<unknown>): Promise<Buffer> {
  const dir = await createJobTempDir(name.replace(/\W+/g, "-"));
  try {
    const input = join(dir, "in.mp4");
    const output = join(dir, "out.mp4");
    await writeInput(input);
    await spawnCollected("ffmpeg", previewTranscodeArgs(input, output));
    return await readFile(output);
  } finally {
    await cleanupJobTempDir(dir);
  }
}

/**
 * Turn a generated clip into its preview.
 * @param job - The sample, named in the temp directory.
 * @param clip - The generated clip's bytes.
 * @returns The preview's bytes.
 * @throws {Error} When ffmpeg fails.
 */
async function toPreview(job: VoiceSampleJob, clip: Buffer): Promise<Buffer> {
  return transcode(job.key, (path) => writeFile(path, clip));
}

/**
 * Run the preview transcode once on ffmpeg's own test picture, so a machine
 * whose ffmpeg cannot make the preview stops before any clip is paid for.
 * @returns Nothing once the transcode ran.
 * @throws {Error} When ffmpeg cannot make the test picture or transcode it.
 */
async function checkPreviewTranscode(): Promise<void> {
  try {
    await transcode("camera-preview-check", (path) =>
      spawnCollected("ffmpeg", ["-y", "-f", "lavfi", "-i", "testsrc=duration=0.2:size=320x240:rate=24", "-pix_fmt", "yuv420p", path]));
  } catch (err) {
    throw new Error("ffmpeg on this machine cannot make camera preview clips", { cause: err });
  }
}

/** What one kind of sample is made from and stored as. */
interface SampleKind {
  /** Named in the logs. */
  kind: string;
  /** The samples. */
  jobs: readonly VoiceSampleJob[];
  /** The catalog their models are in. */
  modality: "tts" | "video";
  /** What their bytes are stored as. */
  contentType: string;
  /** What is done to the generated bytes before they are stored. */
  finish?: (job: VoiceSampleJob, bytes: Buffer) => Promise<Buffer>;
  /** Checks that `finish` can run, before anything is paid for. */
  beforeMaking?: () => Promise<void>;
}

/**
 * Sync one kind of sample against the sample address.
 * @param sample - The kind.
 * @param storage - Where the bytes go.
 * @param storage.upload - Stores bytes under a key with a content type.
 * @returns What the sync did.
 */
async function syncKind(
  sample: SampleKind,
  storage: { upload: (key: string, data: Buffer, contentType: string) => Promise<unknown> },
): Promise<SyncReport> {
  return syncVoiceSamples(sample.jobs, {
    exists: async (key) =>
      servedFromHead(key, (await httpRequest(voiceSampleUrl(key), { method: "HEAD" }, { replaySafe: true })).status),
    predict: resumablePredict(
      (job, resume) => predict(sample.modality, job, resume),
      (err) => err instanceof UpstreamTaskFailed,
    ),
    download,
    finish: sample.finish,
    beforeMaking: sample.beforeMaking,
    upload: async (key, bytes) => {
      await storage.upload(key, bytes, sample.contentType);
    },
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
  const kinds: SampleKind[] = [
    { kind: "voice", modality: "tts", contentType: "audio/mpeg",
      jobs: planVoiceSamples(getFullModelConfig("tts").models, getVoiceSampleConfig()) },
    { kind: "camera_preview", modality: "video", contentType: "video/mp4",
      jobs: planCameraPreviews(getFullModelConfig("video").models), finish: toPreview, beforeMaking: checkPreviewTranscode },
  ];
  let missing = 0;
  for (const sample of kinds) {
    const { kind, jobs } = sample;
    const report = await syncKind(sample, storage);
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
