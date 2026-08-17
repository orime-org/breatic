// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * #123 验收 E1：三种 Space 的内容种子一律是空文档。
 * 权威定稿 inner engineering/decisions/2026-08-17-document-structure-dd.md §6.2。
 *
 * TDD 红灯批次一：现签名是 (kind, name) 且 document 分支种 title 块——
 * 本文件在旧世界必须红。签名收成 (kind) 后删掉下面的 ts-expect-error
 * （typecheck 会把失效的 expect-error 标出来，形成收口自检）。
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
      // @ts-expect-error -- the (kind) signature lands with task #123; the
      // extra-argument error disappearing is the cue to delete this line.
      Y.applyUpdate(doc, encodeInitialSpaceContent(kind));
      expect(documentBodyFragment(doc).length).toBe(0);
      doc.destroy();
    },
  );
});
