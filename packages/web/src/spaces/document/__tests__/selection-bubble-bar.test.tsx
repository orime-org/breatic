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

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import { Editor } from '@tiptap/react';
import type { EditorView } from '@tiptap/pm/view';
import type { EditorState } from '@tiptap/pm/state';
import * as Y from 'yjs';

import { documentBodyFragment, encodeInitialSpaceContent } from '@breatic/shared';
import { buildDocumentExtensions } from '@web/spaces/document/document-extensions';
import { DocumentEditor } from '@web/spaces/document/DocumentEditor';
import { MARK_TOOLS, BLOCK_TOOLS } from '@web/spaces/document/document-tools';

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
  // 还原 `pinSelectionBox` 打在 `Range.prototype` 上的桩。不还原就会漏给同一个
  // jsdom 里之后跑的每一个文件（`singleFork`，环境只建一次）。
  vi.restoreAllMocks();
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
  element?: HTMLElement;
  scrollTarget?: unknown;
  resizeDelay?: number;
  isVisible?: boolean;
  getReferencedVirtualElement?: () => { getBoundingClientRect: () => DOMRect } | null;
  shouldShow?: (props: {
    editor: Editor;
    element: HTMLElement;
    view: EditorView;
    state: EditorState;
    from: number;
    to: number;
  }) => boolean;
  floatingUIOptions?: {
    offset?: unknown;
    flip?: { boundary?: unknown } | boolean;
    shift?: { boundary?: unknown } | boolean;
    hide?: { boundary?: unknown } | boolean;
    placement?: string;
  };
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

/** 锚点测试里选区包围盒的固定值，`left` 是水平轴唯一该取的那个数。 */
const SELECTION_BOX = new DOMRect(137, 0, 400, 20);

/**
 * 把选区包围盒钉成一个已知的矩形。
 *
 * 水平方向取的是它，跟竖直方向取自文档位置是两回事——jsdom 里两样都得钉。
 *
 * 早先这里直接写 `Range.prototype.getBoundingClientRect = ...` 且不还原，注释
 * 说「下一个文件重新跑 setup」——**那是假的**：`vitest.setup.ts` 那一行是
 * `??=`，对已经存在的函数是空操作，还原不了任何东西；而 `vitest.config.ts` 是
 * `forks` 加 `singleFork`，jsdom 环境在文件循环外只建一次，`Range.prototype`
 * 整个包共用一个对象。实测：本文件之后跑的文件里 `createRange()` 量出来的是
 * 这里钉的 137 乘 400，而不是零矩形，而 `reference-mention-caret.ts` 正是拿它
 * 去定拖拽虚影的宽度。所以改成 `vi.spyOn`，`afterEach` 里统一还原。
 * @param box - 要钉的包围盒。
 */
function pinSelectionBox(box: DOMRect): void {
  vi.spyOn(Range.prototype, 'getBoundingClientRect').mockReturnValue(box);
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
    beforeEach(() => {
      pinSelectionBox(SELECTION_BOX);
    });

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
      // 那一行是 250 到 270，锚点矩形上下各撑一个间距（8），所以是 242 到 278。
      expect(rect?.top).toBe(242);
      expect(rect?.bottom).toBe(278);
      // 水平取自选区包围盒，跟锚定在哪一行无关。
      expect(rect?.left).toBe(SELECTION_BOX.left);
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

      // 锚的是 6 那一行（200 到 220），上下各撑 8。
      expect(rect?.top).toBe(192);
      expect(rect?.bottom).toBe(228);
      // 左边取自选区包围盒，不是行尾、也不是锚定那一行的 x。
      expect(rect?.left).toBe(SELECTION_BOX.left);
    });

    it('间距做在锚点矩形上，不交给 offset 中间件', async () => {
      const editor = open('<p>hello world</p>');
      mount(editor);
      await selectWithFocus(editor, 1, 6);

      // 插件只有在 `options.offset` 为真时才往中间件里推 offset
      // （`dist/index.js:211-217`）。间距既然做进了锚点，这里必须是假值，
      // 否则 8px 会被加两次。
      expect(bubblePluginView(editor).floatingUIOptions?.offset).toBeFalsy();
    });

    it('左边缘对齐选区左边缘——靠的是 placement 带 -start', async () => {
      const editor = open('<p>hello world</p>');
      mount(editor);
      await selectWithFocus(editor, 1, 6);

      // A6 的水平对齐全部落在这一个值上：`@floating-ui/core` 只在 placement
      // 带 `-start` / `-end` 时才在对齐轴上偏移，裸 `top` 是居中。改成裸
      // `top` 时条心会压在选区左边缘上、半个条宽悬在选区外。
      expect(bubblePluginView(editor).floatingUIOptions?.placement).toBe('top-start');
    });

    it('翻转的判据是正文可见区，不是默认的裁切祖先', async () => {
      const editor = open('<p>hello world</p>');
      mount(editor);
      await selectWithFocus(editor, 1, 6);

      const viewport = document.querySelector(
        '.doc-body-scroller [data-radix-scroll-area-viewport]',
      );
      const flip = bubblePluginView(editor).floatingUIOptions?.flip;

      expect(viewport).not.toBeNull();
      expect(typeof flip).toBe('object');
      expect((flip as { boundary?: unknown }).boundary).toBe(viewport);
    });

    it('锚定那一行在可见区上方时不再被夹住——翻不翻由 flip 定', async () => {
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

      // 原来这里会把顶夹到 100。夹住等于骗 flip：它看到的空间比实际多，
      // 于是永远不翻，而条被裁掉一截。现在如实交出去。
      expect(rect?.top).toBe(82);
      expect(rect?.bottom).toBe(118);
    });

    // 第三条分支：选区两端都在可见范围外时，问 `posAtCoords` 视口顶那一行是谁。
    // 第三轮实证这一支零保护——查询坐标、范围校验、最后兜底三样全改坏，21 条
    // 测试仍全绿。下面三条各钉一样。
    it('两端都看不见时，锚点问的是视口顶那一行', async () => {
      const editor = open('<p>one</p><p>two</p><p>three</p>');
      mount(editor);
      await selectWithFocus(editor, 1, 4);
      pinViewport(new DOMRect(0, 100, 800, 400));

      act(() => {
        editor.commands.selectAll();
      });
      const { from, to } = editor.state.selection;
      pinLines(editor, { [from]: -300, [to]: 900, 7: 250 });
      const asked: { left: number; top: number }[] = [];
      editor.view.posAtCoords = (coords) => {
        asked.push({ left: Math.round(coords.left), top: Math.round(coords.top) });
        return { pos: 7, inside: -1 };
      };
      editor.view.dom.getBoundingClientRect = () => new DOMRect(300, 0, 500, 900);

      const rect = bubblePluginView(editor)
        .getReferencedVirtualElement?.()
        ?.getBoundingClientRect();

      // 问的坐标必须是「编辑器自己的左边缘再往里一点」加「可见范围的顶再往下
      // 一点」——问滚动容器的左边缘会落在没有文字的边距里。
      expect(asked).toEqual([{ left: 301, top: 101 }]);
      expect(rect?.top).toBe(242);
    });

    it('视口顶那一行不在选区里时，退回选区起点', async () => {
      const editor = open('<p>one</p><p>two</p><p>three</p>');
      mount(editor);
      await selectWithFocus(editor, 1, 4);
      pinViewport(new DOMRect(0, 100, 800, 400));

      act(() => {
        editor.commands.setTextSelection({ from: 6, to: 9 });
      });
      pinLines(editor, { 6: -300, 9: 900, 2: 250 });
      // 视口顶那一行是 pos 2，落在选区 [6, 9] 外面——不能拿它当锚点。
      editor.view.posAtCoords = () => ({ pos: 2, inside: -1 });

      const rect = bubblePluginView(editor)
        .getReferencedVirtualElement?.()
        ?.getBoundingClientRect();

      // 退回 from（pos 6，行顶 -300），而不是采信那个界外的答案。
      expect(rect?.top).toBe(-308);
    });

    it('问不出视口顶那一行时，退回选区起点', async () => {
      const editor = open('<p>one</p><p>two</p><p>three</p>');
      mount(editor);
      await selectWithFocus(editor, 1, 4);
      pinViewport(new DOMRect(0, 100, 800, 400));

      act(() => {
        editor.commands.setTextSelection({ from: 6, to: 9 });
      });
      pinLines(editor, { 6: -300, 9: 900 });
      // jsdom 没有命中测试，真实的 `posAtCoords` 在这里本来就答 null。
      editor.view.posAtCoords = () => null;

      const rect = bubblePluginView(editor)
        .getReferencedVirtualElement?.()
        ?.getBoundingClientRect();

      expect(rect?.top).toBe(-308);
    });

    it('整篇选中时锚的是最后那一行的行盒，不是文档末尾那条零高度的边界', async () => {
      const editor = open('<p>one</p><p>two</p><p>three</p>');
      mount(editor);
      await selectWithFocus(editor, 1, 4);
      pinViewport(new DOMRect(0, 100, 800, 400));

      act(() => {
        editor.commands.selectAll();
      });
      const { head } = editor.state.selection;
      // `AllSelection` 的 head 落在文档末尾这个块级边界上，而 `coordsAtPos` 在
      // 块级边界回答的是一条零高度的分隔线（上下都等于最后一段的底边），不是
      // 行盒。真浏览器实测：三段各占 25px 时条底落在 241，扎进最后一行 17px。
      editor.view.coordsAtPos = (pos: number) => {
        if (pos === head) return { top: 270, bottom: 270, left: 300, right: 300 };
        if (pos === head - 1) return { top: 250, bottom: 270, left: 40, right: 60 };
        return { top: 0, bottom: 20, left: 40, right: 60 };
      };

      const rect = bubblePluginView(editor)
        .getReferencedVirtualElement?.()
        ?.getBoundingClientRect();

      // 最后一行是 250 到 270，上下各撑 8。拿零高度那条边界去算会得到 262，
      // 那样条底就压在这一行的字上。
      expect(rect?.top).toBe(242);
      expect(rect?.bottom).toBe(278);
    });

    it('视口顶落在两段之间时，锚的是下面那一行，不是上面那一行', async () => {
      const editor = open('<p>one</p><p>two</p><p>three</p>');
      mount(editor);
      await selectWithFocus(editor, 1, 4);
      pinViewport(new DOMRect(0, 100, 800, 400));

      act(() => {
        editor.commands.selectAll();
      });
      // 正文段落之间有一条外边距。查询点落进那条空隙时 `posAtCoords` 答的是
      // 两段之间的块级边界（`prosemirror-view` 的 `posFromCaret` 就是为这个
      // 写的），而边界不属于任何一行。真浏览器实测：一屏正文里约每三个滚动
      // 位置就有一个这样落。
      editor.view.posAtCoords = () => ({ pos: 5, inside: -1 });
      editor.view.coordsAtPos = (pos: number) => {
        // 边界本身：零高度的分隔线，值是上一段的底边。
        if (pos === 5) return { top: 100, bottom: 100, left: 40, right: 40 };
        // 边界上面那一行，已经滚出可见区。
        if (pos === 4) return { top: 80, bottom: 100, left: 40, right: 60 };
        // 边界下面那一行，是读者看得见的第一行。
        if (pos === 6) return { top: 110, bottom: 130, left: 40, right: 60 };
        // 选区两端：一个在可见区上方，一个在下方，都够不着。
        if (pos <= 1) return { top: -300, bottom: -280, left: 40, right: 60 };
        return { top: 900, bottom: 920, left: 40, right: 60 };
      };

      const rect = bubblePluginView(editor)
        .getReferencedVirtualElement?.()
        ?.getBoundingClientRect();

      // 看得见的那一行是 110 到 130，上下各撑 8。取上面那一行会得到 72，
      // 而那一行在可见区外面——条会跟着画到正文可见区之上。
      expect(rect?.top).toBe(102);
      expect(rect?.bottom).toBe(138);
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

  /**
   * 全选那一档（A14）。
   *
   * 规则是 user 2026-08-20 定的两条：全选时鼠标在正文区域内就把条摆在鼠标那儿、
   * 不在就不显示；滚动的时候条已经显示就不动它，没显示才去判鼠标在哪。
   *
   * 「全选」的判据是 `AllSelection` —— 选了四分之三仍是区域选择，走上面那一组。
   */
  describe('全选那一档', () => {
    const VIEWPORT = new DOMRect(0, 100, 800, 400);

    beforeEach(() => {
      pinSelectionBox(SELECTION_BOX);
    });

    /**
     * 把最后一次已知的鼠标位置挪到某处。
     *
     * 事件发在 `document` 上而不是编辑器上：这个判据要回答的是「鼠标在不在正文
     * 区域内」，鼠标离开正文之后必须还能收到它的位置，否则记下的永远是最后一次
     * 在正文里的坐标、判据恒为真。
     * @param x - 视口横坐标。
     * @param y - 视口纵坐标。
     */
    function moveMouseTo(x: number, y: number): void {
      act(() => {
        document.dispatchEvent(
          new MouseEvent('mousemove', { clientX: x, clientY: y, bubbles: true }),
        );
      });
    }

    /**
     * 全选，并把插件的显示判据问一遍。
     * @param editor - 编辑器。
     * @returns 插件此刻会不会显示这条。
     */
    function shouldShowNow(editor: Editor): boolean {
      const view = bubblePluginView(editor);
      expect(view.shouldShow).toBeTypeOf('function');
      const { from, to } = editor.state.selection;
      return view.shouldShow!({
        editor,
        element: view.element!,
        view: editor.view,
        state: editor.state,
        from,
        to,
      });
    }

    it('鼠标在正文区域内时，锚的是鼠标那个点，不是任何一行', async () => {
      const editor = open('<p>one</p><p>two</p><p>three</p>');
      mount(editor);
      await selectWithFocus(editor, 1, 4);
      pinViewport(VIEWPORT);
      // 每一行都给一个一眼认得出的坐标：锚点若还是从行算的，断言会读到它们。
      editor.view.coordsAtPos = () => ({
        top: 300,
        bottom: 320,
        left: 40,
        right: 60,
      });

      moveMouseTo(420, 250);
      act(() => {
        editor.commands.selectAll();
      });

      const rect = bubblePluginView(editor)
        .getReferencedVirtualElement?.()
        ?.getBoundingClientRect();

      expect(rect).toBeDefined();
      // 鼠标点是零高度的，锚点矩形上下各撑一个间距（8）。
      expect(rect?.top).toBe(242);
      expect(rect?.bottom).toBe(258);
      // 水平也取自鼠标，不再是选区包围盒——全选没有「选区左边缘」这回事，
      // 整篇的包围盒左边缘是正文列的左边，跟用户在看哪儿无关。
      expect(rect?.left).toBe(420);
    });

    it('鼠标在正文区域外时，这条不显示', async () => {
      const editor = open('<p>one</p><p>two</p><p>three</p>');
      mount(editor);
      await selectWithFocus(editor, 1, 4);
      pinViewport(VIEWPORT);

      // 正文可见区是 y 从 100 到 500；50 在它上方，也就是顶部横条那一带。
      moveMouseTo(420, 50);
      act(() => {
        editor.commands.selectAll();
      });

      expect(shouldShowNow(editor)).toBe(false);
    });

    it('从来没有过鼠标位置时，这条不显示', async () => {
      const editor = open('<p>one</p><p>two</p><p>three</p>');
      mount(editor);
      await selectWithFocus(editor, 1, 4);
      pinViewport(VIEWPORT);

      act(() => {
        editor.commands.selectAll();
      });

      expect(shouldShowNow(editor)).toBe(false);
    });

    it('条摆出来之后鼠标离开正文区域，它不跟着消失', async () => {
      const editor = open('<p>one</p><p>two</p><p>three</p>');
      mount(editor);
      await selectWithFocus(editor, 1, 4);
      pinViewport(VIEWPORT);

      moveMouseTo(420, 250);
      act(() => {
        editor.commands.selectAll();
      });
      expect(shouldShowNow(editor)).toBe(true);

      // 摆出来之后它在屏幕上的坐标就定了，鼠标去哪都不再影响它。
      moveMouseTo(420, 50);

      expect(shouldShowNow(editor)).toBe(true);
      const rect = bubblePluginView(editor)
        .getReferencedVirtualElement?.()
        ?.getBoundingClientRect();
      expect(rect?.top).toBe(242);
      expect(rect?.left).toBe(420);
    });

    it('鼠标回到正文区域之后，下一次滚动把条摆出来', async () => {
      const editor = open('<p>one</p><p>two</p><p>three</p>');
      mount(editor);
      await selectWithFocus(editor, 1, 4);
      pinViewport(VIEWPORT);

      // 全选那一刻鼠标在正文外面，所以什么都不显示。
      moveMouseTo(420, 50);
      act(() => {
        editor.commands.selectAll();
      });
      expect(shouldShowNow(editor)).toBe(false);

      // 鼠标回到正文里，但用户没有再选也没有再点——只有滚动这一个信号。
      moveMouseTo(420, 250);
      act(() => {
        document
          .querySelector('.doc-body-scroller [data-radix-scroll-area-viewport]')
          ?.dispatchEvent(new Event('scroll'));
      });

      expect(shouldShowNow(editor)).toBe(true);
      expect(bubblePluginView(editor).isVisible).toBe(true);
      const rect = bubblePluginView(editor)
        .getReferencedVirtualElement?.()
        ?.getBoundingClientRect();
      expect(rect?.top).toBe(242);
      expect(rect?.left).toBe(420);
    });

    it('选了一部分时不看鼠标在哪——那一档跟着选区走', async () => {
      const editor = open('<p>hello world</p>');
      mount(editor);
      await selectWithFocus(editor, 1, 6);
      pinViewport(VIEWPORT);

      // 鼠标停在正文区域外，而选区只是一小段：这一档照常显示，锚在行上。
      moveMouseTo(420, 50);
      act(() => {
        editor.commands.setTextSelection({ from: 1, to: 6 });
      });
      editor.view.coordsAtPos = () => ({
        top: 200,
        bottom: 220,
        left: 40,
        right: 60,
      });

      expect(shouldShowNow(editor)).toBe(true);
      const rect = bubblePluginView(editor)
        .getReferencedVirtualElement?.()
        ?.getBoundingClientRect();
      expect(rect?.top).toBe(192);
      expect(rect?.left).toBe(SELECTION_BOX.left);
    });
  });

  it('锚点离开正文可见区就隐藏，靠的是 hide 中间件', async () => {
    const editor = open('<p>hello world</p>');
    mount(editor);
    await selectWithFocus(editor, 1, 6);

    const viewport = document.querySelector(
      '.doc-body-scroller [data-radix-scroll-area-viewport]',
    );
    const hide = bubblePluginView(editor).floatingUIOptions?.hide;

    // 插件默认 `hide: false`（`dist/index.js:55`），不传就没有这个中间件，
    // 锚点滚出正文之后条会一直画在那儿。而它的边界默认是裁切祖先，那一层的顶
    // 比正文可见区高 40px——不显式传边界等于没解决这 40px。
    expect(viewport).not.toBeNull();
    expect(typeof hide).toBe('object');
    expect((hide as { boundary?: unknown }).boundary).toBe(viewport);
  });

  it('左右夹取交给 shift，边界也是正文可见区', async () => {
    const editor = open('<p>hello world</p>');
    mount(editor);
    await selectWithFocus(editor, 1, 6);

    const viewport = document.querySelector(
      '.doc-body-scroller [data-radix-scroll-area-viewport]',
    );
    const shift = bubblePluginView(editor).floatingUIOptions?.shift;

    // shift 本来就开着（`dist/index.js:51` 默认 `{}`），我们要改的只是它量的
    // 那个盒子——默认的裁切祖先跟正文可见区不是同一个。
    expect(viewport).not.toBeNull();
    expect(typeof shift).toBe('object');
    expect((shift as { boundary?: unknown }).boundary).toBe(viewport);
  });

  // 没有选区时六个按钮根本不建。查的是插件自己那个元素而不是 document：条隐藏
  // 时它被 `element.remove()` 摘出文档（`dist/index.js:377-379`），从 document
  // 里查什么都查不到，那样的断言分辨不出「没建」和「建了但不在文档里」。
  //
  // 为什么要不建：每个按钮都在每一笔事务上跑一次自己命令的干跑（`canRun`），
  // 而浮出条绝大多数时间是隐藏的——留着它们等于给每次击键多付六次干跑，换来
  // 一个没人看得见的载体。
  it('没有选区时，浮出条里一个按钮都不建', async () => {
    const editor = open('<p>hello world</p>');
    mount(editor);
    await selectWithFocus(editor, 1, 6);
    const view = bubblePluginView(editor);
    expect(
      view.element?.querySelectorAll('[data-testid^="doc-bubble-tool-"]'),
    ).toHaveLength(6);

    act(() => {
      editor.commands.setTextSelection(3);
    });

    await waitFor(() => {
      expect(
        view.element?.querySelectorAll('[data-testid^="doc-bubble-tool-"]'),
      ).toHaveLength(0);
    });
  });

  // A12 的另一半：滚动时**每个事件**都重算，不是滚完才算。
  //
  // 插件默认 `resizeDelay = 60`（`dist/index.js:37`），而 `:95` 的 handler 每次
  // 都先 `clearTimeout` 再重排，所以滚动手势期间那个计时器永远到不了期——条
  // 在整个滚动过程中一动不动，手停下 60ms 才跳过去（真机实测：十步滚动里
  // barTop 全程 407，选中行从 379 走到 331）。
  //
  // 业界没有一家这么做：floating-ui 官方 `autoUpdate` 的 `ancestorScroll`
  // 默认每次滚动都更新、无防抖；Lexical 的浮出格式条在 scroll 回调里直接重算。
  it('滚动重算没有防抖', async () => {
    const editor = open('<p>hello world</p>');
    mount(editor);
    await selectWithFocus(editor, 1, 6);

    expect(bubblePluginView(editor).resizeDelay).toBe(0);
  });

  // A5 在 jsdom 层能测的那一半：浮出条挂在滚动容器**外面**。
  //
  // 第三轮实证：把 `appendTo` 整个删掉（条就落回库默认的 `view.dom.parentElement`，
  // 也就是滚动容器内部，正是 A5 禁止的），21 条单测一条不红。位置和裁切确实要真
  // 浏览器才量得了，但「它挂在谁下面」是 DOM 结构问题，jsdom 完全答得了。
  it('浮出条挂在滚动容器外面，不在它内部', async () => {
    const editor = open('<p>hello world</p>');
    mount(editor);
    await selectWithFocus(editor, 1, 6);

    const bar = document.querySelector('[data-testid="doc-selection-bubble-bar"]');
    const scroller = document.querySelector('.doc-body-scroller');

    expect(bar).not.toBeNull();
    expect(scroller).not.toBeNull();
    expect(bar?.closest('.doc-body-scroller')).toBeNull();
    // 挂的正是滚动容器的父元素——比「不在里面」更具体，换个地方挂也会红。
    expect(bar?.parentElement).toBe(scroller?.parentElement);
  });

  // A9：浮出条整条不进 tab 序（定稿 §5.2，user 2026-08-19 拍定）。
  //
  // 理由是层次：顶部横条跟正文并排、常驻，这一条浮在正文**上面**，而浮在上面
  // 的东西一旦拿走焦点就跟正文的焦点直接冲突。插件默认把容器设成
  // `tabIndex = 0`（`dist/index.js:178`），六个按钮又是原生 `<button>`、天生
  // 可聚焦，所以两样都要显式关掉。
  it('浮出条整条不接受 Tab 焦点：容器和六个按钮都是 -1', async () => {
    const editor = open('<p>hello world</p>');
    mount(editor);
    await selectWithFocus(editor, 1, 6);

    const bar = document.querySelector<HTMLElement>(
      '[data-testid="doc-selection-bubble-bar"]',
    );
    const buttons = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid^="doc-bubble-tool-"]'),
    );

    expect(bar).not.toBeNull();
    expect(bar?.tabIndex).toBe(-1);
    expect(buttons).toHaveLength(6);
    for (const button of buttons) {
      expect(button.tabIndex).toBe(-1);
    }
  });

  // A9 的另一半：顶部横条**不受影响**，它照常在 tab 序里——键盘用户的路就是它。
  it('顶部横条的按钮照常可聚焦', async () => {
    const editor = open('<p>hello world</p>');
    mount(editor);
    await selectWithFocus(editor, 1, 6);

    const toolbarButtons = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid^="doc-toolbar-tool-"]'),
    );

    expect(toolbarButtons.length).toBeGreaterThan(0);
    for (const button of toolbarButtons) {
      expect(button.tabIndex).toBe(0);
    }
  });

  // A8：两个载体的同名命令共用同一个 `canRun`，所以同一选区下亮暗必须一致。
  // 设计 §9 写了这一条，第一轮却一条测试都没有。
  it.each([
    ['整段普通文字都能用', '<p>hello world</p>', 1, 6, false],
    ['代码块里标记类命令用不了', '<pre><code>hello</code></pre>', 1, 6, true],
  ])('%s：两个载体的同名按钮亮暗一致', async (_name, body, from, to, hasDark) => {
    const editor = open(body);
    mount(editor);
    await selectWithFocus(editor, from, to);

    // 先确认这个选区真的造出了要测的那种局面。少了这一句，将来某天六个按钮
    // 全亮或全暗，两个载体照样「一致」，这条测试就变成了空话。
    const bubbleDisabled = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[data-testid^="doc-bubble-tool-"]'),
    ).filter((b) => b.disabled).length;
    expect(bubbleDisabled > 0).toBe(hasDark);

    for (const tool of [...MARK_TOOLS, ...BLOCK_TOOLS]) {
      const inBubble = document.querySelector<HTMLButtonElement>(
        `[data-testid="doc-bubble-tool-${tool.id}"]`,
      );
      const inToolbar = document.querySelector<HTMLButtonElement>(
        `[data-testid="doc-toolbar-tool-${tool.id}"]`,
      );
      expect(inBubble).not.toBeNull();
      expect(inToolbar).not.toBeNull();
      expect(`${tool.id}:${String(inBubble?.disabled)}`).toBe(
        `${tool.id}:${String(inToolbar?.disabled)}`,
      );
    }
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
