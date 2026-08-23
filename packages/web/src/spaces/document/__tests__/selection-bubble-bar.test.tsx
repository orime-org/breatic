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
import { TooltipProvider } from '@web/components/ui/tooltip';
import { DocumentEditor } from '@web/spaces/document/DocumentEditor';
import {
  MARK_TOOLS,
  BLOCK_TOOLS,
  INLINE_TOOLS,
} from '@web/spaces/document/document-tools';

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
  // 包一层 provider 模拟 App：全站只有一个 `TooltipProvider`、挂在 `App.tsx`，
  // 而条上那两个未开放的入口用 tooltip 说明自己为什么不能用。
  render(
    <TooltipProvider>
      <DocumentEditor editor={editor} readOnly={readOnly} />
    </TooltipProvider>,
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
  it('选中文字时出现，装的正好是那八个命令', async () => {
    const editor = open('<p>hello world</p>');
    mount(editor);
    await selectWithFocus(editor, 1, 6);

    const ids = Array.from(
      document.querySelectorAll('[data-testid^="doc-bubble-tool-"]'),
    ).map((el) => el.getAttribute('data-testid')?.replace('doc-bubble-tool-', ''));

    expect(ids.sort()).toEqual(
      [...BLOCK_TOOLS, ...MARK_TOOLS, ...INLINE_TOOLS].map((t) => t.id).sort(),
    );
  });

  // A4: the order the demo draws, read straight off the DOM. Asserted as the
  // whole sequence rather than a few neighbours — a control landing in the
  // wrong group is exactly what this has to catch, and pairwise checks let it
  // through.
  it('lays the controls out in the order the demo draws', async () => {
    const editor = open('<p>hello world</p>');
    mount(editor);
    await selectWithFocus(editor, 1, 6);

    const bar = document.querySelector('[data-testid="doc-selection-bubble-bar"]')!;
    const rendered = Array.from(
      bar.querySelectorAll('[data-testid^="doc-bubble-"]'),
    )
      .map((el) => el.getAttribute('data-testid'))
      .filter((id) => id !== 'doc-selection-bubble-bar');

    expect(rendered).toEqual([
      'doc-bubble-tool-bullet-list',
      'doc-bubble-tool-ordered-list',
      'doc-bubble-tool-quote',
      'doc-bubble-sep-marks',
      'doc-bubble-tool-bold',
      'doc-bubble-tool-italic',
      'doc-bubble-tool-strike',
      'doc-bubble-tool-underline',
      'doc-bubble-sep-inline',
      'doc-bubble-tool-code',
      'doc-bubble-coming-comment',
      'doc-bubble-sep-ai',
      'doc-bubble-coming-ai',
    ]);
  });

  // A5 / A6: what jsdom can answer about the separators is that they are
  // there, that they carry the semantics of one, and how many there are. The
  // geometry the demo pins (1px by 16px, 3px either side) needs a browser and
  // is measured in `selection-bubble-bar.spec.ts`.
  it('separates the groups with a real separator element', async () => {
    const editor = open('<p>hello world</p>');
    mount(editor);
    await selectWithFocus(editor, 1, 6);

    const bar = document.querySelector('[data-testid="doc-selection-bubble-bar"]')!;
    const seps = bar.querySelectorAll('[role="separator"]');

    expect(seps).toHaveLength(3);
    for (const sep of seps) {
      expect(sep.getAttribute('aria-orientation')).toBe('vertical');
    }
  });

  // A9 / A10: the two entries whose commands are not open yet. They stand in
  // the bar so the shape is whole, and say for themselves that they cannot be
  // used — the same treatment the two snapshot commands got in the
  // whole-document menu (task #129).
  it.each([
    ['comment'],
    ['ai'],
  ])('shows %s as an entry that is not open yet', async (id) => {
    const editor = open('<p>hello world</p>');
    mount(editor);
    await selectWithFocus(editor, 1, 6);

    const entry = screen.getByTestId(`doc-bubble-coming-${id}`);
    expect(entry).toHaveAttribute('aria-disabled', 'true');
    expect(entry.className).toContain('cursor-not-allowed');
    expect(entry.className).toContain('opacity-50');
  });

  // A10: clicking one changes neither the document nor the selection.
  it.each([
    ['comment'],
    ['ai'],
  ])('does nothing when %s is clicked', async (id) => {
    const editor = open('<p>hello world</p>');
    mount(editor);
    await selectWithFocus(editor, 1, 6);
    const before = markupOf();

    act(() => {
      screen.getByTestId(`doc-bubble-coming-${id}`).click();
    });

    expect(markupOf()).toBe(before);
  });

  // A11: the whole bar stays out of the tab order (ruling R4), so these two
  // follow the command buttons beside them. What they do carry is
  // `aria-disabled` rather than HTML `disabled`: the first leaves them in the
  // accessibility tree to be read, the second drops them out of it.
  it.each([
    ['comment'],
    ['ai'],
  ])('keeps %s out of the tab order, the way the bar does', async (id) => {
    const editor = open('<p>hello world</p>');
    mount(editor);
    await selectWithFocus(editor, 1, 6);

    const entry = screen.getByTestId(`doc-bubble-coming-${id}`);
    expect(entry.getAttribute('tabindex')).toBe('-1');
    expect(entry.hasAttribute('disabled')).toBe(false);
  });

  // A3: the buttons report what the document is, not what was last clicked.
  // Driven through the editor's own command so the path under test is the one
  // a keyboard shortcut takes — `Mod-u` and `Mod-e` reach exactly these.
  it('lights underline when the mark is on, whoever turned it on', async () => {
    const editor = open('<p>hello world</p>');
    mount(editor);
    await selectWithFocus(editor, 1, 6);
    const button = screen.getByTestId('doc-bubble-tool-underline');
    expect(button).toHaveAttribute('aria-pressed', 'false');

    act(() => {
      editor.commands.toggleUnderline();
    });
    await waitFor(() => expect(button).toHaveAttribute('aria-pressed', 'true'));

    act(() => {
      editor.commands.toggleUnderline();
    });
    await waitFor(() => expect(button).toHaveAttribute('aria-pressed', 'false'));
  });

  it('lights inline code when the mark is on, whoever turned it on', async () => {
    const editor = open('<p>hello world</p>');
    mount(editor);
    await selectWithFocus(editor, 1, 6);
    const button = screen.getByTestId('doc-bubble-tool-code');
    expect(button).toHaveAttribute('aria-pressed', 'false');

    act(() => {
      editor.commands.toggleCode();
    });
    await waitFor(() => expect(button).toHaveAttribute('aria-pressed', 'true'));

    act(() => {
      editor.commands.toggleCode();
    });
    await waitFor(() => expect(button).toHaveAttribute('aria-pressed', 'false'));
  });

  // A8: an icon-only button with no visible text is a square without a name.
  // Asserted as "not the key itself" rather than "not empty": `t()` hands back
  // the key when it resolves nothing (`shared/src/i18n/index.ts:131`), so a
  // label pointing at a key no catalog has would pass the weaker check.
  it.each([
    ['tool-underline', 'spaces.document.commands.underline'],
    ['tool-code', 'spaces.document.commands.code'],
    ['coming-comment', 'spaces.document.commands.comment'],
    ['coming-ai', 'spaces.document.commands.ai'],
  ])('gives %s a name that can be read out', async (id, key) => {
    const editor = open('<p>hello world</p>');
    mount(editor);
    await selectWithFocus(editor, 1, 6);

    const label = screen.getByTestId(`doc-bubble-${id}`).getAttribute('aria-label');
    expect(label).toBeTruthy();
    expect(label).not.toContain(key);
  });

  // A11: the whole bar stays out of the tab order (ruling R4), so these two
  // follow the command buttons beside them. What they do carry is
  // `aria-disabled` rather than HTML `disabled`: the first leaves them in the
  // accessibility tree to be read, the second drops them out of it.
  it.each([
    ['comment'],
    ['ai'],
  ])('keeps %s out of the tab order, the way the bar does', async (id) => {
    const editor = open('<p>hello world</p>');
    mount(editor);
    await selectWithFocus(editor, 1, 6);

    const entry = screen.getByTestId(`doc-bubble-coming-${id}`);
    expect(entry.getAttribute('tabindex')).toBe('-1');
    expect(entry.hasAttribute('disabled')).toBe(false);
  });

  // A8: an icon-only button with no visible text is a square without a name.
  // Asserted as "not the key itself" rather than "not empty": `t()` hands back
  // the key when it resolves nothing (`shared/src/i18n/index.ts:131`), so a
  // label pointing at a key no catalog has would pass the weaker check.
  it.each([
    ['tool-underline', 'spaces.document.commands.underline'],
    ['tool-code', 'spaces.document.commands.code'],
    ['coming-comment', 'spaces.document.commands.comment'],
    ['coming-ai', 'spaces.document.commands.ai'],
  ])('gives %s a name that can be read out', async (id, key) => {
    const editor = open('<p>hello world</p>');
    mount(editor);
    await selectWithFocus(editor, 1, 6);

    const label = screen.getByTestId(`doc-bubble-${id}`).getAttribute('aria-label');
    expect(label).toBeTruthy();
    expect(label).not.toContain(key);
  });

  // A11：这一步存在的唯一理由。六个逐一验，不抽验。
  // 标记是 Yjs 片段里的 schema 节点名，不是 HTML 标签名——`toString()` 打出来
  // 的是 `<bold>` / `<bulletlist>` 这一套。
  it.each([
    ['bold', '<bold>', '<p>hello world</p>', 1, 6],
    ['italic', '<italic>', '<p>hello world</p>', 1, 6],
    ['strike', '<strike>', '<p>hello world</p>', 1, 6],
    ['underline', '<underline>', '<p>hello world</p>', 1, 6],
    ['code', '<code>', '<p>hello world</p>', 1, 6],
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

  // A13: the command buttons carry a carrier prefix in their test id. With the
  // toolbar gone the bar is the only carrier rendering these `ToolDef`s, and
  // the prefix stays: the block handle menu (#113) will render the same
  // definitions, and an unprefixed id would then name two buttons.
  it('prefixes the command test ids with the carrier', async () => {
    const editor = open('<p>hello world</p>');
    mount(editor);
    await selectWithFocus(editor, 1, 6);

    expect(
      document.querySelectorAll('[data-testid="doc-bubble-tool-bold"]'),
    ).toHaveLength(1);
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

    it('head 那一行看不见时，锚的是选区起点那一行', async () => {
      const editor = open('<p>one</p><p>two</p><p>three</p>');
      mount(editor);
      await selectWithFocus(editor, 1, 4);
      pinViewport(new DOMRect(0, 100, 800, 400));

      act(() => {
        editor.commands.setTextSelection({ from: 2, to: 12 });
      });
      // 往下拖出去的选区：松手那端（12）已经滚过可见区下沿，起点（2）还在屏上。
      pinLines(editor, { 2: 200, 12: 900 });

      const rect = bubblePluginView(editor)
        .getReferencedVirtualElement?.()
        ?.getBoundingClientRect();

      // 起点那一行是 200 到 220，上下各撑 8。
      expect(rect?.top).toBe(192);
      expect(rect?.bottom).toBe(228);
    });

    it('两端都看不见时也锚起点那一行——藏不藏归 hide 中间件管', async () => {
      const editor = open('<p>one</p><p>two</p><p>three</p>');
      mount(editor);
      await selectWithFocus(editor, 1, 4);
      pinViewport(new DOMRect(0, 100, 800, 400));

      act(() => {
        editor.commands.setTextSelection({ from: 2, to: 12 });
      });
      // 选区整个跨过了可见区：起点在上面、松手那端在下面。这里不再去找第三条
      // 「读者当下看得见的行」——那条分支是前六轮实现对抗里五次承诺内问题的
      // 共同出处，现在锚点照常给出去，由 `hide` 判它在不在正文区域里。
      pinLines(editor, { 2: -300, 12: 900 });

      const rect = bubblePluginView(editor)
        .getReferencedVirtualElement?.()
        ?.getBoundingClientRect();

      expect(rect?.top).toBe(-308);
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
   * 规则是 user 2026-08-20 定的三条：全选那一刻鼠标在正文区域内就把条摆在鼠标
   * 那儿、不在就不显示；鼠标从正文外进到正文里时，如果是全选而条还没摆出来，
   * 就摆在鼠标那儿；条已经摆出来之后一律不再判、也不动。
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
     * 把插件的显示判据问一遍。
     *
     * 它问的是「插件如果现在被问，会答什么」，**不是「条现在在不在屏幕上」**。
     * 两者在这一档会分开：鼠标事件那条路要靠 `remember` 发两个 meta 去唤醒
     * 插件，而那两行删掉之后本文件一条都不红——实测。真正钉住「条被摆出来
     * 了」的是 `tests/smoke/selection-bubble-bar.spec.ts` 的「全选后鼠标回到
     * 正文里，条自己就出来了」，同一个变异下它当场红。
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

    it('鼠标从正文外面进到正文里，条就摆出来——不用等滚动', async () => {
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

      // 鼠标进到正文里。这一下就是触发时刻——不需要滚动，也不需要再按一次
      // 全选（user 2026-08-20 把触发条件从「每次滚动」改成「鼠标进入正文」）。
      moveMouseTo(420, 250);

      expect(shouldShowNow(editor)).toBe(true);
      expect(bubblePluginView(editor).isVisible).toBe(true);
      const rect = bubblePluginView(editor)
        .getReferencedVirtualElement?.()
        ?.getBoundingClientRect();
      expect(rect?.top).toBe(242);
      expect(rect?.left).toBe(420);
    });

    it('条摆出来之后鼠标再进出正文，位置一动不动', async () => {
      const editor = open('<p>one</p><p>two</p><p>three</p>');
      mount(editor);
      await selectWithFocus(editor, 1, 4);
      pinViewport(VIEWPORT);

      moveMouseTo(420, 250);
      act(() => {
        editor.commands.selectAll();
      });
      const first = bubblePluginView(editor)
        .getReferencedVirtualElement?.()
        ?.getBoundingClientRect();
      expect(first?.left).toBe(420);

      // 出去再进来：条已经摆出来了，这一进不该把它挪到新位置。
      moveMouseTo(420, 50);
      moveMouseTo(700, 300);

      const after = bubblePluginView(editor)
        .getReferencedVirtualElement?.()
        ?.getBoundingClientRect();
      expect(after?.left).toBe(420);
      expect(after?.top).toBe(first?.top);
    });

    it('鼠标进正文时不是全选，什么都不发生', async () => {
      const editor = open('<p>one</p><p>two</p><p>three</p>');
      mount(editor);
      await selectWithFocus(editor, 1, 4);
      pinViewport(VIEWPORT);

      // 选区只是一小段，鼠标从外面进来——这一档跟着选区走，不看鼠标。
      moveMouseTo(420, 50);
      act(() => {
        editor.commands.setTextSelection({ from: 1, to: 4 });
      });
      editor.view.coordsAtPos = () => ({ top: 200, bottom: 220, left: 40, right: 60 });
      moveMouseTo(420, 250);

      const rect = bubblePluginView(editor)
        .getReferencedVirtualElement?.()
        ?.getBoundingClientRect();
      // 锚在行上（200 撑 8），不是鼠标那一点。
      expect(rect?.top).toBe(192);
    });

    it('鼠标进正文不绕开显示判据：编辑器没有焦点时，条不摆出来', async () => {
      const editor = open('<p>one</p><p>two</p><p>three</p>');
      mount(editor);
      await selectWithFocus(editor, 1, 4);
      pinViewport(VIEWPORT);

      // 鼠标在正文外，全选：条不显示，也没钉住任何位置。
      moveMouseTo(420, 50);
      act(() => {
        editor.commands.selectAll();
      });
      expect(shouldShowNow(editor)).toBe(false);

      // 编辑器失去焦点——用户去别处打字了。
      act(() => {
        editor.view.dom.blur();
      });

      // 鼠标回到正文里。这一路自己也要问「编辑器有没有焦点」——它跟插件问的
      // 是同一个 `isWarranted`，不是另写一套；早先鼠标这条路带着自己那份更短
      // 的判据，于是条会浮在正文上，而用户正在别的输入框里打字。
      moveMouseTo(420, 250);

      expect(bubblePluginView(editor).isVisible).toBe(false);
    });

    it('文档里一个字都没有时，全选不显示这条', async () => {
      const editor = open('<p></p>');
      mount(editor);
      // 空文档里没有选区可选，浮出条从不出现，所以不能用 selectWithFocus。
      act(() => {
        editor.view.dom.focus();
      });
      pinViewport(VIEWPORT);

      moveMouseTo(420, 250);
      act(() => {
        editor.commands.selectAll();
      });

      // 六个按钮一个都不能用，一条全是死按钮的载体只是噪音（定稿 §3.3.1 给
      // viewer 不渲染整条的正是这个理由）。
      expect(shouldShowNow(editor)).toBe(false);
    });

    it('已经是全选之后，本地再来一笔事务也不会重新钉', async () => {
      const editor = open('<p>one</p><p>two</p><p>three</p>');
      mount(editor);
      await selectWithFocus(editor, 1, 4);
      pinViewport(VIEWPORT);

      moveMouseTo(420, 250);
      act(() => {
        editor.commands.selectAll();
      });
      const pinned = bubblePluginView(editor)
        .getReferencedVirtualElement?.()
        ?.getBoundingClientRect();
      expect(pinned?.left).toBe(420);

      // 把鼠标挪到别处，然后造一个事务。选区仍是全选，钉的位置不该动。挡住
      // 它的是 `follow` 里的 `became`——选区在上一笔就已经是全选了，这一笔
      // 不是「全选那一刻」，压根走不到 `pinToPointer`。
      //
      // `pinToPointer` 开头那句 `if (pinnedPoint()) return true` 挡的是同一
      // 件事，但它是第三道：实测单独删掉它，本文件一条都不红。它留着是那个
      // 函数自己的不变量（被调到时不覆盖已有的钉），不是这条规则的实现。
      moveMouseTo(700, 300);
      act(() => {
        editor.view.dispatch(editor.state.tr.insertText('x', 1, 1));
      });

      const after = bubblePluginView(editor)
        .getReferencedVirtualElement?.()
        ?.getBoundingClientRect();
      expect(after?.left).toBe(420);
    });

    it('条钉住之后，协作对端敲字不会把它挪到当下的鼠标位置', async () => {
      const editor = open('<p>one</p><p>two</p><p>three</p>');
      mount(editor);
      await selectWithFocus(editor, 1, 4);
      pinViewport(VIEWPORT);

      moveMouseTo(420, 250);
      act(() => {
        editor.commands.selectAll();
      });
      expect(
        bubblePluginView(editor)
          .getReferencedVirtualElement?.()
          ?.getBoundingClientRect().left,
      ).toBe(420);

      // 真的走一遍 wire：另一个 Y.Doc 上打一个字，把增量应用回来。上一条用的
      // 本地 dispatch 代替不了它——y-prosemirror 把每一笔远程变更投递成整篇
      // 文档的替换，途中的选区跟本地事务里那个不是一回事。
      const remote = new Y.Doc();
      Y.applyUpdate(remote, Y.encodeStateAsUpdate(doc));
      const paragraph = documentBodyFragment(remote).get(0) as Y.XmlElement;
      (paragraph.get(0) as Y.XmlText).insert(0, 'x');

      moveMouseTo(700, 300);
      act(() => {
        Y.applyUpdate(
          doc,
          Y.encodeStateAsUpdate(remote, Y.encodeStateVector(doc)),
        );
      });
      remote.destroy();

      expect(
        bubblePluginView(editor)
          .getReferencedVirtualElement?.()
          ?.getBoundingClientRect().left,
      ).toBe(420);
    });

    it('鼠标一步没动，正文区域长大把它包了进来——下一个鼠标事件就该摆出条', async () => {
      const editor = open('<p>one</p><p>two</p><p>three</p>');
      mount(editor);
      await selectWithFocus(editor, 1, 4);

      // 正文区域先是窄的，鼠标停在它右边外面。
      pinViewport(new DOMRect(0, 100, 400, 400));
      moveMouseTo(600, 250);
      act(() => {
        editor.commands.selectAll();
      });
      expect(shouldShowNow(editor)).toBe(false);

      // 窗口拉宽，正文区域跟着长大，同一个坐标现在落在区域里。鼠标一步没动，
      // 所以判据要是「这次在里面、上次在外面」就永远算不出来——两次读数是同
      // 一个点，拿长大后的区域去判，两次都在里面。
      pinViewport(new DOMRect(0, 100, 800, 400));
      moveMouseTo(600, 250);

      expect(shouldShowNow(editor)).toBe(true);
      expect(
        bubblePluginView(editor)
          .getReferencedVirtualElement?.()
          ?.getBoundingClientRect().left,
      ).toBe(600);
    });

    it('鼠标从页面出现起一步没动过，滚一下滚轮就把条摆出来', async () => {
      const editor = open('<p>one</p><p>two</p><p>three</p>');
      mount(editor);
      await selectWithFocus(editor, 1, 4);
      pinViewport(VIEWPORT);

      // 一次 mousemove 都没派发过：位置未知，键盘全选摆不出条。
      act(() => {
        editor.commands.selectAll();
      });
      expect(shouldShowNow(editor)).toBe(false);

      // 滚轮也是鼠标事件，它带着 clientX/clientY（`scroll` 不带）。这是
      // 「鼠标一步没动」时唯一能知道它在哪的途径。删掉 `wheel` 那行监听
      // 这条就红。
      act(() => {
        document.dispatchEvent(
          new MouseEvent('wheel', { clientX: 420, clientY: 250, bubbles: true }),
        );
      });

      expect(shouldShowNow(editor)).toBe(true);
      expect(
        bubblePluginView(editor)
          .getReferencedVirtualElement?.()
          ?.getBoundingClientRect().left,
      ).toBe(420);
    });

    it('编辑器没有焦点时变成全选，不钉——焦点回来也不会凭空摆出来', async () => {
      const editor = open('<p>one</p><p>two</p><p>three</p>');
      mount(editor);
      await selectWithFocus(editor, 1, 4);
      pinViewport(VIEWPORT);

      // 鼠标在正文里，但用户人在别处，编辑器没有焦点。
      moveMouseTo(420, 250);
      act(() => {
        editor.view.dom.blur();
      });
      act(() => {
        editor.commands.selectAll();
      });
      expect(shouldShowNow(editor)).toBe(false);

      // 焦点回来。「全选那一刻」已经过去了，而那一刻条件不满足；这一刻不是
      // 任何一个判断时刻，所以条不该凭空出现。删掉 `follow` 里那句
      // `isWarranted` 这条就红——全选那一刻会钉，焦点一回来条就摆出来。
      act(() => {
        editor.view.dom.focus();
      });
      expect(shouldShowNow(editor)).toBe(false);
    });

    it('编辑器没有焦点时，别人的事务不该替鼠标把位置钉下来', async () => {
      const editor = open('<p>one</p><p>two</p><p>three</p>');
      mount(editor);
      await selectWithFocus(editor, 1, 4);
      pinViewport(VIEWPORT);

      // 鼠标在正文外面全选：不显示，也没钉。
      moveMouseTo(420, 50);
      act(() => {
        editor.commands.selectAll();
      });
      expect(shouldShowNow(editor)).toBe(false);

      // 用户切走了，编辑器失焦；鼠标路过正文。这一下 `remember` 会被
      // `isWarranted` 挡住，不钉——这一半本轮已经做对了。
      act(() => {
        editor.view.dom.blur();
      });
      moveMouseTo(420, 250);
      expect(shouldShowNow(editor)).toBe(false);

      // 协作对端敲一个字。选区仍是全选，于是 `follow` 跑——而它不问有没有
      // 焦点，直接拿「鼠标最后路过的那个点」钉了下来。
      const remote = new Y.Doc();
      Y.applyUpdate(remote, Y.encodeStateAsUpdate(doc));
      const paragraph = documentBodyFragment(remote).get(0) as Y.XmlElement;
      (paragraph.get(0) as Y.XmlText).insert(0, 'x');
      act(() => {
        Y.applyUpdate(
          doc,
          Y.encodeStateAsUpdate(remote, Y.encodeStateVector(doc)),
        );
      });
      remote.destroy();

      // 鼠标早就走了，用户也切回来了（焦点回来，选区没变）。条不该拿那个
      // 早已作废的点摆出来。
      moveMouseTo(700, 380);
      act(() => {
        editor.view.dom.focus();
      });

      expect(shouldShowNow(editor)).toBe(false);
    });

    it('鼠标离开页面之后位置就不知道了——键盘全选不把条摆出来', async () => {
      const editor = open('<p>one</p><p>two</p><p>three</p>');
      mount(editor);
      await selectWithFocus(editor, 1, 4);
      pinViewport(VIEWPORT);

      moveMouseTo(420, 250);

      // 指针离开页面：`mouseout` 冒泡到 document，而 `relatedTarget` 是空的
      // ——它没有进入任何元素，也就是去了浏览器外面。
      act(() => {
        document.dispatchEvent(
          new MouseEvent('mouseout', { bubbles: true, relatedTarget: null }),
        );
      });

      act(() => {
        editor.commands.selectAll();
      });
      expect(shouldShowNow(editor)).toBe(false);
    });

    it('页面内部的 mouseout 不算离开——最后那个坐标还作数', async () => {
      const editor = open('<p>one</p><p>two</p><p>three</p>');
      mount(editor);
      await selectWithFocus(editor, 1, 4);
      pinViewport(VIEWPORT);

      moveMouseTo(420, 250);

      // 指针从一个元素移到另一个元素，页面内部每一次都这样发一遍。
      // `relatedTarget` 指名了进入的那个元素，所以这不是离开。
      act(() => {
        document.dispatchEvent(
          new MouseEvent('mouseout', {
            bubbles: true,
            relatedTarget: document.body,
          }),
        );
      });

      act(() => {
        editor.commands.selectAll();
      });
      expect(shouldShowNow(editor)).toBe(true);
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

  // 第八轮实现对抗查实：`tabIndex = -1` 挡的是 Tab，不挡鼠标。点条的内边距
  // 或一个禁用按钮，焦点就落进条里、正文的选中高亮被清掉，而插件那两条 hide
  // 路径（preventHide 和 relatedTarget）双双被吃掉，条从此赖在正文上。
  it('浮出条整条不可聚焦——鼠标点它的空白处也带不走焦点', async () => {
    const editor = open('<p>hello world</p>');
    mount(editor);
    await selectWithFocus(editor, 1, 6);

    const bar = document.querySelector<HTMLElement>(
      '[data-testid="doc-selection-bubble-bar"]',
    );
    expect(bar).not.toBeNull();
    // 没有 tabindex 属性的 div 天生不可聚焦，Tab 和鼠标两条路一起断掉；
    // `tabIndex = -1` 只断前一条。
    expect(bar?.hasAttribute('tabindex')).toBe(false);

    act(() => {
      bar?.focus();
    });
    expect(document.activeElement).not.toBe(bar);
  });

  it('正文区域被读到零尺寸时，钉住的坐标不参与换算', async () => {
    const editor = open('<p>one</p><p>two</p><p>three</p>');
    mount(editor);
    await selectWithFocus(editor, 1, 4);
    pinSelectionBox(SELECTION_BOX);
    pinViewport(new DOMRect(0, 100, 800, 400));

    act(() => {
      document.dispatchEvent(
        new MouseEvent('mousemove', { clientX: 420, clientY: 250, bubbles: true }),
      );
      editor.commands.selectAll();
    });
    const before = bubblePluginView(editor)
      .getReferencedVirtualElement?.()
      ?.getBoundingClientRect();
    expect(before?.left).toBe(420);

    // 这里不针对任何具体场景——第九轮对抗把原稿点名的两个（Space 切换、
    // 面板折叠）都证伪了。它是那个比例换算自己的定义域。**新**框为零时算出
    // 来的是 `0`（比例乘以零宽），不是 NaN——实测；条会跳到区域左上角。
    pinViewport(new DOMRect(0, 100, 0, 0));
    bubblePluginView(editor).getReferencedVirtualElement?.();

    // 尺寸回来之后，坐标必须还是原来那个。
    pinViewport(new DOMRect(0, 100, 800, 400));
    const after = bubblePluginView(editor)
      .getReferencedVirtualElement?.()
      ?.getBoundingClientRect();
    expect(after?.left).toBe(420);
  });

  // 上一条判的是**新**读数为零；分母其实是**旧**框——点当初是在那个框里定的
  // 位置。旧框也能是零：`isInside` 接受一个塌成一点的矩形（`x >= left &&
  // x <= right` 在两者相等时同时成立），所以一次 0×0 的读数照样能让坐标被
  // 记下来。删掉那半判据这条就红。
  it('钉下坐标时区域是零尺寸，之后也不拿它当分母', async () => {
    const editor = open('<p>one</p><p>two</p><p>three</p>');
    mount(editor);
    await selectWithFocus(editor, 1, 4);
    pinSelectionBox(SELECTION_BOX);

    // 区域塌成 (420,250) 这一个点，鼠标正好停在那儿——`isInside` 放行。
    pinViewport(new DOMRect(420, 250, 0, 0));
    act(() => {
      document.dispatchEvent(
        new MouseEvent('mousemove', { clientX: 420, clientY: 250, bubbles: true }),
      );
      editor.commands.selectAll();
    });

    // 区域恢复正常尺寸。分母是钉下时那个零宽，而分子也是零——指针只有正好
    // 落在那一个点上才过得了 `isInside`，所以不判的话算的是 `0 / 0`，得 NaN。
    pinViewport(new DOMRect(0, 100, 800, 400));
    const rect = bubblePluginView(editor)
      .getReferencedVirtualElement?.()
      ?.getBoundingClientRect();
    expect(rect?.left).toBe(420);
    expect(Number.isFinite(rect?.left)).toBe(true);
    expect(Number.isFinite(rect?.top)).toBe(true);
  });

  // 窗口连着变两次，条落在哪，跟一步变到最终尺寸应当一致——A17 说的「跟着动」
  // 不能因为中间经过了几步就漂。
  //
  // 这条**分辨不出**换算把中间结果存不存回去：两种写法都满足这个性质（线性
  // 映射可传递），实测把存回那两行加回来它照样绿。所以它是这个性质的守卫，
  // 不是那次改写的守卫；那次改写按非逻辑改动处理，依据是让读取函数不再写。
  it('区域连着变两次，跟一步变到位算出来的是同一个点', async () => {
    const editorA = open('<p>one</p><p>two</p><p>three</p>');
    mount(editorA);
    await selectWithFocus(editorA, 1, 4);
    pinSelectionBox(SELECTION_BOX);
    pinViewport(new DOMRect(0, 100, 800, 400));
    act(() => {
      document.dispatchEvent(
        new MouseEvent('mousemove', { clientX: 420, clientY: 250, bubbles: true }),
      );
      editorA.commands.selectAll();
    });

    // 走两步：800 → 600 → 400。
    pinViewport(new DOMRect(0, 100, 600, 400));
    bubblePluginView(editorA).getReferencedVirtualElement?.();
    pinViewport(new DOMRect(0, 100, 400, 400));
    const twoSteps = bubblePluginView(editorA)
      .getReferencedVirtualElement?.()
      ?.getBoundingClientRect();

    // 一步到位：800 → 400。
    pinViewport(new DOMRect(0, 100, 800, 400));
    const oneStep = bubblePluginView(editorA)
      .getReferencedVirtualElement?.()
      ?.getBoundingClientRect();
    expect(oneStep?.left).toBe(420);
    pinViewport(new DOMRect(0, 100, 400, 400));
    const direct = bubblePluginView(editorA)
      .getReferencedVirtualElement?.()
      ?.getBoundingClientRect();

    expect(twoSteps?.left).toBe(direct?.left);
    expect(twoSteps?.top).toBe(direct?.top);
  });

  // 「区域变没变」比的是四个数。只比宽高的话，一个平移了但没缩放的区域会被
  // 当成没变，而换算公式读的正是 left/top——条会留在正文原来的位置上。
  it('区域整体平移、尺寸没变时，钉住的点跟着平移', async () => {
    const editor = open('<p>one</p><p>two</p><p>three</p>');
    mount(editor);
    await selectWithFocus(editor, 1, 4);
    pinSelectionBox(SELECTION_BOX);
    pinViewport(new DOMRect(0, 100, 800, 400));

    act(() => {
      document.dispatchEvent(
        new MouseEvent('mousemove', { clientX: 420, clientY: 250, bubbles: true }),
      );
      editor.commands.selectAll();
    });
    expect(
      bubblePluginView(editor)
        .getReferencedVirtualElement?.()
        ?.getBoundingClientRect().left,
    ).toBe(420);

    // 同样大小的区域，整体右移 100、下移 50。点在区域里的相对位置不变，屏幕
    // 坐标跟着 +100 / +50。
    pinViewport(new DOMRect(100, 150, 800, 400));
    const moved = bubblePluginView(editor)
      .getReferencedVirtualElement?.()
      ?.getBoundingClientRect();
    expect(moved?.left).toBe(520);
    // 锚点是零高度的点上下各撑 8，所以顶 = 钉住的 y 减 8。
    expect(moved?.top).toBe(250 + 50 - 8);
  });

  // 竖直方向的换算单独走一遍：只改高度，不动宽度。上一条改的是位置，这条改
  // 的是尺寸——把 `moved.y` 里的 `area.height` 写成 `area.width` 这类同族错误
  // 只有这条钉得住，而两条轴的代码几乎一模一样，正是最容易漏改一个词的形状。
  it('区域高度变了，钉住的点按高度比例跟着动', async () => {
    const editorH = open('<p>one</p><p>two</p><p>three</p>');
    mount(editorH);
    await selectWithFocus(editorH, 1, 4);
    pinSelectionBox(SELECTION_BOX);
    pinViewport(new DOMRect(0, 100, 800, 400));
    act(() => {
      document.dispatchEvent(
        new MouseEvent('mousemove', { clientX: 420, clientY: 300, bubbles: true }),
      );
      editorH.commands.selectAll();
    });

    // 点在区域里的纵向相对位置是 (300 − 100) ÷ 400 = 0.5。
    // 高度减半之后应当落在 100 + 0.5 × 200 = 200。
    pinViewport(new DOMRect(0, 100, 800, 200));
    const rect = bubblePluginView(editorH)
      .getReferencedVirtualElement?.()
      ?.getBoundingClientRect();
    expect(rect?.top).toBe(200 - 8);
    // 宽度没变，横坐标不该动。
    expect(rect?.left).toBe(420);
  });

  // 第九轮实现对抗查实：去掉 tabindex 只改了焦点的落点，没挡住焦点离开正文。
  // 点条的内边距，正文失焦、选中高亮消失，而插件的 `preventHide`（捕获相
  // mousedown，`dist/index.js:78-79` 定义、`:182` 注册）让 `blurHandler` 走到
  // `:106-108` 就返回，条不隐藏；之后没有事务，也就没有人再问一次该不该显示。
  //
  // 做法跟 Slate 官方 hovering-toolbar 示例一致（`site/examples/ts/
  // hovering-toolbar.tsx`，注释原文「prevent toolbar from taking focus away
  // from editor」）：在条上阻止 mousedown 的默认行为，焦点根本不动。
  //
  // 这里只验「默认行为被阻止了」这一件事，**焦点真的没走**在这一层验不了：
  // jsdom 的 mousedown 默认行为本来就不移动焦点，阻不阻止都一样。量焦点的是
  // `tests/smoke/selection-bubble-bar.spec.ts` 的「按过浮出条之后再点到编辑器
  // 外面，条要消失」，那条在真浏览器里数过——按条 0 次 blur、按 Tab 2 次。
  it('按下浮出条时阻止默认行为', async () => {
    const editor = open('<p>hello world</p>');
    mount(editor);
    await selectWithFocus(editor, 1, 6);

    const bar = document.querySelector<HTMLElement>(
      '[data-testid="doc-selection-bubble-bar"]',
    );
    expect(bar).not.toBeNull();

    const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    act(() => {
      bar?.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(true);
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

  // 没有选区时八个按钮根本不建。查的是插件自己那个元素而不是 document：条隐藏
  // 时它被 `element.remove()` 摘出文档（`dist/index.js:377-379`），从 document
  // 里查什么都查不到，那样的断言分辨不出「没建」和「建了但不在文档里」。
  //
  // 为什么要不建：每个按钮都在每一笔事务上跑一次自己命令的干跑（`canRun`），
  // 而浮出条绝大多数时间是隐藏的——留着它们等于给每次击键多付八次干跑，换来
  // 一个没人看得见的载体。
  it('没有选区时，浮出条里一个按钮都不建', async () => {
    const editor = open('<p>hello world</p>');
    mount(editor);
    await selectWithFocus(editor, 1, 6);
    const view = bubblePluginView(editor);
    expect(
      view.element?.querySelectorAll('[data-testid^="doc-bubble-tool-"]'),
    ).toHaveLength(8);

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
  // 的东西一旦拿走焦点就跟正文的焦点直接冲突。六个按钮是原生 `<button>`、天生
  // 可聚焦，所以每个都显式设成 -1。
  //
  // 容器那一半不在这里：插件默认给它 `tabIndex = 0`（`dist/index.js:178`），
  // 而实现的做法是把属性整个删掉、不是设成 -1（-1 仍然可聚焦，只是不进 Tab
  // 序，鼠标点得进去）。钉它的是上面「整条不可聚焦」那条的
  // `hasAttribute('tabindex')`。这里读 `bar.tabIndex` 读不出区别——没有属性的
  // div 本来就答 -1。
  it('浮出条的八个命令按钮都不进 Tab 序', async () => {
    const editor = open('<p>hello world</p>');
    mount(editor);
    await selectWithFocus(editor, 1, 6);

    const buttons = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid^="doc-bubble-tool-"]'),
    );

    expect(buttons).toHaveLength(8);
    for (const button of buttons) {
      expect(button.tabIndex).toBe(-1);
    }
  });

  // A8: whether a button is lit has to be exactly its command's `canRun`.
  //
  // This used to read "the same button is lit the same way in both carriers",
  // which lost its subject when the toolbar went. What it uniquely covers is
  // the wiring rather than the agreement: `document-tools-availability.test.ts`
  // pins what the pure `canRun` answers across selection shapes, and cannot
  // reach whether that answer arrives at the DOM's `disabled`. So it compares
  // those two directly.
  it.each([
    ['整段普通文字都能用', '<p>hello world</p>', 1, 6, false],
    ['代码块里标记类命令用不了', '<pre><code>hello</code></pre>', 1, 6, true],
  ])('%s: the buttons agree with canRun', async (_name, body, from, to, hasDark) => {
    const editor = open(body);
    mount(editor);
    await selectWithFocus(editor, from, to);

    // 先确认这个选区真的造出了要测的那种局面。少了这一句，将来某天六个按钮
    // All lit or all dark would still "agree", and this would say nothing.
    const dark = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[data-testid^="doc-bubble-tool-"]'),
    ).filter((b) => b.disabled).length;
    expect(dark > 0).toBe(hasDark);

    for (const tool of [...MARK_TOOLS, ...BLOCK_TOOLS]) {
      const button = document.querySelector<HTMLButtonElement>(
        `[data-testid="doc-bubble-tool-${tool.id}"]`,
      );
      expect(button).not.toBeNull();
      expect(`${tool.id}:${String(button?.disabled)}`).toBe(
        `${tool.id}:${String(!tool.canRun(editor))}`,
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
