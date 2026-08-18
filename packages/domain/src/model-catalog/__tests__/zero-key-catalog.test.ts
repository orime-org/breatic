// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * 目录对「一个 provider key 都没配」的部署给出什么答案（#1951）。
 *
 * 这里问的是「有没有」，不是「填的对不对」：`available` 的判据只是那个环境
 * 变量非空，key 有效不有效我们不检查（user 2026-08-18 明确把两者分开）。
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { initCore } from "@breatic/core";

import {
  getModelCatalog,
  getFullModelConfig,
  resetModelCatalog,
  MODALITIES,
} from "../model-catalog.js";

/**
 * 目录里每个 provider 声明的那个环境变量名。零 key 要构造得准，就得把它们
 * 一个不落地清空 —— 漏一个，那个 provider 还是「配了」，走的就是另一支。
 * @returns 全部 provider 的 `api_key_env` 变量名。
 */
function allProviderKeyNames(): string[] {
  const names = new Set<string>();
  for (const modality of MODALITIES) {
    for (const config of Object.values(getFullModelConfig(modality).providers)) {
      if (config.api_key_env) names.add(config.api_key_env);
    }
  }
  return [...names];
}

/**
 * 把这些 provider key 设成空串，其余环境变量原样保留，注入 core 并清掉目录
 * 缓存。传空数组就是「一个 key 都没配」。
 * @param configured - 要保留成非空的 key 名（其余全部清空）。
 */
function useEnvWithKeys(configured: readonly string[]): void {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const name of allProviderKeyNames()) {
    env[name] = configured.includes(name) ? "test-key" : "";
  }
  initCore(env);
  resetModelCatalog();
}

beforeEach(() => {
  initCore(process.env);
  resetModelCatalog();
});

afterAll(() => {
  initCore(process.env);
  resetModelCatalog();
});

describe("零 key 的部署 (#1951)", () => {
  it("一个 provider key 都没配时，目录是空的", () => {
    useEnvWithKeys([]);
    const catalog = getModelCatalog();
    // 逐个模态断言，而不是只看 total —— total 为 0 也可能是别的原因，
    // 而这条要说的是「每个桶都空」。
    for (const modality of MODALITIES) {
      expect(catalog[modality], `${modality} 桶`).toHaveLength(0);
    }
    expect(catalog.total).toBe(0);
  });

  it("配了一个 provider key 时，只返回那个 provider 能跑的模型", () => {
    const [first] = allProviderKeyNames();
    expect(first, "目录里至少要有一个声明了 api_key_env 的 provider").toBeDefined();
    useEnvWithKeys([first as string]);
    const catalog = getModelCatalog();

    const models = MODALITIES.flatMap((m) => catalog[m]);
    expect(models.length, "配了 key 就该有模型能用").toBeGreaterThan(0);
    // 留下来的每一个都至少有一个 available 的 provider —— 这是既有行为，
    // 本次不动它，写在这里是为了改零 key 那一支时它会红。
    for (const model of models) {
      expect(
        model.providers.some((p) => p.available),
        `${model.name} 一个可用 provider 都没有，不该留在目录里`,
      ).toBe(true);
    }
  });
});
