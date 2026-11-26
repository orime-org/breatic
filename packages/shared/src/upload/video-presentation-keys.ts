// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

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
