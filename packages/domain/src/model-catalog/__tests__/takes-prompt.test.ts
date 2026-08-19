// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * `takes_prompt` (#1966) — whether a model consumes the text the user writes.
 *
 * Before this, the answer had no single home: the video panel derived it from
 * a `params.prompt` declaration, the image panel hardcoded `true`, and the two
 * catalogs wrote that declaration by different conventions — not one image
 * model states it, so the video panel's derivation applied to the image
 * catalog would have turned the requirement off for every image model at once.
 *
 * These tests pin the field against the REAL config files, because the point of
 * the field is that every model states it. A fixture would only prove the
 * loader can read a field; only the real catalog proves nobody forgot one.
 */

import { describe, it, expect, beforeAll, afterEach, afterAll, vi } from "vitest";

import {
  MODALITIES,
  getFullModelConfig,
  getModelCatalog,
  resetModelCatalog,
} from "../model-catalog.js";
import { assertTakesPromptDeclared } from "../takes-prompt.js";
import { restoreProcessEnv, useFullCatalog } from "./catalog-env.js";

// 目录一律按 provider 可用性过滤（#1951），而 CI 跑单测时一个 key 都不设 ——
// 不声明这个前提，`getModelCatalog()` 在 CI 上返回空目录。这个文件里读它的
// 那一条（「投影到每个目录条目上」）会拿空数组算出一个空的未声明集合、照样
// 通过，什么都没验到。其余用例读的是 `getFullModelConfig`（直接读 yaml、不过
// 可用性过滤），本来就不受影响。
beforeAll(() => {
  useFullCatalog();
});

afterAll(() => {
  restoreProcessEnv();
});

describe("takes_prompt is declared by every model (#1966)", () => {
  it.each(MODALITIES)("every %s model declares it", (modality) => {
    const config = getFullModelConfig(modality);
    const missing = config.models
      .filter((m) => typeof m.takes_prompt !== "boolean")
      .map((m) => m.name);
    expect(missing).toEqual([]);
  });

  it("covers all 42 catalogued models across the six modalities", () => {
    const total = MODALITIES.reduce(
      (sum, m) => sum + getFullModelConfig(m).models.length,
      0,
    );
    expect(total).toBe(42);
  });
});

describe("takes_prompt reaches the frontend on the wire (#1966)", () => {
  it("is projected onto every catalog entry", () => {
    const catalog = getModelCatalog();
    const undeclared = MODALITIES.flatMap((m) =>
      catalog[m].filter((e) => typeof e.takes_prompt !== "boolean").map((e) => e.name),
    );
    expect(undeclared).toEqual([]);
  });
});

describe("the values the panels will read (#1966)", () => {
  /**
   * Look a model up across the whole catalog.
   * @param name - The model name as authored in yaml.
   * @returns That model's `takes_prompt`.
   * @throws {Error} when no catalogued model carries that name.
   */
  function takesPromptOf(name: string): boolean {
    const config = MODALITIES.map((m) => getFullModelConfig(m))
      .flatMap((c) => c.models)
      .find((m) => m.name === name);
    if (!config) throw new Error(`no catalogued model named '${name}'`);
    return config.takes_prompt as boolean;
  }

  // 口播档的模型：#1950 实测过，写了字也不影响出片。
  it("omnihuman-1.5 does not take one", () => {
    expect(takesPromptOf("omnihuman-1.5")).toBe(false);
  });

  // 后处理两个：放大和补帧没有文本输入。
  it.each(["video-upscale-pro", "rife-interpolation"])(
    "%s does not take one",
    (name) => {
      expect(takesPromptOf(name)).toBe(false);
    },
  );

  // 这四个是本次要闭合的那个缺口：文生图显然要提示词，而它们一个都没在
  // params 里声明过，所以旧那条 `params.prompt != null` 会把它们全判成不要。
  it.each([
    "midjourney-v7",
    "nano-banana-2",
    "nano-banana-pro",
    "seedream-5.0-lite",
  ])("%s takes one even though it never declared a prompt param", (name) => {
    expect(takesPromptOf(name)).toBe(true);
  });

  // 上游文档说提示词可选但接受（设计 §4.2）——可选也是吃。
  it("veo-3.1-extend takes one (upstream calls it optional, not absent)", () => {
    expect(takesPromptOf("veo-3.1-extend")).toBe(true);
  });

  // 我们自己给它写了转发分支，而 runUnderstand 保证 prompt 恒非空。
  it("whisper-turbo takes one (we forward a guidance prompt to it)", () => {
    expect(takesPromptOf("whisper-turbo")).toBe(true);
  });
});

describe("assertTakesPromptDeclared (#1966)", () => {
  it("passes when every model states it", () => {
    expect(() =>
      assertTakesPromptDeclared("video", [
        { name: "a", takes_prompt: true },
        { name: "b", takes_prompt: false },
      ]),
    ).not.toThrow();
  });

  // 缺省不许等于 false：漏写的人本来想说的是 true 的概率跟 false 一样大,
  // 而静默取 false 会把提示词框关掉、没有任何东西会响。
  it("throws naming the modality and every model that forgot", () => {
    expect(() =>
      assertTakesPromptDeclared("image", [
        { name: "declared", takes_prompt: true },
        { name: "forgot-one" },
        { name: "forgot-two" },
      ]),
    ).toThrow(/image.*forgot-one.*forgot-two/s);
  });

  it("rejects a non-boolean rather than coercing it", () => {
    expect(() =>
      assertTakesPromptDeclared("audio", [
        { name: "stringly", takes_prompt: "true" as unknown as boolean },
      ]),
    ).toThrow(/stringly/);
  });
});

// 上面那组测的是校验函数本身。这一组测的是它真的接在加载路径上——
// 变异验证发现少了它：把 `assertTakesPromptDeclared(modality, models)` 从
// loader 里删掉，前面 20 条照样全绿，因为真实 yaml 现在每个都写了字段。
// 所以要喂一份缺字段的 yaml 才钉得住这条接线。
describe("the loader refuses a modality whose yaml forgot it (#1966)", () => {
  afterEach(() => {
    vi.doUnmock("node:fs");
    vi.resetModules();
    resetModelCatalog();
  });

  it("throws instead of loading a model with no takes_prompt", async () => {
    vi.resetModules();
    vi.doMock("node:fs", () => ({
      readdirSync: () => ["fixture.yaml"],
      existsSync: () => false,
      readFileSync: () =>
        [
          "models:",
          '  - name: "declared"',
          '    mode: "t2v"',
          "    takes_prompt: true",
          '  - name: "forgot"',
          '    mode: "t2v"',
        ].join("\n"),
    }));
    const mod = await import("../model-catalog.js");
    expect(() => mod.getFullModelConfig("video")).toThrow(/forgot/);
  });

  it("loads fine when the same yaml declares it", async () => {
    vi.resetModules();
    vi.doMock("node:fs", () => ({
      readdirSync: () => ["fixture.yaml"],
      existsSync: () => false,
      readFileSync: () =>
        [
          "models:",
          '  - name: "declared"',
          '    mode: "t2v"',
          "    takes_prompt: true",
        ].join("\n"),
    }));
    const mod = await import("../model-catalog.js");
    expect(mod.getFullModelConfig("video").models).toHaveLength(1);
  });
});
