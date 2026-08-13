// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * document space 的 schema 清单，以及「我这份跟服务器那份一样不一样」的判定。
 *
 * 设计文档 §4.1 / §4.4：这份清单 web 和 collab 各自 import 同一个符号，
 * collab 把它写进 project meta，前端读回来跟自己手上这份比。
 */

import { describe, it, expect } from "vitest";

import {
  DOCUMENT_SCHEMA,
  DOCUMENT_SCHEMA_META_KEY,
  documentSchemaDiffers,
  documentSchemaMatches,
} from "@shared/document-schema.js";

describe("这份清单本身", () => {
  it("键名就是 meta 文档里那个顶层键", () => {
    expect(DOCUMENT_SCHEMA_META_KEY).toBe("documentSchema");
  });

  it("装的是节点和标记各自的名字，以及每个的属性名", () => {
    expect(Object.keys(DOCUMENT_SCHEMA.nodes).length).toBeGreaterThan(0);
    expect(Object.keys(DOCUMENT_SCHEMA.marks).length).toBeGreaterThan(0);
    // 每个值都是属性名的数组，且已排序 —— 比较靠的就是它，顺序不稳就会误判。
    Object.values(DOCUMENT_SCHEMA.nodes).forEach((attrs) => {
      expect(Array.isArray(attrs)).toBe(true);
      expect([...attrs].sort()).toEqual([...attrs]);
    });
    Object.values(DOCUMENT_SCHEMA.marks).forEach((attrs) => {
      expect([...attrs].sort()).toEqual([...attrs]);
    });
  });

  it("三个兜底类型在清单里 —— 它们必须在所有版本里都存在", () => {
    expect(DOCUMENT_SCHEMA.nodes).toHaveProperty("unsupportedBlock");
    expect(DOCUMENT_SCHEMA.nodes).toHaveProperty("unsupportedInline");
    expect(DOCUMENT_SCHEMA.marks).toHaveProperty("unsupportedMark");
  });
});

describe("判定：我这份跟 meta 里那份一样不一样", () => {
  const mine = {
    nodes: { doc: [], paragraph: [], heading: ["level"] },
    marks: { bold: [] },
  };

  it("完全一样 → 不算不一致", () => {
    expect(documentSchemaDiffers(mine, { ...mine, publishedAt: "x" })).toBe(false);
  });

  it("服务器多一个节点类型 → 不一致", () => {
    expect(
      documentSchemaDiffers(mine, {
        nodes: { ...mine.nodes, taskList: [] },
        marks: mine.marks,
      }),
    ).toBe(true);
  });

  it("服务器少一个节点类型（回滚方向）→ 一样算不一致", () => {
    expect(
      documentSchemaDiffers(mine, {
        nodes: { doc: [], paragraph: [] },
        marks: mine.marks,
      }),
    ).toBe(true);
  });

  it("节点名一样但某个节点多了一个属性 → 不一致", () => {
    // 这一类（#86 标题对齐）不会触发兜底，判定是它唯一的拦截手段。
    expect(
      documentSchemaDiffers(mine, {
        nodes: { ...mine.nodes, heading: ["align", "level"] },
        marks: mine.marks,
      }),
    ).toBe(true);
  });

  it("标记多了一个属性 → 不一致", () => {
    expect(
      documentSchemaDiffers(mine, {
        nodes: mine.nodes,
        marks: { bold: ["weight"] },
      }),
    ).toBe(true);
  });

  it("属性名顺序不同但集合相同 → 不算不一致", () => {
    expect(
      documentSchemaDiffers(
        { nodes: { heading: ["align", "level"] }, marks: {} },
        { nodes: { heading: ["level", "align"] }, marks: {} },
      ),
    ).toBe(false);
  });

  it("meta 里根本没有这份数据 → 不算不一致", () => {
    // 没有信息不等于不一致：老 project 的 meta 还没被写过，
    // 这时候拦住用户是拿我们自己的空白去惩罚他。
    expect(documentSchemaDiffers(mine, undefined)).toBe(false);
    expect(documentSchemaDiffers(mine, null)).toBe(false);
  });

  it("meta 里那份形状不对 → 不算不一致", () => {
    // 形状不对说明是我们自己写坏了，不该让用户为它买单；
    // 而且这时候也说不出服务器到底是什么 schema。
    expect(documentSchemaDiffers(mine, "nonsense")).toBe(false);
    expect(documentSchemaDiffers(mine, 42)).toBe(false);
    expect(documentSchemaDiffers(mine, {})).toBe(false);
    expect(documentSchemaDiffers(mine, { nodes: "x", marks: {} })).toBe(false);
    expect(documentSchemaDiffers(mine, { nodes: { doc: "x" }, marks: {} })).toBe(false);
  });
});

describe("判定：meta 里那份就是我这一份吗", () => {
  const mine = {
    nodes: { doc: [], paragraph: [], heading: ["level"] },
    marks: { bold: [] },
  };

  it("完全一样 → 是", () => {
    expect(documentSchemaMatches(mine, { ...mine, publishedAt: "x" })).toBe(true);
  });

  it("发布时间不同不影响 —— 它记的是「什么时候变的」，不参与比较", () => {
    expect(documentSchemaMatches(mine, { ...mine, publishedAt: "2020-01-01" })).toBe(
      true,
    );
  });

  it("键的顺序不同、属性名顺序不同，仍然是同一份", () => {
    expect(
      documentSchemaMatches(
        { nodes: { doc: [], heading: ["level"] }, marks: { bold: ["b", "a"] } },
        { nodes: { heading: ["level"], doc: [] }, marks: { bold: ["a", "b"] } },
      ),
    ).toBe(true);
  });

  it("少一个节点类型 → 不是", () => {
    expect(
      documentSchemaMatches(mine, { nodes: { doc: [], paragraph: [] }, marks: { bold: [] } }),
    ).toBe(false);
  });

  it("读不出来的一律不是 —— 跟 `documentSchemaDiffers` 不是互补关系", () => {
    // 两个函数问的是不同的问题，「不知道」对两个问题都答否：
    // 不知道服务器发布了什么，既不能说它跟我不一样（那会拦住用户），
    // 也不能说它就是我这一份（那会让服务器永远不发布）。
    expect(documentSchemaMatches(mine, undefined)).toBe(false);
    expect(documentSchemaDiffers(mine, undefined)).toBe(false);
    expect(documentSchemaMatches(mine, {})).toBe(false);
    expect(documentSchemaMatches(mine, { nodes: "x", marks: {} })).toBe(false);
  });
});
