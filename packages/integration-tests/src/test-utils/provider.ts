// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * This process's provider for a suite that drives the app `createApp` builds, which the service entry would otherwise
 * build at start (inner#1743): the shipped configuration, with every upstream's key set, so every model is servable and
 * priced as on a deployment that configured them all. A suite whose run would reach an upstream stubs `ai` or the
 * worker's transport; the key reaches no network.
 */

import { createProvider } from "@breatic/provider";
import { initProvider, readProviderConfig } from "@breatic/domain";

/** The key every upstream is given. */
const SUITE_KEY = "integration-suite-key";

/**
 * Build this process's provider from the shipped configuration, every upstream's key set.
 * @throws {ProviderConfigError} When the shipped configuration does not validate.
 */
export function initConfiguredProvider(): void {
  initProvider(createProvider({ config: readProviderConfig(), keyOf: () => SUITE_KEY, llmMaxRetries: 0, cleanText: (text) => text }));
}
