// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { assertBindsCatalog, parseProviderConfig, type CatalogShape, type ProviderConfigInput } from "../schema.js";

const ROOT = resolve(__dirname, "../../../../..");
const MODALITIES = ["image", "video", "audio", "tts", "three_d"] as const;

/**
 * Read a yaml file under the repository's `config/`.
 * @param path - The path below `config/`.
 * @returns Its content.
 */
const yaml = <T>(path: string): T => parse(readFileSync(resolve(ROOT, "config", path), "utf8")) as T;

/**
 * The provider configuration this repository ships, as an entry reads it.
 * @returns The raw configuration.
 */
function shipped(): ProviderConfigInput {
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
function catalog(): CatalogShape {
  const files = ["image/models.yaml", "video/models.yaml", "audio/models.yaml", "tts/models.yaml", "three_d/meshy.yaml", "three_d/hunyuan3d.yaml"];
  return { models: files.flatMap((f) => yaml<CatalogShape>(`models/${f}`).models.map(({ name, params }) => ({ name, params: params ?? {} }))) };
}

describe("the shipped provider configuration (design 4.1)", () => {
  it("loads, and binds every catalog model and param", () => {
    const config = parseProviderConfig(shipped());
    expect(() => assertBindsCatalog(config, catalog())).not.toThrow();
  });

  it("puts every catalog model on WaveSpeed at weight 1", () => {
    const { models } = parseProviderConfig(shipped());
    const off = Object.entries(models).filter(([, bindings]) => bindings.find((b) => b.upstream === "wavespeed")?.weight !== 1);
    expect(off.map(([name]) => name)).toEqual([]);
  });

  it("reaches each vendor at the address its SDK answers on", () => {
    const { upstreams } = shipped();
    expect(upstreams.deepseek?.base_url).toBe("https://api.deepseek.com");
    expect(upstreams.openrouter?.base_url).toBe("https://openrouter.ai/api/v1");
    expect(upstreams.wavespeed?.base_url).toBe("https://api.wavespeed.ai/api/v3");
  });

  it("routes each direct vendor first and OpenRouter after it, and reads understanding through OpenRouter first", () => {
    const { llm } = shipped();
    for (const prefix of ["anthropic/", "deepseek/", "google/", "openai/"]) {
      const route = llm?.routes.find((r) => r.prefix === prefix);
      expect(route?.upstreams.find((u) => u.upstream === "openrouter")?.weight).toBe(1);
      expect(route?.upstreams.find((u) => u.upstream !== "openrouter")?.weight).toBe(0);
    }
    expect(llm?.routes.at(-1)).toEqual({ prefix: "", upstreams: [{ upstream: "openrouter", weight: 0 }] });
    expect(llm?.understand_routes?.find((r) => r.prefix === "google/")?.upstreams[0]).toEqual({ upstream: "openrouter", weight: 0 });
  });

  it("ships the deployment override only as a template", () => {
    expect(existsSync(resolve(ROOT, "config/provider/routing.yaml.template"))).toBe(true);
    expect(() => parseProviderConfig({ ...shipped(), routing: yaml("provider/routing.yaml.template") ?? undefined })).not.toThrow();
  });
});
