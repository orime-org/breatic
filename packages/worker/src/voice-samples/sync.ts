// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Filling a deployment's bucket with the voice samples its catalog names
 * (#2156, design §16.4). A sample the bucket already serves is left alone, so
 * a deployment that has them all only asks, and a rerun makes only what a
 * previous run could not.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { MONOREPO_ROOT } from "@breatic/core";

import type { VoiceSampleConfig, VoiceSampleJob } from "@worker/voice-samples/plan.js";

/**
 * Whether a JSON value is an object.
 * @param value - The value.
 * @returns True for a plain object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read `config/voice-samples.json`.
 * @returns The sentences and per-model extras.
 * @throws {Error} When the file is missing or malformed.
 */
export async function loadVoiceSampleConfig(): Promise<VoiceSampleConfig> {
  const raw: unknown = JSON.parse(await readFile(resolve(MONOREPO_ROOT, "config/voice-samples.json"), "utf8"));
  const { languages, extra_body: extraBody } = (raw ?? {}) as Record<string, unknown>;
  if (!isRecord(languages) || !isRecord(extraBody)) {
    throw new Error("config/voice-samples.json needs `languages` and `extra_body` objects");
  }
  for (const [tag, said] of Object.entries(languages)) {
    if (!isRecord(said) || typeof said.text !== "string" || said.text === "") {
      throw new Error(`config/voice-samples.json: language "${tag}" needs a text`);
    }
  }
  return { languages, extra_body: extraBody } as VoiceSampleConfig;
}

/**
 * What a HEAD on a sample's public address says about it.
 *
 * Only a 404 means the sample is not there. Any other failure (a bucket that
 * is not public, a rate limit, an outage) leaves that unknown, and making the
 * sample again would be paid for without making it playable.
 * @param key - The sample key, for the error.
 * @param status - The HEAD's status.
 * @returns True when served, false when missing.
 * @throws {Error} When the status answers neither.
 */
export function servedFromHead(key: string, status: number): boolean {
  if (status >= 200 && status < 300) return true;
  if (status === 404) return false;
  throw new Error(`${key}: HEAD answered ${status}`);
}

/** What a sync needs from the outside. */
export interface SyncDeps {
  /** Whether the bucket already serves this key. */
  exists: (key: string) => Promise<boolean>;
  /** Make the sample's bytes. */
  generate: (job: VoiceSampleJob) => Promise<Buffer>;
  /** Store the bytes under the key. */
  upload: (key: string, bytes: Buffer) => Promise<void>;
  /** How many passes a failing sample gets. */
  attempts: number;
  /** How many samples are made at once. */
  concurrency?: number;
}

/** What a sync did. */
export interface SyncReport {
  /** Samples the bucket already served. */
  present: number;
  /** Samples made and stored. */
  made: number;
  /** Samples still missing after every pass, with the last error. */
  failed: Array<{ key: string; error: string }>;
}

/**
 * Run each job through `work`, a few at a time.
 * @param jobs - The jobs.
 * @param concurrency - How many at once.
 * @param work - What to do with one.
 */
async function eachLimited<T>(jobs: readonly T[], concurrency: number, work: (job: T) => Promise<void>): Promise<void> {
  const queue = [...jobs];
  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      for (let job = queue.shift(); job !== undefined; job = queue.shift()) await work(job);
    }),
  );
}

/**
 * Make every sample the bucket does not serve yet.
 * @param jobs - Every sample the catalog names.
 * @param deps - Bucket, generator and pass count.
 * @returns How many were there, made, and still missing.
 */
export async function syncVoiceSamples(jobs: readonly VoiceSampleJob[], deps: SyncDeps): Promise<SyncReport> {
  const concurrency = deps.concurrency ?? 8;
  const missing: VoiceSampleJob[] = [];
  await eachLimited(jobs, concurrency, async (job) => {
    if (!(await deps.exists(job.key))) missing.push(job);
  });
  // Kept in catalog order, whatever order the checks answered in.
  missing.sort((a, b) => jobs.indexOf(a) - jobs.indexOf(b));

  let made = 0;
  let pending = missing;
  const errors = new Map<string, string>();
  for (let pass = 0; pass < deps.attempts && pending.length > 0; pass += 1) {
    const failedThisPass: VoiceSampleJob[] = [];
    await eachLimited(pending, concurrency, async (job) => {
      try {
        await deps.upload(job.key, await deps.generate(job));
        made += 1;
        errors.delete(job.key);
      } catch (err) {
        errors.set(job.key, err instanceof Error ? err.message : String(err));
        failedThisPass.push(job);
      }
    });
    pending = failedThisPass.sort((a, b) => jobs.indexOf(a) - jobs.indexOf(b));
  }
  return {
    present: jobs.length - missing.length,
    made,
    failed: pending.map((job) => ({ key: job.key, error: errors.get(job.key) ?? "" })),
  };
}
