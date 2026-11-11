// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { mkdirSync, mkdtempSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeAll } from "vitest";
import { initCore, MONOREPO_ROOT } from "@breatic/core";
import { initProvider, provider } from "../instance.js";
import { readProviderConfig } from "../provider-config-loader.js";

beforeAll(() => {
  initCore({ ...process.env, OPENROUTER_API_KEY: "or-test" });
});

describe("the provider instance of this process", () => {
  it("reads the shipped configuration whole, every media modality included", () => {
    const config = readProviderConfig();
    expect(Object.keys(config.upstreams)).toEqual(expect.arrayContaining(["wavespeed", "fal", "sandbase", "openrouter"]));
    expect(Object.keys(config.media.models)).toContain("mureka-v9.5-generate-song");
    expect(config.llm?.routes.length).toBeGreaterThan(0);
  });

  it("reads the deployment's routing overrides when the file is there, and none when it is not", () => {
    const root = mkdtempSync(join(tmpdir(), "provider-config-"));
    cpSync(join(MONOREPO_ROOT, "config/provider"), join(root, "config/provider"), { recursive: true });
    expect(readProviderConfig(root).routing).toBeUndefined();
    mkdirSync(join(root, "config/provider"), { recursive: true });
    writeFileSync(join(root, "config/provider/routing.yaml"), "models:\n  mureka-v9.5-generate-song:\n    weights: { wavespeed: 5 }\n");
    expect(readProviderConfig(root).routing).toEqual({ models: { "mureka-v9.5-generate-song": { weights: { wavespeed: 5 } } } });
  });

  it("builds one instance from it that reads keys from the injected environment", () => {
    const built = initProvider();
    expect(provider()).toBe(built);
    expect(provider().llm.availability("anthropic/claude-opus-5.5", "call").upstreams.find((u) => u.upstream === "openrouter")?.configured).toBe(true);
  });
});

describe("a provider handed over", () => {
  it("is the one the process uses, in place of the configured one", () => {
    const handed = { llm: {} } as unknown as ReturnType<typeof provider>;
    expect(initProvider(handed)).toBe(handed);
    expect(provider()).toBe(handed);
  });
});
