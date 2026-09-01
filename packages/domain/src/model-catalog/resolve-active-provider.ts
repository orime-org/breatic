// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Which upstream a model runs on in this deployment, and the key to reach it.
 *
 * A model may declare several providers; which one answers is decided by
 * priority order and by which keys this deployment configured. Two callers
 * need that answer and must not disagree: the worker, which sends the
 * generation, and the voice catalog endpoint, which must list voices in the
 * value domain of the very provider the generation will go to.
 */

import { env } from "@breatic/core";

import {
  getFullModelConfig,
  type FullModelEntry,
  type FullProviderEndpoint,
  type ProviderConnectionConfig,
} from "@domain/model-catalog/model-catalog.js";

/** A model paired with the provider that will actually serve it. */
export interface ActiveProvider {
  modelName: string;
  /** Full yaml entry for the model, so callers read cost / params off one lookup. */
  modelConfig: FullModelEntry;
  providerName: string;
  /** This model's line for that provider (model_id, prices, extra params). */
  providerEntry: FullProviderEndpoint;
  /** Vendor id of the model on that provider. */
  modelId: string;
  baseUrl: string;
  apiKey: string;
  timeout: number;
  maxConcurrency: number;
}

/**
 * Read a provider's API key out of the injected configuration.
 *
 * Reads the `env` proxy, which answers only for names core's schema declares.
 * Three yaml-declared names are outside it today (`KLING_ACCESS_KEY`,
 * `GEMINI_API_KEY`, `DEEPSEEK_API_KEY`), so those providers resolve as
 * keyless however the deployment is configured — a standing gap tracked
 * separately, kept exactly as it is here because moving this rule must not
 * change which upstream a generation goes to.
 * @param envVarName - The var name declared as `api_key_env` in providers.yaml.
 * @returns The key, or an empty string when unset.
 */
function readApiKey(envVarName: string): string {
  if (!envVarName) return "";
  const value = (env as Record<string, unknown>)[envVarName];
  return typeof value === "string" ? value : "";
}

/**
 * Build the credential string a provider's transport reads.
 *
 * A vendor that authenticates with a key pair gets both halves joined by a
 * colon, which is the shape its transport splits on. Half a pair counts as no
 * credential at all: a token signed with an empty secret is one the vendor
 * rejects, so a half-configured deployment would look configured and fail
 * every request rather than falling through to the next provider.
 * @param connection - The provider's entry from providers.yaml.
 * @returns The credential, or an empty string when the provider is unconfigured.
 */
function readCredential(connection: ProviderConnectionConfig): string {
  const key = readApiKey(connection.api_key_env ?? "");
  if (!connection.api_secret_env) return key;

  const secret = readApiKey(connection.api_secret_env);
  return key && secret ? `${key}:${secret}` : "";
}

/**
 * Resolve a model to the provider this deployment will actually call.
 * @param modality - The modality directory the model lives in.
 * @param modelName - The model's catalog name.
 * @returns The model paired with its serving provider and connection details.
 * @throws {Error} When the model is not in the catalog, or no provider of it
 *   has an API key configured.
 */
export function resolveActiveProvider(
  modality: string,
  modelName: string | undefined,
): ActiveProvider {
  if (!modelName) throw new Error("model_name is required");

  const config = getFullModelConfig(modality);
  const modelConfig = config.models.find((m) => m.name === modelName);
  if (!modelConfig) throw new Error(`Model '${modelName}' not found`);

  const byPriority = [...(modelConfig.providers ?? [])].sort(
    (a, b) => (a.priority ?? 99) - (b.priority ?? 99),
  );

  for (const entry of byPriority) {
    const connection: ProviderConnectionConfig = config.providers[entry.name] ?? {};
    const apiKey = readCredential(connection);
    if (!apiKey) continue;

    return {
      modelName: modelConfig.name,
      modelConfig,
      providerName: entry.name,
      providerEntry: entry,
      modelId: entry.model_id,
      baseUrl: connection.base_url ?? "",
      apiKey,
      timeout: connection.timeout ?? 120,
      maxConcurrency: connection.max_concurrency ?? 50,
    };
  }

  throw new Error(
    `No provider with active API key for model '${modelConfig.name}'. Check your .env file.`,
  );
}
