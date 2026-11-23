// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * Which keys a media run is accepted on (inner#1953), settled once when the server accepts the submission: the media
 * on the upstream the Studio's payer pointed the model at while that key is live, a language-model step inside the run
 * on the payer's OpenRouter key when it has one; our keys otherwise. The task records the key rows by id, never a key.
 * What an account's key pays for is neither held nor checked against the Studio's credits.
 */

import { SMALLEST_CREDIT, resolveKeys, runCallsLlm, runDescribesInput, type ResolvedKeys } from "@breatic/domain";
import type { KeySet, Route } from "@breatic/provider";
import { precheckCredits } from "@server/modules/credit/credit-precheck.service.js";

/** The keys a media run goes out on. */
export interface RunKeys {
  /** The media's keys and route. */
  media: ResolvedKeys;
  /** The keys of the run's language-model step; null when the run has none. */
  llm: ResolvedKeys | null;
  /** True when that step is charged on our keys (a description); a prompt rewrite never is. */
  llmCharged: boolean;
}

/** The key rows a task records. */
export interface TaskKeyRows {
  keyId: string | null;
  llmKeyId: string | null;
}

/**
 * The keys a media run of a Project goes out on.
 * @param projectId - The Project; its Studio's payer supplies the keys.
 * @param model - The catalog model.
 * @param params - The run's params, in our names.
 * @returns The media's keys and the language-model step's, if the run has one.
 * @throws {ProviderKeySealBroken} When the payer's sealed key cannot be opened here.
 */
export async function mediaRunKeys(projectId: string, model: string, params: Readonly<Record<string, unknown>>): Promise<RunKeys> {
  const media = await resolveKeys({ projectId }, { kind: "media", model });
  const llm = runCallsLlm(model, params) ? await resolveKeys({ projectId }, { kind: "llm" }) : null;
  return { media, llm, llmCharged: runDescribesInput(model, params) };
}

/**
 * The account's key set a call is handed, or undefined on our keys, which provider uses when handed none.
 * @param resolved - The keys as resolved.
 * @returns The payer's key set, or undefined.
 */
export function accountKeys(resolved: ResolvedKeys): KeySet | undefined {
  return resolved.keyId === null ? undefined : resolved.keys;
}

/**
 * The route a run takes: the upstream the payer chose when its key pays, the one asked for otherwise.
 * @param keys - The run's keys.
 * @param asked - The route the submission named, if any.
 * @returns The route, or undefined for the weights.
 */
export function runRoute(keys: RunKeys, asked: Route | undefined): Route | undefined {
  return keys.media.keyId === null ? asked : keys.media.route;
}

/**
 * The key rows a task records for its keys.
 * @param keys - The run's keys.
 * @returns The media's row and the language-model step's, null on our keys.
 */
export function taskKeyRows(keys: RunKeys): TaskKeyRows {
  return { keyId: keys.media.keyId, llmKeyId: keys.llm?.keyId ?? null };
}

/**
 * What a run is held for: its estimate on our keys, or when it carries no keys; nothing on the payer's, where a charged
 * language-model step on our keys only needs a balance above zero, as every charged language-model call does.
 * @param keys - The run's keys; null or undefined when it carries none.
 * @param projectId - The Project; its Studio pays.
 * @param userId - Who submits it.
 * @param estimate - The run's estimate.
 * @returns The credits to hold, or null to hold nothing.
 * @throws {AppError} 402 when a charged language-model step on our keys meets a balance at zero.
 */
export async function creditsToHold(keys: RunKeys | null | undefined, projectId: string, userId: string, estimate: () => Promise<number>): Promise<number | null> {
  if (keys === null || keys === undefined || keys.media.keyId === null) return estimate();
  if (keys.llmCharged && keys.llm?.keyId === null) await precheckCredits(projectId, userId, SMALLEST_CREDIT);
  return null;
}
