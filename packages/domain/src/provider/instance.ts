// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * This process's provider (inner#1743): the one way server and worker reach a model. Each service entry calls
 * `initProvider()` once after `initCore`; everything else reads it through `provider()`.
 */

import { getAgentConfig, getRawEnvVar } from "@breatic/core";
import { createProvider, type CatalogShape, type Provider } from "@breatic/provider";
import { stripUnicodeTags } from "@breatic/shared";
import { readProviderConfig } from "@domain/provider/provider-config-loader.js";
import { getFullModelConfig, MODALITIES, type FullModelEntry } from "@domain/model-catalog/model-catalog.js";

let instance: Provider | undefined;

/**
 * Build this process's provider: keys read from the environment `initCore` was given.
 * @param built - A provider built elsewhere, which a test hands over in place of the configured one.
 * @returns The provider.
 * @throws {ProviderConfigError} When the configuration does not validate, or does not bind every model and param of
 *   our catalog, every problem named.
 */
export function initProvider(built?: Provider): Provider {
  if (built !== undefined) {
    instance = built;
    return instance;
  }
  const configured = createProvider({
    config: readProviderConfig(),
    keyOf: getRawEnvVar,
    llmMaxRetries: getAgentConfig().llm_max_retries,
    cleanText: stripUnicodeTags,
  });
  configured.assertBindsCatalog({ models: MODALITIES.flatMap((modality) => getFullModelConfig(modality).models.map(catalogShapeOf)) });
  instance = configured;
  return instance;
}

/**
 * One catalog model as provider checks its bindings against: each param's offered values and how it travels.
 * @param model - The yaml entry.
 * @returns Its shape.
 */
function catalogShapeOf(model: FullModelEntry): CatalogShape["models"][number] {
  return {
    name: model.name,
    params: Object.fromEntries(Object.entries(model.params ?? {}).map(([name, spec]) => [name, {
      ...(spec.values === undefined ? {} : { values: spec.values as (string | number | boolean)[] }),
      ...(typeof spec.joins === "string" ? { joins: spec.joins } : {}),
      ...(spec.type === undefined ? {} : { type: spec.type }),
      ...(spec.fields === undefined ? {} : { fields: spec.fields }),
      ...(spec.remote_source === undefined ? {} : { remote_source: spec.remote_source }),
    }])),
  };
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
