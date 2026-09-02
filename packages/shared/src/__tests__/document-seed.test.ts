// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * #904 验收 S5 的 shared 一半：document 的种子是一个空段落，另两种仍是空文档。
 * 权威定稿：BlockNote 迁移设计（2026-09-02，私有工程文档）§5.4。
 *
 * 这里只验字节结构。「这份字节挂上真实编辑器之后一个字节都不变」那一半在
 * web 侧，因为 shared 不能依赖编辑器 —— 而 schema API 验不出真实的失败形态：
 * 后端写错时没有任何异常，第一个连上的客户端会把它不认识的东西删掉、再把
 * 这次删除当成自己的编辑广播出去。
 *
 * TDD：红灯阶段在旧世界（三种 kind 都种空文档）确认过 document 一项失败。
 */

import { describe, it, expect } from "vitest";
import * as Y from "yjs";

import {
  documentBodyFragment,
  encodeInitialSpaceContent,
} from "@shared/document-body.js";

describe("S5 内容种子", () => {
  it.each(["canvas", "timeline"] as const)(
    "%s 的种子应用后 content fragment 为空",
    (kind) => {
      const doc = new Y.Doc();
      Y.applyUpdate(doc, encodeInitialSpaceContent(kind));
      expect(documentBodyFragment(doc).length).toBe(0);
      doc.destroy();
    },
  );

  it("document 的种子是一个 blockContainer，里面一个空段落", () => {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, encodeInitialSpaceContent("document"));
    const fragment = documentBodyFragment(doc);

    // 顶层恰好一个 blockGroup —— doc 的内容规则是 `blockGroup`（单数），
    // 两个顶层 group 会让第一个连上的客户端删掉一个并广播那次删除。
    expect(fragment.length).toBe(1);
    const group = fragment.get(0) as Y.XmlElement;
    expect(group.nodeName).toBe("blockGroup");

    // 一个块，里面一个空段落。
    expect(group.length).toBe(1);
    const container = group.get(0) as Y.XmlElement;
    expect(container.nodeName).toBe("blockContainer");
    expect(container.getAttribute("id")).toEqual(expect.any(String));

    expect(container.length).toBe(1);
    const paragraph = container.get(0) as Y.XmlElement;
    expect(paragraph.nodeName).toBe("paragraph");
    expect(paragraph.length).toBe(0);

    doc.destroy();
  });

  it("节点名是驼峰的", () => {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, encodeInitialSpaceContent("document"));
    const group = documentBodyFragment(doc).get(0) as Y.XmlElement;
    const container = group.get(0) as Y.XmlElement;

    // `toString()` 会把节点名小写化（`yjs.cjs:8073`），所以这里读
    // `nodeName` 而不是 XML 文本 —— 真实的名字是 `blockGroup` /
    // `blockContainer`，写成小写的种子会被编辑器当成不认识的元素。
    expect([group.nodeName, container.nodeName]).toEqual([
      "blockGroup",
      "blockContainer",
    ]);
  });
});
