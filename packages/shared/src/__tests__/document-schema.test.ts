// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * document space 的词表本身、版本号怎么算出来，以及「我这份跟服务器那份一样
 * 不一样」的判定。
 *
 * **词表是 `@breatic/shared` 里的一个常量，两端 import 同一个符号**
 * （user 2026-08-14 拍板，从外部配置文件改回来）。
 *
 * **版本号不是人写的，是从两张清单算出来的**：手写的数字要靠人记得跟着清单
 * 一起改，而唯一会因为清单变化变红的那条一致性测试根本不看它 —— 改完清单
 * 转绿，人就走了，属性漂移那两类从此裸奔。
 *
 * **判定看的是版本号，问的是「一不一样」**，不是谁新谁旧（user 2026-08-14）。
 */

import { describe, it, expect } from "vitest";

import {
  DOCUMENT_SCHEMA,
  DOCUMENT_SCHEMA_META_KEY,
  DOCUMENT_SCHEMA_VERSION,
  type DocumentSchema,
  documentSchemaDiffers,
  documentSchemaMatches,
  documentSchemaVersion,
  publishedSchemaVersion,
} from "@shared/document-schema.js";

/**
 * 拼一份词表，用来算版本号。
 * @param nodes - 节点清单。
 * @param marks - 标记清单。
 * @param publishedAt - 发布时刻。
 * @returns 那份词表。
 */
function parse(
  nodes: Record<string, string[]>,
  marks: Record<string, string[]> = {},
  publishedAt = "2026-08-14T00:00:00Z",
): DocumentSchema {
  return { publishedAt, nodes, marks };
}

describe("这一份词表本身", () => {
  it("键名就是 meta 文档里那个顶层键", () => {
    expect(DOCUMENT_SCHEMA_META_KEY).toBe("documentSchema");
  });

  it("两张清单都在，三个兜底类型也在", () => {
    // 兜底类型必须每一版都有：一个 build 表示不了的内容会被包进它们而不是
    // 删掉，而下一个客户端碰到已经被包过的元素得认得出这个包装。
    expect(Object.keys(DOCUMENT_SCHEMA.nodes).length).toBeGreaterThan(0);
    expect(Object.keys(DOCUMENT_SCHEMA.marks).length).toBeGreaterThan(0);
    expect(DOCUMENT_SCHEMA.nodes.unsupportedBlock).toEqual(["originalName"]);
    expect(DOCUMENT_SCHEMA.nodes.unsupportedInline).toEqual(["originalName"]);
    expect(DOCUMENT_SCHEMA.marks.unsupportedMark).toEqual([
      "originalName",
      "originalValue",
    ]);
  });

  it("发布时间是带 Z 的 ISO 时刻 —— 一个时刻发给所有人，各自按本地时区渲染", () => {
    // 这是人写的、机器算不出来的东西（只有人知道这一版什么时候发的），
    // 所以没有校验器盯它，靠这一条钉住形状。
    expect(DOCUMENT_SCHEMA.publishedAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/,
    );
    expect(Number.isNaN(Date.parse(DOCUMENT_SCHEMA.publishedAt))).toBe(false);
  });

  it("导出的版本号就是这份词表算出来的那个", () => {
    expect(DOCUMENT_SCHEMA_VERSION).toBe(documentSchemaVersion(DOCUMENT_SCHEMA));
    expect(DOCUMENT_SCHEMA_VERSION).toMatch(/^[0-9a-f]{16}$/);
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
    // 没有任何东西在写进来的路上帮忙排序了，所以算的时候自己排两层。
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
