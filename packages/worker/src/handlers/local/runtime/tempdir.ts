// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Per-job temp directory under the OS temp root.
 *
 * Every local handler invocation gets its own isolated directory so
 * concurrent jobs cannot collide on filenames, and so cleanup can rm
 * a single directory instead of tracking individual files.
 *
 * The lifecycle is:
 *   1. `createJobTempDir(jobId)` at the start of `runLocalHandler`.
 *   2. Handler reads/writes inside the returned path.
 *   3. `cleanupJobTempDir(dir)` in a `finally` block — always runs
 *      even on thrown errors.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Create a fresh per-job temp directory.
 * @param jobId - BullMQ job id (used as prefix for debuggability)
 * @returns Absolute path to the new directory
 */
export async function createJobTempDir(jobId: string): Promise<string> {
  const prefix = join(tmpdir(), `breatic-worker-${jobId}-`);
  return await mkdtemp(prefix);
}

/**
 * Recursively remove a job temp directory. Never throws — cleanup
 * errors are swallowed with a best-effort log (the caller is usually
 * inside a `finally` on a hot path, and we don't want cleanup
 * failures to mask the real error).
 * @param dir - Absolute directory path returned by `createJobTempDir`
 */
export async function cleanupJobTempDir(dir: string): Promise<void> {
  try {
    await rm(dir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup — ignore
  }
}
