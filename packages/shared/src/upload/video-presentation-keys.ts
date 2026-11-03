// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The keys of derived presentation objects, without a validator so the media container can name them too.
 */

/**
 * Derive the full source ledger key of one plan (toolInputId) beside the registered canonical storage key.
 * @param key - Original registered canonical storage key.
 * @param toolInputId - The plan's toolInputId; each plan's ledger is its own object (design §5.1 step 5).
 * @returns The deterministic full ledger key.
 * @throws {never} Never.
 */
export function videoSourceLedgerKeyFor(key: string, toolInputId: string): string {
  return `${key}.video-source-ledger.${toolInputId}.json`;
}

/**
 * Derive the compact presentation table key of one plan (toolInputId) beside the registered canonical storage key.
 * @param key - Original registered canonical storage key.
 * @param toolInputId - The plan's toolInputId.
 * @returns The deterministic compact table key.
 * @throws {never} Never.
 */
export function videoSourceLedgerTableKeyFor(key: string, toolInputId: string): string {
  return `${key}.video-presentation-table.${toolInputId}.json`;
}

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
