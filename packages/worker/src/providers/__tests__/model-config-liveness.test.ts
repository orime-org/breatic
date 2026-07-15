// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Model config liveness + consistency guards (#1683).
 *
 * WaveSpeed's public catalog drifts over time (models get delisted or
 * renamed) and config/models/*.yaml has no runtime check against that.
 * These tests pin two invariants:
 *
 * 1. Tombstones — no config entry may point at a WaveSpeed model id that
 *    the 2026-07-15 catalog audit (#1683) confirmed delisted or renamed
 *    (evidence: wavespeed.ai sitemap inventory + per-model page checks).
 * 2. Image yaml model names and worker image family MODELS sets stay in
 *    sync, so a config edit cannot orphan a family entry or ship a yaml
 *    model that no family can build requests for.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { parse } from "yaml";
import { describe, expect, it, vi } from "vitest";

// nano-banana is the only image family with runtime imports (Vercel AI SDK +
// domain); stub them so this test only pulls its pure MODELS set.
vi.mock("ai", () => ({ stepCountIs: (): undefined => undefined }));
vi.mock("@breatic/domain", () => ({
  generateTextRetry: (): undefined => undefined,
  getModel: (): undefined => undefined,
}));

import backgroundRemove from "@worker/providers/image/models/background-remove.js";
import midjourney from "@worker/providers/image/models/midjourney.js";
import nanoBanana from "@worker/providers/image/models/nano-banana.js";
import qwen from "@worker/providers/image/models/qwen.js";
import seedream from "@worker/providers/image/models/seedream.js";
import topaz from "@worker/providers/image/models/topaz.js";

const CONFIG_MODELS_DIR = resolve(import.meta.dirname, "../../../../../config/models");

/** WaveSpeed model ids confirmed delisted in the 2026-07-15 audit (#1683). */
const DELISTED_WAVESPEED_IDS: ReadonlySet<string> = new Set([
  "midjourney/image-to-image",
  "midjourney/niji/image-to-image",
  "midjourney/niji/text-to-image",
  "topaz/image/enhance",
  "wavespeed-ai/rife/video-interpolation",
]);

interface YamlProvider {
  name: string;
  model_id: string;
}

interface YamlModel {
  name: string;
  providers?: YamlProvider[];
}

interface ConfigEntry {
  file: string;
  model: YamlModel;
}

/**
 * Load every model entry from config/models/<modality>/*.yaml.
 * @returns Flat list of yaml model entries with their source file
 */
function loadAllModelEntries(): ConfigEntry[] {
  const entries: ConfigEntry[] = [];
  for (const modality of readdirSync(CONFIG_MODELS_DIR)) {
    const modalityDir = join(CONFIG_MODELS_DIR, modality);
    if (!statSync(modalityDir).isDirectory()) continue;
    for (const file of readdirSync(modalityDir)) {
      if (!file.endsWith(".yaml") || file === "providers.yaml") continue;
      const raw = parse(readFileSync(join(modalityDir, file), "utf-8")) as {
        models?: YamlModel[];
      } | null;
      for (const model of raw?.models ?? []) {
        entries.push({ file: `${modality}/${file}`, model });
      }
    }
  }
  return entries;
}

describe("model config liveness (#1683)", () => {
  it("references no WaveSpeed model id delisted in the 2026-07-15 catalog audit", () => {
    const violations: string[] = [];
    for (const { file, model } of loadAllModelEntries()) {
      for (const provider of model.providers ?? []) {
        if (provider.name !== "wavespeed") continue;
        if (DELISTED_WAVESPEED_IDS.has(provider.model_id)) {
          violations.push(`${file} -> ${model.name} -> ${provider.model_id}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("keeps image yaml model names in sync with worker image family MODELS", () => {
    const yamlNames = loadAllModelEntries()
      .filter((entry) => entry.file.startsWith("image/"))
      .map((entry) => entry.model.name)
      .sort();
    const familyNames = [
      backgroundRemove,
      midjourney,
      nanoBanana,
      qwen,
      seedream,
      topaz,
    ]
      .flatMap((family) => [...family.MODELS])
      .sort();
    expect(yamlNames).toEqual(familyNames);
  });
});
