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
import { render, screen, act, waitFor } from '@testing-library/react';
import { Editor } from '@tiptap/react';
import * as Y from 'yjs';

import { documentBodyFragment, encodeInitialSpaceContent } from '@breatic/shared';
import { buildDocumentExtensions } from '@web/spaces/document/document-extensions';
import { DocumentEditor } from '@web/spaces/document/DocumentEditor';
import { MARK_TOOLS, BLOCK_TOOLS } from '@web/spaces/document/DocumentToolbar';

/** 空的撤销重做状态——本文件不测历史，给它一个静止值就够。 */
const NO_HISTORY = { canUndo: false, canRedo: false } as const;

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

/**
 * 选中一段文字，并让编辑器真的持有焦点。
 *
 * 焦点不是可有可无的布置：bubble-menu 默认的 `shouldShow` 第一个条件就是
 * `view.hasFocus()`（`dist/index.js:72-73`），不满足就不调 `show()`；而那个
 * 浮出条元素是在 `show()` 里才 `appendChild` 进 DOM 的（`:366-367`）。没有
 * 焦点，它一辈子不在 document 里，任何查询都落空。
 * @param editor - 编辑器。
 * @param from - 选区起点。
 * @param to - 选区终点。
 */
async function selectWithFocus(
  editor: Editor,
  from: number,
  to: number,
): Promise<void> {
  act(() => {
    editor.view.dom.focus();
    editor.commands.setTextSelection({ from, to });
  });
  // 插件对选区变化有 250ms 防抖（`updateDelay` 的默认值），而 `show()` 里才
  // 把浮出条 `appendChild` 进 DOM。同步断言会跑在它前面、什么都查不到。
  await waitFor(() => {
    expect(
      document.querySelectorAll('[data-testid^="doc-bubble-tool-"]').length,
    ).toBeGreaterThan(0);
  });
}

/**
 * 把编辑器连同它的两个载体渲染进 document。
 *
 * 走真实的 `DocumentEditor` 而不是自己搭一个壳：浮出条那个 div 是
 * `BubbleMenu` 自己 `createElement` 出来的，要靠插件的 `appendTo` 挂进 DOM，
 * 而 `appendTo` 默认落在 `view.dom.parentElement` —— 编辑器不真挂进
 * document，那个 div 就永远进不去，测什么都测不到。
 * @param editor - 已经装好正文的编辑器。
 * @param readOnly - 是否只读。
 */
function mount(editor: Editor, readOnly = false): void {
  render(
    <DocumentEditor editor={editor} history={NO_HISTORY} readOnly={readOnly} />,
  );
}

/** 正文带标记的样子，用来判命令有没有真的改到文档。 */
function markupOf(): string {
  return documentBodyFragment(doc)
    .toArray()
    .map((n) => n.toString())
    .join('');
}

describe('选中浮出条', () => {
  it('选中文字时出现，装的正好是那六个命令', async () => {
    const editor = open('<p>hello world</p>');
    mount(editor);
    await selectWithFocus(editor, 1, 6);

    const ids = Array.from(
      document.querySelectorAll('[data-testid^="doc-bubble-tool-"]'),
    ).map((el) => el.getAttribute('data-testid')?.replace('doc-bubble-tool-', ''));

    expect(ids.sort()).toEqual(
      [...MARK_TOOLS, ...BLOCK_TOOLS].map((t) => t.id).sort(),
    );
  });

  // A11：这一步存在的唯一理由。六个逐一验，不抽验。
  // 标记是 Yjs 片段里的 schema 节点名，不是 HTML 标签名——`toString()` 打出来
  // 的是 `<bold>` / `<bulletlist>` 这一套。
  it.each([
    ['bold', '<bold>', '<p>hello world</p>', 1, 6],
    ['italic', '<italic>', '<p>hello world</p>', 1, 6],
    ['strike', '<strike>', '<p>hello world</p>', 1, 6],
    ['bullet-list', '<bulletlist>', '<p>hello world</p>', 1, 6],
    ['ordered-list', '<orderedlist', '<p>hello world</p>', 1, 6],
    ['quote', '<blockquote>', '<p>hello world</p>', 1, 6],
  ])('在浮出条里点 %s，文档真的变了', async (id, marker, body, from, to) => {
    const editor = open(body);
    mount(editor);
    await selectWithFocus(editor, from, to);
    expect(markupOf()).not.toContain(marker);

    act(() => {
      screen.getByTestId(`doc-bubble-tool-${id}`).click();
    });

    expect(markupOf()).toContain(marker);
  });

  // A13：两个载体的同名命令必须能分别指认。
  it('浮出条的 testid 带自己的载体前缀，不跟顶部横条撞', async () => {
    const editor = open('<p>hello world</p>');
    mount(editor);
    await selectWithFocus(editor, 1, 6);

    expect(
      document.querySelectorAll('[data-testid="doc-bubble-tool-bold"]'),
    ).toHaveLength(1);
    // 旧的无前缀 testid 一个都不许再出现，否则两个载体一起渲染时会撞。
    expect(document.querySelectorAll('[data-testid="doc-tool-bold"]')).toHaveLength(
      0,
    );
  });

  // A12 的回归钉：滚动跟随要在**一次额外重渲染都没有**的情况下就成立。
  //
  // 插件只在构造时读一次 `options.scrollTarget`（`dist/index.js:172`），而
  // `DocumentEditor` 是 memo 的、它的 `history` 只在用户编辑过之后才换对象。
  // 所以「先把选项交出去、指望之后的 props 更新补上」在一篇刚打开、还没被
  // 编辑过的文档里永远补不上——实现对抗 2026-08-19 实测：挂载后和选区出现
  // 后 `scrollTarget` 都还是 `window`。初版 E2E 正好先敲了 40 行字，
  // `canUndo` 翻真触发了那次重渲染，于是绕过了这个缺口、绿着。
  it('不靠任何额外重渲染，插件拿到的就是正文的滚动容器', async () => {
    const editor = open('<p>hello world</p>');
    mount(editor);
    await selectWithFocus(editor, 1, 6);

    const views =
      (editor.view as unknown as { pluginViews: unknown[] }).pluginViews ?? [];
    const bubbleView = views.find(
      (v) => v !== null && typeof v === 'object' && 'scrollTarget' in v,
    ) as { scrollTarget?: unknown } | undefined;
    const viewport = document.querySelector(
      '.doc-body-scroller [data-radix-scroll-area-viewport]',
    );

    expect(viewport).not.toBeNull();
    expect(bubbleView).toBeDefined();
    expect(bubbleView?.scrollTarget).toBe(viewport);
    expect(bubbleView?.scrollTarget).not.toBe(window);
  });

  // A7：viewer 整条不出现（定稿 §3.3.1）。
  it('只读时整条不出现', async () => {
    const editor = open('<p>hello world</p>');
    mount(editor, true);
    // 这里不能用 selectWithFocus——它等的正是「浮出条出现」，而这条要证明它
    // 不出现。改成设完选区后等足防抖，再断言仍然没有。
    act(() => {
      editor.view.dom.focus();
      editor.commands.setTextSelection({ from: 1, to: 6 });
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 400);
    });

    expect(
      document.querySelectorAll('[data-testid^="doc-bubble-tool-"]'),
    ).toHaveLength(0);
  });
});
