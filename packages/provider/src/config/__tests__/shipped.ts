// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import type { CatalogShape, ProviderConfigInput } from "../schema.js";

export const ROOT = resolve(__dirname, "../../../../..");
const MODALITIES = ["image", "video", "audio", "tts", "three_d"] as const;

/**
 * Read a yaml file under the repository's `config/`.
 * @param path - The path below `config/`.
 * @returns Its content.
 */
export const yaml = <T>(path: string): T => parse(readFileSync(resolve(ROOT, "config", path), "utf8")) as T;

/**
 * The provider configuration this repository ships, as an entry reads it.
 * @returns The raw configuration.
 */
export function shipped(): ProviderConfigInput {
  const models: ProviderConfigInput["media"]["models"] = {};
  for (const modality of MODALITIES) Object.assign(models, yaml<{ models: ProviderConfigInput["media"]["models"] }>(`provider/media/${modality}.yaml`).models);
  return {
    upstreams: yaml<{ upstreams: ProviderConfigInput["upstreams"] }>("provider/upstreams.yaml").upstreams,
    media: { models },
    llm: yaml<NonNullable<ProviderConfigInput["llm"]>>("provider/llm.yaml"),
  };
}

/**
 * Our catalog: every model and the values each param offers.
 * @returns The catalog.
 */
export function catalog(): CatalogShape {
  const files = ["image/models.yaml", "video/models.yaml", "audio/models.yaml", "tts/models.yaml", "three_d/meshy.yaml", "three_d/hunyuan3d.yaml"];
  return { models: files.flatMap((f) => yaml<CatalogShape>(`models/${f}`).models.map(({ name, params }) => ({ name, params: params ?? {} }))) };
}
