// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

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
 * Written once, in domain, because both services reach it: the entries ask
 * before a message is saved or a stream opened, and the factory asks again
 * when it resolves a model — which is the only way the worker reaches it, on
 * a job it has already claimed. Two copies would answer differently the
 * first time a fallback rule changed.
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
import { t } from "@breatic/shared";
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
 * Find a model in the media catalog and list what each of its providers needs.
 *
 * Grouped per provider rather than flattened, because reachability is decided
 * per provider: one of them fully configured makes the model runnable, and a
 * provider authenticated by a key pair needs both halves to count. Flattening
 * first would call a deployment with one half of one pair runnable, which is
 * not how `resolveActiveProvider` reads the same yaml.
 * @param modelName - The model a skill named.
 * @returns One group of env var names per provider, or null when no modality
 *   has this model.
 */
function mediaProviderKeyGroups(modelName: string): string[][] | null {
  for (const modality of MODALITIES) {
    const config = getFullModelConfig(modality);
    const entry = config.models.find((m) => m.name === modelName);
    if (!entry) continue;
    const groups: string[][] = [];
    for (const p of entry.providers ?? []) {
      const connection = config.providers[p.name];
      const group = [connection?.api_key_env, connection?.api_secret_env].filter(
        (name): name is string => Boolean(name),
      );
      if (group.length > 0) groups.push(group);
    }
    return groups;
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
  const mediaGroups = mediaProviderKeyGroups(modelName);
  if (mediaGroups !== null) {
    const mediaOk = mediaGroups.some((group) => group.every(isSet));
    if (mediaOk && textOk) return { ok: true, missing: [] };
    return {
      ok: false,
      missing: [...(mediaOk ? [] : mediaGroups.flat()), ...(textOk ? [] : textMissing)],
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
  // else. Naming the env vars here would put the deployment's configuration
  // on a screen belonging to whoever happened to click. They are available
  // from {@link checkSkillModelRunnable} for a caller that wants to log them;
  // nothing does that yet, and this throw deliberately does not.
  throw new AppError(
    503,
    t("server.skill.not_available_on_deployment", { skill: skillName }),
  );
}
