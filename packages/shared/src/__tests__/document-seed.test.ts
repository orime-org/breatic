// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * #123 验收 E1：三种 Space 的内容种子一律是空文档。
 * 权威定稿：文档结构决议（2026-08-17，私有工程文档）§6.2。
 *
 * TDD：红灯阶段在旧世界（(kind, name) 签名 + document 分支种 title 块）
 * 确认过 document 一项失败；签名收成 (kind) 后转绿。
 */

import { describe, it, expect } from "vitest";
import * as Y from "yjs";

import {
  documentBodyFragment,
  encodeInitialSpaceContent,
} from "@shared/document-body.js";

describe("E1 三种 Space 的内容种子一律空文档", () => {
  it.each(["document", "canvas", "timeline"] as const)(
    "%s 的种子应用后 content fragment 为空",
    (kind) => {
      const doc = new Y.Doc();
      Y.applyUpdate(doc, encodeInitialSpaceContent(kind));
      expect(documentBodyFragment(doc).length).toBe(0);
      doc.destroy();
    },
  );
});
