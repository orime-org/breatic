// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * document space 的 schema 契约：配置文件长什么样、版本号怎么算出来，以及
 * 「我这份跟服务器那份一样不一样」的判定。
 *
 * 数据本身不在这儿，在 `config/document-schema.yaml`：collab 第一次加载某个
 * project 的 meta 文档时读它，前端打包时把同一份打进 bundle。这里只有形状、
 * 版本号的算法和判定。
 *
 * **版本号不是人写的，是从两张清单算出来的**（user 2026-08-14 拍板 A 方案）：
 * 手写的数字要靠人记得跟着清单一起改，而唯一会因为清单变化变红的那条一致性
 * 测试根本不看它 —— 改完清单转绿，人就走了，属性漂移那两类从此裸奔。
 *
 * **判定看的是版本号，问的是「一不一样」**，不是谁新谁旧（user 2026-08-14）。
 */

import { describe, it, expect } from "vitest";

import {
  DOCUMENT_SCHEMA_META_KEY,
  documentSchemaConfigSchema,
  documentSchemaDiffers,
  documentSchemaMatches,
  documentSchemaVersion,
  publishedSchemaVersion,
} from "@shared/document-schema.js";

/**
 * 把两张清单过一遍配置形状，拿到算版本号要的那个类型。
 * @param nodes - 节点清单。
 * @param marks - 标记清单。
 * @returns 解析后的清单。
 */
function parse(
  nodes: Record<string, string[]>,
  marks: Record<string, string[]> = {},
  publishedAt = "2026-08-14T00:00:00Z",
): ReturnType<typeof documentSchemaConfigSchema.parse> {
  return documentSchemaConfigSchema.parse({ publishedAt, nodes, marks });
}

describe("配置文件的形状", () => {
  it("键名就是 meta 文档里那个顶层键", () => {
    expect(DOCUMENT_SCHEMA_META_KEY).toBe("documentSchema");
  });

  it("收两张清单加一个发布时间 —— 没有版本号这一项", () => {
    const parsed = parse({ doc: [], heading: ["level"] }, { bold: [] });
    expect(parsed.nodes.heading).toEqual(["level"]);
    expect(parsed.marks.bold).toEqual([]);
    expect(parsed.publishedAt).toBe("2026-08-14T00:00:00Z");
    expect("version" in parsed).toBe(false);
  });

  it("配置里写了 version 也不会被收进来 —— 那个字段已经没有了", () => {
    const parsed = documentSchemaConfigSchema.parse({
      version: 3,
      publishedAt: "2026-08-14T00:00:00Z",
      nodes: {},
      marks: {},
    });
    expect("version" in parsed).toBe(false);
  });

  it("发布时间必须在，而且必须是带 Z 的 ISO 时刻", () => {
    // 面板拿它说「新版本发布于 X」。这一版什么时候发的，只有人知道、
    // 机器算不出来，所以它是配置的一部分，跟两张清单一起写。
    const lists = { nodes: {}, marks: {} };
    expect(() => documentSchemaConfigSchema.parse({ ...lists })).toThrow();
    expect(() =>
      documentSchemaConfigSchema.parse({ publishedAt: "2026-08-14", ...lists }),
    ).toThrow();
    expect(() =>
      documentSchemaConfigSchema.parse({
        publishedAt: "2026-08-14T00:00:00+08:00",
        ...lists,
      }),
    ).toThrow();
  });

  it("属性名进来时就排好序 —— 两份内容相同的清单不该因为写的顺序不同而看起来不同", () => {
    const parsed = parse({ heading: ["level", "align"] }, { link: ["target", "href"] });
    expect(parsed.nodes.heading).toEqual(["align", "level"]);
    expect(parsed.marks.link).toEqual(["href", "target"]);
  });

  it("两张清单都必须在", () => {
    const at = "2026-08-14T00:00:00Z";
    expect(() => documentSchemaConfigSchema.parse({ publishedAt: at, nodes: {} })).toThrow();
    expect(() => documentSchemaConfigSchema.parse({ publishedAt: at, marks: {} })).toThrow();
    expect(() =>
      documentSchemaConfigSchema.parse({ publishedAt: at, nodes: [], marks: {} }),
    ).toThrow();
  });
});

describe("版本号从清单算出来", () => {
  it("同一份清单永远算出同一个值", () => {
    const a = documentSchemaVersion(parse({ doc: [], heading: ["level"] }, { bold: [] }));
    const b = documentSchemaVersion(parse({ doc: [], heading: ["level"] }, { bold: [] }));
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });

  it("写的顺序不算数 —— 节点顺序、属性顺序换了，版本号不变", () => {
    const written = documentSchemaVersion(
      parse({ heading: ["level", "align"], doc: [] }, { link: ["target", "href"] }),
    );
    const rewritten = documentSchemaVersion(
      parse({ doc: [], heading: ["align", "level"] }, { link: ["href", "target"] }),
    );
    expect(written).toBe(rewritten);
  });

  it("给一个两边都认识的节点加一个属性 → 版本号变了", () => {
    // 这一条就是整件事的理由：属性加进去在内容里不留痕迹
    // （ProseMirror 静默丢弃不认识的属性），条件二看不见它，
    // 只有版本号变了旧客户端才会被拦住。
    const before = documentSchemaVersion(parse({ heading: ["level"] }));
    const after = documentSchemaVersion(parse({ heading: ["align", "level"] }));
    expect(after).not.toBe(before);
  });

  it("加一个节点、加一个标记、改一个名字 → 版本号都变了", () => {
    const base = documentSchemaVersion(parse({ doc: [] }, { bold: [] }));
    expect(documentSchemaVersion(parse({ doc: [], taskList: [] }, { bold: [] }))).not.toBe(base);
    expect(documentSchemaVersion(parse({ doc: [] }, { bold: [], italic: [] }))).not.toBe(base);
    expect(documentSchemaVersion(parse({ document: [] }, { bold: [] }))).not.toBe(base);
  });

  it("同一个属性挪到另一个节点上 → 版本号变了", () => {
    // 把清单拍平成一串字符再算，很容易算出两边相同的值；
    // 这一条钉住「属性属于哪个节点」也进了那串字符。
    const here = documentSchemaVersion(parse({ heading: ["align"], paragraph: [] }));
    const there = documentSchemaVersion(parse({ heading: [], paragraph: ["align"] }));
    expect(here).not.toBe(there);
  });

  it("节点清单和标记清单不会串味 —— 同名的东西在两边算出的不是同一份", () => {
    const asNode = documentSchemaVersion(parse({ code: [] }, {}));
    const asMark = documentSchemaVersion(parse({}, { code: [] }));
    expect(asNode).not.toBe(asMark);
  });

  it("发布时间不进版本号 —— 只改发布时间不该把所有人拦住", () => {
    // 版本号是判据。它跟着清单走，不跟着这个时间走：改一次时间就让
    // 全部客户端进拦截状态，而他们的词表跟服务器一模一样。
    const lists = { doc: [], heading: ["level"] };
    const early = documentSchemaVersion(parse(lists, {}, "2026-01-01T00:00:00Z"));
    const late = documentSchemaVersion(parse(lists, {}, "2026-08-14T00:00:00Z"));
    expect(late).toBe(early);
  });

  it("名字里带分隔符也分得开", () => {
    const a = documentSchemaVersion(parse({ "a:b": [], c: [] }));
    const b = documentSchemaVersion(parse({ a: [], "b:c": [] }));
    expect(a).not.toBe(b);
  });
});

describe("从 meta 里读版本号", () => {
  it("读得出来", () => {
    expect(publishedSchemaVersion({ version: "abc123", nodes: {}, marks: {} })).toBe("abc123");
  });

  it("老 meta 里那个手写的数字读不出来 —— 那是上一代的写法", () => {
    // 读不出来会被当成「不知道服务器发布了什么」，于是不拦截；
    // 而 collab 下一次加载这个 meta 就会把它改写成算出来的那个。
    expect(publishedSchemaVersion({ version: 1 })).toBeNull();
  });

  it("读不出来的一律 null：没有这个键、不是字符串、是空串、根本不是对象", () => {
    expect(publishedSchemaVersion(undefined)).toBeNull();
    expect(publishedSchemaVersion(null)).toBeNull();
    expect(publishedSchemaVersion({})).toBeNull();
    expect(publishedSchemaVersion({ version: "" })).toBeNull();
    expect(publishedSchemaVersion({ version: 2.5 })).toBeNull();
    expect(publishedSchemaVersion("nonsense")).toBeNull();
    expect(publishedSchemaVersion(42)).toBeNull();
  });
});

describe("判定：我这份跟 meta 里那份一样不一样", () => {
  it("一样 → 不算不一致", () => {
    expect(documentSchemaDiffers("aa", { version: "aa" })).toBe(false);
  });

  it("不一样 → 不一致，两个方向都是", () => {
    expect(documentSchemaDiffers("aa", { version: "bb" })).toBe(true);
    expect(documentSchemaDiffers("bb", { version: "aa" })).toBe(true);
  });

  it("清单内容不参与比较 —— 版本号一样就是一样", () => {
    expect(
      documentSchemaDiffers("aa", {
        version: "aa",
        nodes: { taskList: [] },
        marks: {},
        publishedAt: "2026-08-14T00:00:00.000Z",
      }),
    ).toBe(false);
  });

  it("meta 里根本没有这份数据 → 不算不一致", () => {
    // 没有信息不等于不一致：老 project 的 meta 还没被写过，
    // 这时候拦住用户是拿我们自己的空白去惩罚他。
    expect(documentSchemaDiffers("aa", undefined)).toBe(false);
    expect(documentSchemaDiffers("aa", null)).toBe(false);
  });

  it("meta 里那份形状不对 → 不算不一致", () => {
    // 形状不对说明是我们自己写坏了，不该让用户为它买单；
    // 而且这时候也说不出服务器到底是哪一版。
    expect(documentSchemaDiffers("aa", "nonsense")).toBe(false);
    expect(documentSchemaDiffers("aa", {})).toBe(false);
    expect(documentSchemaDiffers("aa", { version: 1 })).toBe(false);
  });
});

describe("判定：meta 里那份就是我这一版吗", () => {
  it("一样 → 是", () => {
    expect(documentSchemaMatches("aa", { version: "aa", publishedAt: "x" })).toBe(true);
  });

  it("不一样 → 不是，哪个方向都一样", () => {
    expect(documentSchemaMatches("aa", { version: "bb" })).toBe(false);
    expect(documentSchemaMatches("bb", { version: "aa" })).toBe(false);
  });

  it("读不出来的一律不是 —— 跟 `documentSchemaDiffers` 不是互补关系", () => {
    // 两个函数问的是不同的问题，「不知道」对两个问题都答否：
    // 不知道服务器发布了什么，既不能说它跟我不一样（那会拦住用户），
    // 也不能说它就是我这一版（那会让服务器永远不发布）。
    expect(documentSchemaMatches("aa", undefined)).toBe(false);
    expect(documentSchemaDiffers("aa", undefined)).toBe(false);
    expect(documentSchemaMatches("aa", {})).toBe(false);
    // 老 meta 里那个数字：既不算一致（服务器得改写它），也不算不一致
    // （不该拿上一代的写法把用户拦住）。
    expect(documentSchemaMatches("aa", { version: 1 })).toBe(false);
    expect(documentSchemaDiffers("aa", { version: 1 })).toBe(false);
  });
});
