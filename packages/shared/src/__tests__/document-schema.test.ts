// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * document space 的 schema 契约：配置文件长什么样，以及「我这份跟服务器那份
 * 一样不一样」的判定。
 *
 * 数据本身不在这儿，在 `config/document-schema.yaml`：collab 启动时读它，
 * 前端打包时把同一份打进 bundle。这里只有形状和判定。
 *
 * **判定看的是版本号，问的是「一不一样」**，不是谁新谁旧（user 2026-08-14）。
 */

import { describe, it, expect } from "vitest";

import {
  DOCUMENT_SCHEMA_META_KEY,
  documentSchemaConfigSchema,
  documentSchemaDiffers,
  documentSchemaMatches,
  publishedSchemaVersion,
} from "@shared/document-schema.js";

describe("配置文件的形状", () => {
  it("键名就是 meta 文档里那个顶层键", () => {
    expect(DOCUMENT_SCHEMA_META_KEY).toBe("documentSchema");
  });

  it("收下版本号加两张清单", () => {
    const parsed = documentSchemaConfigSchema.parse({
      version: 3,
      nodes: { doc: [], heading: ["level"] },
      marks: { bold: [] },
    });
    expect(parsed.version).toBe(3);
    expect(parsed.nodes.heading).toEqual(["level"]);
  });

  it("属性名进来时就排好序 —— 两份内容相同的清单不该因为写的顺序不同而看起来不同", () => {
    const parsed = documentSchemaConfigSchema.parse({
      version: 1,
      nodes: { heading: ["level", "align"] },
      marks: { link: ["target", "href"] },
    });
    expect(parsed.nodes.heading).toEqual(["align", "level"]);
    expect(parsed.marks.link).toEqual(["href", "target"]);
  });

  it("版本号必须是正整数 —— 缺了、是小数、是零，都在加载时就失败", () => {
    const lists = { nodes: {}, marks: {} };
    expect(() => documentSchemaConfigSchema.parse({ ...lists })).toThrow();
    expect(() => documentSchemaConfigSchema.parse({ version: 1.5, ...lists })).toThrow();
    expect(() => documentSchemaConfigSchema.parse({ version: 0, ...lists })).toThrow();
    expect(() => documentSchemaConfigSchema.parse({ version: "1", ...lists })).toThrow();
  });
});

describe("从 meta 里读版本号", () => {
  it("读得出来", () => {
    expect(publishedSchemaVersion({ version: 7, nodes: {}, marks: {} })).toBe(7);
  });

  it("读不出来的一律 null：没有这个键、不是数、不是正整数、根本不是对象", () => {
    expect(publishedSchemaVersion(undefined)).toBeNull();
    expect(publishedSchemaVersion(null)).toBeNull();
    expect(publishedSchemaVersion({})).toBeNull();
    expect(publishedSchemaVersion({ version: "3" })).toBeNull();
    expect(publishedSchemaVersion({ version: 2.5 })).toBeNull();
    expect(publishedSchemaVersion({ version: 0 })).toBeNull();
    expect(publishedSchemaVersion({ version: -1 })).toBeNull();
    expect(publishedSchemaVersion("nonsense")).toBeNull();
    expect(publishedSchemaVersion(42)).toBeNull();
  });
});

describe("判定：我这份跟 meta 里那份一样不一样", () => {
  it("一样 → 不算不一致", () => {
    expect(documentSchemaDiffers(2, { version: 2 })).toBe(false);
  });

  it("服务器比我新 → 不一致", () => {
    expect(documentSchemaDiffers(2, { version: 3 })).toBe(true);
  });

  it("服务器比我旧 → 一样算不一致 —— 问的是一不一样，不是谁新谁旧", () => {
    expect(documentSchemaDiffers(3, { version: 2 })).toBe(true);
  });

  it("清单内容不参与比较 —— 版本号一样就是一样", () => {
    expect(
      documentSchemaDiffers(2, {
        version: 2,
        nodes: { taskList: [] },
        marks: {},
        publishedAt: "2026-08-14T00:00:00.000Z",
      }),
    ).toBe(false);
  });

  it("meta 里根本没有这份数据 → 不算不一致", () => {
    // 没有信息不等于不一致：老 project 的 meta 还没被写过，
    // 这时候拦住用户是拿我们自己的空白去惩罚他。
    expect(documentSchemaDiffers(1, undefined)).toBe(false);
    expect(documentSchemaDiffers(1, null)).toBe(false);
  });

  it("meta 里那份形状不对 → 不算不一致", () => {
    // 形状不对说明是我们自己写坏了，不该让用户为它买单；
    // 而且这时候也说不出服务器到底是哪一版。
    expect(documentSchemaDiffers(1, "nonsense")).toBe(false);
    expect(documentSchemaDiffers(1, {})).toBe(false);
    expect(documentSchemaDiffers(1, { version: "1" })).toBe(false);
  });
});

describe("判定：meta 里那份就是我这一版吗", () => {
  it("一样 → 是", () => {
    expect(documentSchemaMatches(2, { version: 2, publishedAt: "x" })).toBe(true);
  });

  it("不一样 → 不是，哪个方向都一样", () => {
    expect(documentSchemaMatches(2, { version: 3 })).toBe(false);
    expect(documentSchemaMatches(3, { version: 2 })).toBe(false);
  });

  it("读不出来的一律不是 —— 跟 `documentSchemaDiffers` 不是互补关系", () => {
    // 两个函数问的是不同的问题，「不知道」对两个问题都答否：
    // 不知道服务器发布了什么，既不能说它跟我不一样（那会拦住用户），
    // 也不能说它就是我这一版（那会让服务器永远不发布）。
    expect(documentSchemaMatches(1, undefined)).toBe(false);
    expect(documentSchemaDiffers(1, undefined)).toBe(false);
    expect(documentSchemaMatches(1, {})).toBe(false);
  });
});
