// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * 选中浮出条（任务 #112，菜单体系第 4 步）。
 *
 * 这一步只建载体、零新命令，所以这里问的核心问题只有一个：**把现有六个命令
 * 搬进新载体之后，在那儿按下去，文档真的变了吗**。设计对抗（2026-08-19）
 * 咬出初版验收清单十条里没有一条验证这件事——`canRun` 只决定按钮亮不亮，
 * `run` 是 `ToolDef` 上另一个字段，复用 `canRun` 一个字都没覆盖它；而且点击
 * 发生在编辑器 DOM 之外（浮出条走 `appendTo` 挂出滚动容器），要靠 bubble-menu
 * 自己的焦点豁免兜住，那恰恰是本次新引入的一层。
 *
 * 两个载体渲染同一批 `ToolDef`，所以 testid 必须带载体前缀，否则六个
 * `doc-tool-*` 各出现两份：既有的 `DocumentEditor.test.tsx` 用全文档
 * `querySelectorAll` 数按钮、用 `getByTestId` 取单个（多个匹配即抛错），
 * 会当场变红。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { Editor } from '@tiptap/react';
import * as Y from 'yjs';

import { documentBodyFragment, encodeInitialSpaceContent } from '@breatic/shared';
import { buildDocumentExtensions } from '@web/spaces/document/document-extensions';
import { SelectionBubbleBar } from '@web/spaces/document/SelectionBubbleBar';
import { MARK_TOOLS, BLOCK_TOOLS } from '@web/spaces/document/DocumentToolbar';

const editors: Editor[] = [];
let doc: Y.Doc;

beforeEach(() => {
  doc = new Y.Doc();
  Y.applyUpdate(doc, encodeInitialSpaceContent('document'));
});

afterEach(() => {
  editors.splice(0).forEach((e) => {
    e.destroy();
  });
  doc.destroy();
});

/**
 * 一个装着给定正文的真编辑器，绑在真 Y.Doc 上。
 * @param bodyHtml - 正文 HTML。
 * @returns 编辑器。
 */
function open(bodyHtml: string): Editor {
  const editor = new Editor({
    extensions: buildDocumentExtensions({ fragment: documentBodyFragment(doc) }),
  });
  editors.push(editor);
  if (bodyHtml) editor.commands.setContent(bodyHtml);
  return editor;
}

/** 正文带标记的样子，用来判命令有没有真的改到文档。 */
function markupOf(): string {
  return documentBodyFragment(doc)
    .toArray()
    .map((n) => n.toString())
    .join('');
}

describe('选中浮出条', () => {
  it('选中文字时出现，装的正好是那六个命令', () => {
    const editor = open('<p>hello world</p>');
    render(<SelectionBubbleBar editor={editor} />);
    act(() => {
      editor.commands.setTextSelection({ from: 1, to: 6 });
    });

    const ids = Array.from(
      document.querySelectorAll('[data-testid^="doc-bubble-tool-"]'),
    ).map((el) => el.getAttribute('data-testid')?.replace('doc-bubble-tool-', ''));

    expect(ids.sort()).toEqual(
      [...MARK_TOOLS, ...BLOCK_TOOLS].map((t) => t.id).sort(),
    );
  });

  // A11：这一步存在的唯一理由。六个逐一验，不抽验。
  it.each([
    ['bold', '<strong>', '<p>hello world</p>', 1, 6],
    ['italic', '<em>', '<p>hello world</p>', 1, 6],
    ['strike', '<s>', '<p>hello world</p>', 1, 6],
    ['bullet-list', '<ul>', '<p>hello world</p>', 1, 6],
    ['ordered-list', '<ol>', '<p>hello world</p>', 1, 6],
    ['quote', '<blockquote>', '<p>hello world</p>', 1, 6],
  ])('在浮出条里点 %s，文档真的变了', (id, marker, body, from, to) => {
    const editor = open(body);
    render(<SelectionBubbleBar editor={editor} />);
    act(() => {
      editor.commands.setTextSelection({ from, to });
    });
    expect(markupOf()).not.toContain(marker);

    act(() => {
      screen.getByTestId(`doc-bubble-tool-${id}`).click();
    });

    expect(markupOf()).toContain(marker);
  });

  // A13：两个载体的同名命令必须能分别指认。
  it('浮出条的 testid 带自己的载体前缀，不跟顶部横条撞', () => {
    const editor = open('<p>hello world</p>');
    render(<SelectionBubbleBar editor={editor} />);
    act(() => {
      editor.commands.setTextSelection({ from: 1, to: 6 });
    });

    expect(
      document.querySelectorAll('[data-testid="doc-bubble-tool-bold"]'),
    ).toHaveLength(1);
    // 旧的无前缀 testid 一个都不许再出现，否则两个载体一起渲染时会撞。
    expect(document.querySelectorAll('[data-testid="doc-tool-bold"]')).toHaveLength(
      0,
    );
  });

  // A7：viewer 整条不出现（定稿 §3.3.1）。
  it('只读时整条不出现', () => {
    const editor = open('<p>hello world</p>');
    render(<SelectionBubbleBar editor={editor} readOnly />);
    act(() => {
      editor.commands.setTextSelection({ from: 1, to: 6 });
    });

    expect(
      document.querySelectorAll('[data-testid^="doc-bubble-tool-"]'),
    ).toHaveLength(0);
  });
});
