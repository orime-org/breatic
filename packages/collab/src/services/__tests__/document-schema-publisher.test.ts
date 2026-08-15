// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * 服务器把这一版的 document schema 写进 project meta（验收 10）。
 *
 * 客户端读它跟自己手上那份比，不一样就不再让他编辑 document space。
 * 写的是服务器：meta 文档对每个客户端都是只读的（`auth.ts` 的
 * `connectionConfig.readOnly`），客户端写进去的东西不报错、也不会落地。
 */

import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import {
  DOCUMENT_SCHEMA,
  DOCUMENT_SCHEMA_META_KEY,
  DOCUMENT_SCHEMA_VERSION,
  documentSchemaVersion,
} from "@breatic/shared";

import { publishDocumentSchema } from "@collab/services/document-schema-publisher.js";

/** 这一版算出来的版本号 —— 跟 publisher 写进 meta 的那个是同一个。 */
const MY_VERSION = DOCUMENT_SCHEMA_VERSION;

/** 随便另一个版本号，只要不等于 MY_VERSION。 */
const OTHER_VERSION = documentSchemaVersion({
  publishedAt: "2020-01-01T00:00:00Z",
  nodes: { paragraph: [] },
  marks: {},
});

/**
 * 读 meta 文档里那份 schema。
 * @param doc - meta 文档。
 * @returns 那个键下的值。
 */
function readPublished(doc: Y.Doc): Record<string, unknown> {
  return doc.getMap(DOCUMENT_SCHEMA_META_KEY).toJSON();
}

describe("往 meta 里写这一版的 schema", () => {
  it("meta 里还没有的时候，写进去", () => {
    const doc = new Y.Doc();
    const wrote = publishDocumentSchema(doc);

    expect(wrote).toBe(true);
    const published = readPublished(doc);
    expect(published.version).toBe(MY_VERSION);
    expect(published.nodes).toEqual(DOCUMENT_SCHEMA.nodes);
    expect(published.marks).toEqual(DOCUMENT_SCHEMA.marks);
    doc.destroy();
  });

  it("写进去的 publishedAt 就是词表上那个值，不是「现在」", () => {
    // 它说的是「服务器现在跑的这一份是什么时候发的」。用 new Date() 记的是
    // 「这个进程第一次加载这个 project 的 meta」——一个没人打开过的 project
    // 跨过一次发版之后，那个值会晚上好几天，面板会写成「刚刚发布」。
    const doc = new Y.Doc();
    publishDocumentSchema(doc);

    expect(readPublished(doc).publishedAt).toBe(DOCUMENT_SCHEMA.publishedAt);
    doc.destroy();
  });

  it("写进去的是 UTC —— 一个时刻发给所有人", () => {
    // 各自的浏览器按自己的时区渲染它。
    const doc = new Y.Doc();
    publishDocumentSchema(doc);

    expect(readPublished(doc).publishedAt).toMatch(/Z$/);
    doc.destroy();
  });

  it("meta 里已经是同一份了，什么都不写", () => {
    const doc = new Y.Doc();
    publishDocumentSchema(doc);
    const firstAt = readPublished(doc).publishedAt;

    const wroteAgain = publishDocumentSchema(doc);

    expect(wroteAgain).toBe(false);
    expect(readPublished(doc).publishedAt).toBe(firstAt);
    doc.destroy();
  });

  it("版本号一样但发布时间不一样，也要重写 —— 改对一个日期得让人看到", () => {
    const doc = new Y.Doc();
    doc.transact(() => {
      const map = doc.getMap(DOCUMENT_SCHEMA_META_KEY);
      map.set("version", MY_VERSION);
      map.set("nodes", DOCUMENT_SCHEMA.nodes);
      map.set("marks", DOCUMENT_SCHEMA.marks);
      map.set("publishedAt", "2020-01-01T00:00:00Z");
    });

    expect(publishDocumentSchema(doc)).toBe(true);
    expect(readPublished(doc).publishedAt).toBe(DOCUMENT_SCHEMA.publishedAt);
    doc.destroy();
  });

  it("版本号和发布时间都一样就不重写，哪怕清单内容被人改过", () => {
    // 拦不拦只看版本号（user 2026-08-14）。清单跟着版本号走、不参与比较；
    // 而版本号是从清单算出来的，所以「清单变了版本号没变」造不出来。
    const doc = new Y.Doc();
    doc.transact(() => {
      const map = doc.getMap(DOCUMENT_SCHEMA_META_KEY);
      map.set("version", MY_VERSION);
      map.set("nodes", { paragraph: [] });
      map.set("marks", {});
      map.set("publishedAt", DOCUMENT_SCHEMA.publishedAt);
    });

    expect(publishDocumentSchema(doc)).toBe(false);
    expect(readPublished(doc).nodes).toEqual({ paragraph: [] });
    doc.destroy();
  });

  it("meta 里那版跟这一版不是同一个，覆盖掉", () => {
    const doc = new Y.Doc();
    doc.transact(() => {
      const stale = doc.getMap(DOCUMENT_SCHEMA_META_KEY);
      stale.set("version", OTHER_VERSION);
      stale.set("nodes", { paragraph: [] });
      stale.set("marks", {});
      stale.set("publishedAt", "2020-01-01T00:00:00.000Z");
    });

    const wrote = publishDocumentSchema(doc);

    expect(wrote).toBe(true);
    const published = readPublished(doc);
    expect(published.version).toBe(MY_VERSION);
    expect(published.nodes).toEqual(DOCUMENT_SCHEMA.nodes);
    expect(published.publishedAt).toBe(DOCUMENT_SCHEMA.publishedAt);
    doc.destroy();
  });

  it("meta 里那份是上一代那个手写的数字，也覆盖掉", () => {
    const doc = new Y.Doc();
    doc.transact(() => {
      doc.getMap(DOCUMENT_SCHEMA_META_KEY).set("version", 1);
    });

    expect(publishDocumentSchema(doc)).toBe(true);
    expect(readPublished(doc).version).toBe(MY_VERSION);
    doc.destroy();
  });

  it("写这一份不碰 meta 里别的键", () => {
    const doc = new Y.Doc();
    doc.transact(() => {
      doc.getMap("spaces").set("s1", { id: "s1", name: "脚本", type: "document" });
    });

    publishDocumentSchema(doc);

    expect(doc.getMap("spaces").toJSON()).toEqual({
      s1: { id: "s1", name: "脚本", type: "document" },
    });
    doc.destroy();
  });
});
