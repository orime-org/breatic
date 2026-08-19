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

/** 插件视图上我们真正配进去的那几样，取出来直接问。 */
interface BubblePluginView {
  scrollTarget?: unknown;
  getReferencedVirtualElement?: () => { getBoundingClientRect: () => DOMRect } | null;
}

/**
 * 从编辑器身上取浮出条那个插件视图。
 *
 * 插件把 `getReferencedVirtualElement` 原样存在自己身上（`dist/index.js:173`），
 * 所以这是「它真正会调用的那个函数」，不是测试自己另外造的一份。
 * @param editor - 编辑器。
 * @returns 插件视图。
 */
function bubblePluginView(editor: Editor): BubblePluginView {
  const views =
    (editor.view as unknown as { pluginViews: unknown[] }).pluginViews ?? [];
  const found = views.find(
    (v) => v !== null && typeof v === 'object' && 'scrollTarget' in v,
  );
  expect(found).toBeDefined();
  return found as BubblePluginView;
}

/**
 * 把正文滚动容器的可见范围钉成一个已知的框。
 *
 * jsdom 里一切矩形都是零，锚点逻辑要判的「这一行看得见吗」在零框里问不出答案。
 * @param box - 要钉的可见框。
 */
function pinViewport(box: DOMRect): void {
  const viewport = document.querySelector(
    '.doc-body-scroller [data-radix-scroll-area-viewport]',
  );
  expect(viewport).not.toBeNull();
  (viewport as HTMLElement).getBoundingClientRect = () => box;
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

  // A3：逐行锚点。设计 §5.1 要求的两条规则各钉一条，都在插件真正会调用的那个
  // 函数上问（`bubblePluginView` 取的就是插件自己存的那份）。
  //
  // 造场景的办法是把「哪一行在哪儿」直接钉死：jsdom 没有布局，一切矩形是零，
  // 而这段逻辑判的正是「这一行看得见吗」。所以钉一个可见框（纵向 100 到 500），
  // 再让每个文档位置回答一个已知的行坐标。
  describe('锚点', () => {
    /**
     * 让每个文档位置回答一个已知的行坐标。
     * @param editor - 编辑器。
     * @param lines - 位置到行顶坐标的映射，未列出的位置回答 top。
     */
    function pinLines(editor: Editor, lines: Record<number, number>): void {
      editor.view.coordsAtPos = (pos: number) => {
        const top = lines[pos] ?? 0;
        return { top, bottom: top + 20, left: 40 + pos, right: 60 + pos };
      };
    }

    it('全选时锚的是视口里看得见的那一行，不是整篇的包围盒顶端', async () => {
      const editor = open('<p>one</p><p>two</p><p>three</p>');
      mount(editor);
      await selectWithFocus(editor, 1, 4);
      pinViewport(new DOMRect(0, 100, 800, 400));

      act(() => {
        editor.commands.selectAll();
      });
      const { from, to } = editor.state.selection;
      // 选区起点在视口上方、终点在下方——两端都够不着，只剩「视口顶那一行」，
      // 它由 posAtCoords 报出来（pos 7，行顶 250，稳稳在可见框里）。
      pinLines(editor, { [from]: -300, [to]: 900, 7: 250 });
      editor.view.posAtCoords = () => ({ pos: 7, inside: -1 });

      const rect = bubblePluginView(editor)
        .getReferencedVirtualElement?.()
        ?.getBoundingClientRect();

      expect(rect).toBeDefined();
      expect(rect?.top).toBe(250);
      // 竖直取自那一行，水平取自选区自己的左边——全选的 from 是 0，左边 40。
      expect(rect?.left).toBe(40);
    });

    it('拖出来的选区锚在松手那一行——也就是选区的 head', async () => {
      const editor = open('<p>hello world</p>');
      mount(editor);
      await selectWithFocus(editor, 1, 6);
      pinViewport(new DOMRect(0, 100, 800, 400));

      // 从 1 往下拖到 6：head 是 6，两端都在视口里。两端各给一个不同的行坐标，
      // 才分辨得出锚的是松手那端还是选区起点。
      act(() => {
        editor.commands.setTextSelection({ from: 1, to: 6 });
      });
      pinLines(editor, { 1: 300, 6: 200 });

      const rect = bubblePluginView(editor)
        .getReferencedVirtualElement?.()
        ?.getBoundingClientRect();

      expect(rect?.top).toBe(200);
      // 锚的是 6 那一行，左边仍然是选区左边缘（from = 1 → 41），不是行尾。
      expect(rect?.left).toBe(41);
    });

    it('锚的那一行只露出下半截时，浮出条贴在可见区域上沿', async () => {
      const editor = open('<p>hello world</p>');
      mount(editor);
      await selectWithFocus(editor, 1, 6);
      pinViewport(new DOMRect(0, 100, 800, 400));

      act(() => {
        editor.commands.setTextSelection({ from: 1, to: 6 });
      });
      // 那一行跨在可见框上沿：顶 90 已经被滚上去，底 110 还露着。
      pinLines(editor, { 1: 90, 6: 90 });

      const rect = bubblePluginView(editor)
        .getReferencedVirtualElement?.()
        ?.getBoundingClientRect();

      // 锚到 90 就是锚到看不见的地方，收进来才对。
      expect(rect?.top).toBe(100);
      expect(rect?.bottom).toBe(110);
    });

    it('选区为空时不给锚点', async () => {
      const editor = open('<p>hello world</p>');
      mount(editor);
      await selectWithFocus(editor, 1, 6);
      pinViewport(new DOMRect(0, 100, 800, 400));

      act(() => {
        editor.commands.setTextSelection(3);
      });

      expect(
        bubblePluginView(editor).getReferencedVirtualElement?.(),
      ).toBeNull();
    });
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
