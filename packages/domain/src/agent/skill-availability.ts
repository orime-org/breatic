// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Whether the model a skill pinned itself to can actually run here.
 *
 * Pinning the model is what makes a skill reproducible; this is its cost. A
 * deployment configures the provider keys it wants — every one of them
 * defaults to `""` on purpose, so a self-hosted install need not hold
 * accounts everywhere — and a skill on a provider it did not configure is
 * simply dead.
 *
 * Before this, the process started, the skill listed, and the user found out
 * by clicking, receiving whatever the provider library threw. Those messages
 * name endpoints and key hints.
 *
 * Written once, in domain, because both services ask it: the chat entry
 * before opening a stream, the worker before claiming a job. Two copies
 * would answer differently the first time a fallback rule changed.
 *
 * Text and media reach a key by different routes, so one function knows
 * both:
 *
 * A text model falls back through OpenRouter. `getModel` routes to the
 * direct provider when its key is set and to OpenRouter otherwise, so
 * `google/gemini-*` runs with no Google key as long as OpenRouter has one.
 * Only when neither is set is the model unreachable.
 *
 * A media model falls back sideways. One model names several providers with
 * priorities and any one of their keys will do. Their env var NAMES are read
 * from each modality's `providers.yaml`, never listed here: that file holds
 * names the env schema does not know, so a hand-written list would be wrong
 * the day someone adds a provider.
 *
 * A media model also has to clear the text check, and that is not belt and
 * braces. The two consumers of a resolved model both hand it to `getModel`,
 * which knows only text routing — direct provider by prefix, OpenRouter for
 * everything else. So a skill on an image model with its image key set but
 * no text key would be approved here and fail at the call. Both have to hold.
 */
import { AppError, getRawEnvVar } from "@breatic/core";
import {
  MODALITIES,
  getFullModelConfig,
} from "@domain/model-catalog/model-catalog.js";

/** What a check found. */
export interface SkillModelCheck {
  /** Whether the model has a provider it can actually reach. */
  ok: boolean;
  /**
   * The env vars that would make it reachable, when it is not.
   *
   * Every one of them, not the first: any single one is enough, and the
   * operator is the one who knows which account they have.
   */
  missing: string[];
}

/** The direct-provider prefixes `getModel` recognises, and their keys. */
const TEXT_DIRECT_KEYS: ReadonlyArray<readonly [string, string]> = [
  ["anthropic/", "ANTHROPIC_API_KEY"],
  ["google/", "GOOGLE_API_KEY"],
  ["openai/", "OPENAI_API_KEY"],
];

/** The universal text fallback, which `getModel` uses for everything else. */
const TEXT_FALLBACK_KEY = "OPENROUTER_API_KEY";

/**
 * Whether an env var holds something.
 *
 * Read through `getRawEnvVar` rather than the `env` proxy, because half the
 * names here are not in the schema and never can be. The proxy resolves
 * against the validated config, so a name it has not heard of comes back
 * undefined however the process was actually started — and provider key
 * names come off yaml files free to name anything. Measured in this repo:
 * `config/models/video/providers.yaml` declares `KLING_ACCESS_KEY` while
 * the schema declares `KLINGAI_ACCESS_KEY`, so through the proxy that
 * provider can never be seen as configured.
 * @param name - The env var name.
 * @returns True when it is a non-empty string.
 */
function isSet(name: string): boolean {
  const value = getRawEnvVar(name);
  return typeof value === "string" && value.length > 0;
}

/**
 * Find a model in the media catalog and list its providers' key names.
 * @param modelName - The model a skill named.
 * @returns The env var names of its providers, or null when no modality has this model.
 */
function mediaProviderKeys(modelName: string): string[] | null {
  for (const modality of MODALITIES) {
    const config = getFullModelConfig(modality);
    const entry = config.models.find((m) => m.name === modelName);
    if (!entry) continue;
    const names: string[] = [];
    for (const p of entry.providers ?? []) {
      const keyName = config.providers[p.name]?.api_key_env;
      if (keyName) names.push(keyName);
    }
    return names;
  }
  return null;
}

/**
 * Check whether a skill's declared model has a reachable provider.
 * @param modelName - The model the skill declared, or undefined when it declared none.
 * @returns Whether it can run, and which env vars would fix it when it cannot.
 */
export function checkSkillModelRunnable(
  modelName: string | undefined,
): SkillModelCheck {
  // No declaration means the skill runs on the configured default, which is
  // the same model plain chat uses. A deployment with no LLM key at all is a
  // global condition, not this skill's problem.
  if (!modelName) return { ok: true, missing: [] };

  // The route the run will actually take. Both callers hand `modelId` to
  // `getModel`, so this decides reachability for every model, media or not.
  const direct = TEXT_DIRECT_KEYS.find(([prefix]) => modelName.startsWith(prefix));
  const textOk = (direct !== undefined && isSet(direct[1])) || isSet(TEXT_FALLBACK_KEY);
  const textMissing = direct ? [direct[1], TEXT_FALLBACK_KEY] : [TEXT_FALLBACK_KEY];

  // A model in the media catalog needs its own provider too — the text route
  // carries the request, the media provider answers it.
  const mediaKeys = mediaProviderKeys(modelName);
  if (mediaKeys !== null) {
    const mediaOk = mediaKeys.some(isSet);
    if (mediaOk && textOk) return { ok: true, missing: [] };
    return {
      ok: false,
      missing: [...(mediaOk ? [] : mediaKeys), ...(textOk ? [] : textMissing)],
    };
  }

  if (textOk) return { ok: true, missing: [] };
  return { ok: false, missing: textMissing };
}

/**
 * Refuse to start a skill whose model has no reachable provider.
 * @param skillName - The skill, named so the message says which one.
 * @param modelName - The model it declared, or undefined when it declared none.
 * @throws {AppError} 503 when no provider for that model has a key configured.
 */
export function assertSkillModelRunnable(
  skillName: string,
  modelName: string | undefined,
): void {
  const { ok } = checkSkillModelRunnable(modelName);
  if (ok) return;
  // 503 rather than 500: nothing is broken, something is not configured, and
  // the fix is an operator's rather than a developer's.
  //
  // The message reaches the end user, not the operator — the error handler
  // returns `AppError.message` verbatim — so it says which skill and nothing
  // else. The env var names go to the caller in `missing`, for the layer that
  // knows where its logs go; naming them here would put the deployment's
  // configuration on a screen belonging to whoever happened to click.
  throw new AppError(
    503,
    `Skill '${skillName}' is not available on this deployment.`,
  );
}
