// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The keys of derived presentation objects, without a validator so the media container can name them too.
 */

/**
 * The output key of one presentation sub-job (§5.4): job id, output key, operation and usage identity are one string.
 * @param sourceKey - The registered source key.
 * @param jobIdOfAttempt - The attempt's full container job id.
 * @returns The key.
 * @throws {never} Never.
 */
export function videoPresentationWorkKeyFor(sourceKey: string, jobIdOfAttempt: string): string {
  return `${sourceKey}.${jobIdOfAttempt}`;
}

/**
 * Whether a planned job writes its own work object (a chunk, §93 D5-10): never an output of the run, reclaimed at the run's
 * end while it still runs.
 * @param request - The job's stored request.
 * @param request.jobId - Its full container job id.
 * @param request.outputs - Its declared outputs.
 * @param sourceKey - The run's registered source key.
 * @returns Whether it does.
 * @throws {never} Never.
 */
export function writesWorkObject(request: { jobId: string; outputs: readonly { storageKey: string }[] }, sourceKey: string): boolean {
  return request.outputs.some((output) => output.storageKey === videoPresentationWorkKeyFor(sourceKey, request.jobId));
}
