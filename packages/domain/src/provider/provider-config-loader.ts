// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/** Reads the provider configuration once, at service start (`initProvider`). */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { MONOREPO_ROOT } from "@breatic/core";
import type { ProviderConfigInput } from "@breatic/provider";

/**
 * One yaml file under the repository's `config/`.
 * @param root - The repository root.
 * @param path - The file, relative to `config/`.
 * @returns Its parsed content.
 * @throws {Error} When the file cannot be read or parsed.
 */
function yamlAt<T>(root: string, path: string): T {
  return parse(readFileSync(join(root, "config", path), "utf8")) as T;
}

/**
 * The provider configuration as the repository and the deployment hold it: `config/provider/upstreams.yaml`,
 * `llm.yaml`, every `media/*.yaml`, and the deployment's `routing.yaml` when it has one. provider validates it.
 * @param root - The repository root.
 * @returns The configuration, unvalidated.
 * @throws {Error} When a shipped file cannot be read or parsed.
 */
export function readProviderConfig(root: string = MONOREPO_ROOT): ProviderConfigInput {
  const models: ProviderConfigInput["media"]["models"] = {};
  for (const file of readdirSync(join(root, "config/provider/media")).filter((f) => f.endsWith(".yaml")).sort()) {
    Object.assign(models, yamlAt<{ models: ProviderConfigInput["media"]["models"] }>(root, `provider/media/${file}`).models);
  }
  const routing = join(root, "config/provider/routing.yaml");
  return {
    upstreams: yamlAt<{ upstreams: ProviderConfigInput["upstreams"] }>(root, "provider/upstreams.yaml").upstreams,
    media: { models },
    llm: yamlAt<NonNullable<ProviderConfigInput["llm"]>>(root, "provider/llm.yaml"),
    ...(existsSync(routing) ? { routing: yamlAt<NonNullable<ProviderConfigInput["routing"]>>(root, "provider/routing.yaml") } : {}),
  };
}
