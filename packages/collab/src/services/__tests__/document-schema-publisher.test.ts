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
import { DOCUMENT_SCHEMA_META_KEY, documentSchemaVersion } from "@breatic/shared";
import { getDocumentSchema } from "@breatic/core";

import { publishDocumentSchema } from "@collab/services/document-schema-publisher.js";

/** 这一版算出来的版本号 —— 跟 publisher 写进 meta 的那个是同一个算法。 */
const MY_VERSION = documentSchemaVersion(getDocumentSchema());

/** 随便另一个版本号，只要不等于 MY_VERSION。 */
const OTHER_VERSION = documentSchemaVersion({
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
    expect(published.nodes).toEqual(getDocumentSchema().nodes);
    expect(published.marks).toEqual(getDocumentSchema().marks);
    doc.destroy();
  });

  it("写进去的那份带 publishedAt，是个能解析的时间", () => {
    const doc = new Y.Doc();
    publishDocumentSchema(doc);

    const at = readPublished(doc).publishedAt;
    expect(typeof at).toBe("string");
    expect(Number.isNaN(Date.parse(at as string))).toBe(false);
    doc.destroy();
  });

  it("meta 里已经是同一份了，什么都不写", () => {
    const doc = new Y.Doc();
    publishDocumentSchema(doc);
    const firstAt = readPublished(doc).publishedAt;

    const wroteAgain = publishDocumentSchema(doc);

    expect(wroteAgain).toBe(false);
    // 时间戳没被刷新 —— 每次加载都重写会让「新版本什么时候发布的」变成
    // 「这份文档最近一次被打开是什么时候」，那句话就没有意义了。
    expect(readPublished(doc).publishedAt).toBe(firstAt);
    doc.destroy();
  });

  it("版本号一样就不重写，哪怕清单内容被人改过", () => {
    // 判定只看版本号（user 2026-08-14）。清单跟着版本号走、不参与比较；
    // 而版本号是从清单算出来的，所以「清单变了版本号没变」造不出来。
    const doc = new Y.Doc();
    doc.transact(() => {
      const map = doc.getMap(DOCUMENT_SCHEMA_META_KEY);
      map.set("version", MY_VERSION);
      map.set("nodes", { paragraph: [] });
      map.set("marks", {});
      map.set("publishedAt", "2020-01-01T00:00:00.000Z");
    });

    expect(publishDocumentSchema(doc)).toBe(false);
    expect(readPublished(doc).publishedAt).toBe("2020-01-01T00:00:00.000Z");
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
    expect(published.nodes).toEqual(getDocumentSchema().nodes);
    expect(published.publishedAt).not.toBe("2020-01-01T00:00:00.000Z");
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
