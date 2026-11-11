// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * This process's provider (inner#1743): the one way server and worker reach a model. Each service entry calls
 * `initProvider()` once after `initCore`; everything else reads it through `provider()`.
 */

import { getAgentConfig, getRawEnvVar } from "@breatic/core";
import { createProvider, type Provider } from "@breatic/provider";
import { stripUnicodeTags } from "@breatic/shared";
import { readProviderConfig } from "@domain/provider/provider-config-loader.js";

let instance: Provider | undefined;

/**
 * Build this process's provider: keys read from the environment `initCore` was given.
 * @returns The provider.
 * @throws {ProviderConfigError} When the configuration does not validate, every problem named.
 */
export function initProvider(): Provider {
  instance = createProvider({
    config: readProviderConfig(),
    keyOf: getRawEnvVar,
    llmMaxRetries: getAgentConfig().llm_max_retries,
    cleanText: stripUnicodeTags,
  });
  return instance;
}

/**
 * This process's provider.
 * @returns It.
 * @throws {Error} When the service entry has not called `initProvider`.
 */
export function provider(): Provider {
  if (instance === undefined) throw new Error("provider() before initProvider(): the service entry builds the provider once at start");
  return instance;
}
