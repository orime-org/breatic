// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * 浮出条的壳子（任务 #915）。
 *
 * #912 把按钮高度落到 `--btn-inline` 之后，条的尺寸对了，格位还没对：demo
 * （`2026-08-21-editor-command-surface.html:477-519`，第 521 行的说明）画的是
 * 五组四线 —— 块类型下拉 ｜ 对齐下拉 ｜ 粗体 斜体 删除线 下划线 ｜ 链接
 * 行内代码 颜色 评论 ｜ AI，而条上今天是四组：块类型做成了三个平铺按钮，
 * 对齐和颜色两格整个不存在。
 *
 * 这个文件钉住的是**壳子**：格位、每格的形态、四个下拉展开之后的内容，以及
 * 没接命令的那些项按「还没开放」的既有表示画（user 2026-08-23 的规则，实现在
 * `document-coming-tool.tsx`，user 2026-08-26 确认沿用）。命令本身接没接是
 * 另一回事 —— 今天能一路走到函数的只有无序列表、有序列表、引用三个。
 *
 * 条的定位、出现时机、滚动跟随归 `selection-bubble-bar.test.tsx`，那个文件
 * 已经装着它们。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act, waitFor, fireEvent } from '@testing-library/react';
import { Editor } from '@tiptap/react';
import * as Y from 'yjs';

import { documentBodyFragment, encodeInitialSpaceContent } from '@breatic/shared';
import { buildDocumentExtensions } from '@web/spaces/document/document-extensions';
import { TooltipProvider } from '@web/components/ui/tooltip';
import { DocumentEditor } from '@web/spaces/document/DocumentEditor';

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
  // 内容在构造之后灌，不走 `content` 选项：编辑器绑在 Y.Doc 上，构造期的内容
  // 跟协作扩展的初始同步撞在一起，正文进不去，选区落在空文档上。
  if (bodyHtml) editor.commands.setContent(bodyHtml);
  return editor;
}

/**
 * 选中一段文字，并让编辑器真的持有焦点。
 *
 * 焦点不是可有可无的布置：显示判据的第一条就是编辑器持有焦点，不满足条整个
 * 不进 DOM，任何查询都落空。
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
  // 插件对选区变化有 250ms 防抖（`updateDelay` 的默认值），而条是在 `show()`
  // 里才 `appendChild` 进 DOM 的。同步断言会跑在它前面、什么都查不到。
  await waitFor(() => {
    expect(
      document.querySelectorAll('[data-testid^="doc-bubble-tool-"]').length,
    ).toBeGreaterThan(0);
  });
}

/**
 * 把编辑器连同它的载体渲染进 document。
 * @param editor - 已经装好正文的编辑器。
 */
function mount(editor: Editor): void {
  render(
    <TooltipProvider>
      <DocumentEditor editor={editor} />
    </TooltipProvider>,
  );
}

/**
 * 条上从左到右每一格的 test id，分隔线也算一格。
 * @returns 每一格的 test id。
 */
function slotsInOrder(): string[] {
  const bar = screen.getByTestId('doc-selection-bubble-bar');
  return Array.from(bar.querySelectorAll('[data-testid]')).map(
    (n) => n.getAttribute('data-testid') as string,
  );
}

/** 正文带标记的样子，用来判命令有没有真的改到文档。 */
function markupOf(): string {
  return documentBodyFragment(doc)
    .toArray()
    .map((n) => n.toString())
    .join('');
}

/**
 * 把指针移到某一格上，等它的菜单出来。
 * @param slotId - 那一格的 test id。
 * @returns 展开的菜单元素。
 */
async function hoverOpen(slotId: string): Promise<HTMLElement> {
  act(() => {
    fireEvent.pointerEnter(screen.getByTestId(slotId));
  });
  return waitFor(() => screen.getByTestId(`${slotId}-menu`));
}

describe('浮出条的壳子', () => {
  describe('格位', () => {
    it('draws five groups split by four separators, in the demo order', async () => {
      const editor = open('<p>the quick brown fox</p>');
      mount(editor);
      await selectWithFocus(editor, 1, 10);

      // demo:521 —— 块类型下拉 ｜ 对齐下拉 ｜ 粗体 斜体 删除线 下划线 ｜
      // 链接 行内代码 颜色 评论 ｜ AI。
      expect(slotsInOrder()).toEqual([
        'doc-bubble-block-type',
        'doc-bubble-sep-align',
        'doc-bubble-align',
        'doc-bubble-sep-marks',
        'doc-bubble-tool-bold',
        'doc-bubble-tool-italic',
        'doc-bubble-tool-strike',
        'doc-bubble-tool-underline',
        'doc-bubble-sep-inline',
        'doc-bubble-tool-link',
        'doc-bubble-tool-code',
        'doc-bubble-color',
        'doc-bubble-coming-comment',
        'doc-bubble-sep-ai',
        'doc-bubble-coming-ai',
      ]);
    });

    it('gives the block type slot the icon of the block the cursor sits in', async () => {
      const editor = open('<h1>a heading</h1><p>a paragraph</p>');
      mount(editor);

      await selectWithFocus(editor, 2, 6);
      expect(
        screen.getByTestId('doc-bubble-block-type').getAttribute('data-block-type'),
      ).toBe('heading-1');

      await act(async () => {
        editor.commands.setTextSelection({ from: 14, to: 20 });
      });
      await waitFor(() => {
        expect(
          screen.getByTestId('doc-bubble-block-type').getAttribute('data-block-type'),
        ).toBe('paragraph');
      });
    });

    it('falls back to the paragraph icon when the selection spans two block types', async () => {
      const editor = open('<h1>a heading</h1><p>a paragraph</p>');
      mount(editor);
      // 从标题里一直选到段落里，跨了两种块。
      await selectWithFocus(editor, 2, 20);

      expect(
        screen.getByTestId('doc-bubble-block-type').getAttribute('data-block-type'),
      ).toBe('paragraph');
    });
  });

  describe('还没开放的项', () => {
    /**
     * user 2026-08-23 定的规则，原话在 `document-coming-tool.tsx:4-33`：
     * 「even with no function behind it, leave the shell there」，紧接着
     * 「What it must not do is look usable: a control that reads as available
     * and answers a click with nothing tells the reader it is broken」。
     */
    it('marks the two slots with nothing behind them as not open yet', async () => {
      const editor = open('<p>the quick brown fox</p>');
      mount(editor);
      await selectWithFocus(editor, 1, 10);

      for (const id of ['doc-bubble-align', 'doc-bubble-color']) {
        const slot = screen.getByTestId(id);
        expect(slot.getAttribute('aria-disabled')).toBe('true');
        expect(slot.className).toContain('opacity-50');
        expect(slot.className).toContain('cursor-not-allowed');
      }
    });

    it('keeps the treatment the AI slot already carries', async () => {
      const editor = open('<p>the quick brown fox</p>');
      mount(editor);
      await selectWithFocus(editor, 1, 10);

      const ai = screen.getByTestId('doc-bubble-coming-ai');
      expect(ai.getAttribute('aria-disabled')).toBe('true');
      expect(ai.className).toContain('opacity-50');
    });
  });

  describe('tab 序', () => {
    /**
     * 定稿 R4 后半句（user 2026-08-19）：浮出条整条永不进 tab 序。四个新下拉
     * 的触发器是 Radix 的 `DropdownMenuTrigger`，它不自带 `tabIndex={-1}`
     * （`components/ui/dropdown-menu.tsx` 里 `tabIndex` 零命中）。
     */
    it('keeps the four new openers out of the tab order', async () => {
      const editor = open('<p>the quick brown fox</p>');
      mount(editor);
      await selectWithFocus(editor, 1, 10);

      for (const id of [
        'doc-bubble-block-type',
        'doc-bubble-align',
        'doc-bubble-color',
        'doc-bubble-coming-ai',
      ]) {
        expect(screen.getByTestId(id).getAttribute('tabindex')).toBe('-1');
      }
    });
  });
  describe('菜单', () => {
    it('opens on hover, and again on click', async () => {
      const editor = open('<p>the quick brown fox</p>');
      mount(editor);
      await selectWithFocus(editor, 1, 10);

      await hoverOpen('doc-bubble-block-type');

      // 指针离开整片区域，菜单收起，格子还在（B4）。
      act(() => {
        fireEvent.pointerLeave(screen.getByTestId('doc-bubble-block-type-zone'));
      });
      await waitFor(() => {
        expect(screen.queryByTestId('doc-bubble-block-type-menu')).toBeNull();
      });
      expect(screen.queryByTestId('doc-bubble-block-type')).not.toBeNull();

      // 定稿 R4 后半句（user 2026-08-19）：入口也能用点击打开。
      act(() => {
        screen.getByTestId('doc-bubble-block-type').click();
      });
      await waitFor(() => {
        expect(screen.queryByTestId('doc-bubble-block-type-menu')).not.toBeNull();
      });
    });

    it('keeps the menu up while the pointer crosses from the slot onto it', async () => {
      const editor = open('<p>the quick brown fox</p>');
      mount(editor);
      await selectWithFocus(editor, 1, 10);
      const menu = await hoverOpen('doc-bubble-block-type');

      // 指针离开格子本身、进到菜单上 —— 中间那道缝算在区域内，菜单不许消失
      // （WCAG 2.1 SC 1.4.13 Hoverable）。
      act(() => {
        fireEvent.pointerLeave(screen.getByTestId('doc-bubble-block-type'));
        fireEvent.pointerEnter(menu);
      });
      expect(screen.queryByTestId('doc-bubble-block-type-menu')).not.toBeNull();
    });

    it('hands the open menu over when the pointer moves to another slot', async () => {
      const editor = open('<p>the quick brown fox</p>');
      mount(editor);
      await selectWithFocus(editor, 1, 10);
      await hoverOpen('doc-bubble-block-type');

      act(() => {
        fireEvent.pointerEnter(screen.getByTestId('doc-bubble-align'));
      });
      await waitFor(() => {
        expect(screen.queryByTestId('doc-bubble-align-menu')).not.toBeNull();
      });
      expect(screen.queryByTestId('doc-bubble-block-type-menu')).toBeNull();
    });

    it('leaves the bar on screen while a menu is up', async () => {
      const editor = open('<p>the quick brown fox</p>');
      mount(editor);
      await selectWithFocus(editor, 1, 10);
      await hoverOpen('doc-bubble-block-type');

      const bar = screen.getByTestId('doc-selection-bubble-bar');
      expect(bar.className).not.toContain('invisible');
    });

    it('leaves the focus in the editor through open and close', async () => {
      const editor = open('<p>the quick brown fox</p>');
      mount(editor);
      await selectWithFocus(editor, 1, 10);
      await hoverOpen('doc-bubble-block-type');

      // Radix 默认打开时 focus 到菜单内容、关闭时 focus 回 trigger
      // （`@radix-ui/react-menu:266-268` · `@radix-ui/react-dropdown-menu:114-115`）。
      // 两个回调都要拦掉，焦点全程留在编辑器里，5.1 和 5.3 才解耦。
      expect(editor.view.hasFocus()).toBe(true);

      act(() => {
        fireEvent.pointerLeave(screen.getByTestId('doc-bubble-block-type-zone'));
      });
      await waitFor(() => {
        expect(screen.queryByTestId('doc-bubble-block-type-menu')).toBeNull();
      });
      expect(editor.view.hasFocus()).toBe(true);
    });

    it('swallows the wheel over the menu, and closes once the body really scrolls', async () => {
      const editor = open('<p>the quick brown fox</p>');
      mount(editor);
      await selectWithFocus(editor, 1, 10);
      const menu = await hoverOpen('doc-bubble-block-type');

      // 指针停在菜单上时正文滚不动（B5）。断言的是 `preventDefault` 被调用 ——
      // jsdom 不实现滚动，`scrollTop` 不管拦没拦住都不会变。
      const wheel = new WheelEvent('wheel', {
        deltaY: 40,
        bubbles: true,
        cancelable: true,
      });
      act(() => {
        menu.dispatchEvent(wheel);
      });
      expect(wheel.defaultPrevented).toBe(true);

      // 正文真的滚了，菜单必须消失（B6）。
      const scroller = document.querySelector(
        '.doc-body-scroller [data-radix-scroll-area-viewport]',
      ) as HTMLElement;
      act(() => {
        fireEvent.scroll(scroller);
      });
      await waitFor(() => {
        expect(screen.queryByTestId('doc-bubble-block-type-menu')).toBeNull();
      });
    });
  });

  describe('菜单里装什么', () => {
    it('lists the nine block types the demo draws, with their shortcuts', async () => {
      const editor = open('<p>the quick brown fox</p>');
      mount(editor);
      await selectWithFocus(editor, 1, 10);
      const menu = await hoverOpen('doc-bubble-block-type');

      const items = Array.from(menu.querySelectorAll('[data-testid^="doc-bubble-block-type-item-"]'));
      expect(items.map((n) => n.getAttribute('data-testid'))).toEqual([
        'doc-bubble-block-type-item-paragraph',
        'doc-bubble-block-type-item-heading-1',
        'doc-bubble-block-type-item-heading-2',
        'doc-bubble-block-type-item-heading-3',
        'doc-bubble-block-type-item-bullet-list',
        'doc-bubble-block-type-item-ordered-list',
        'doc-bubble-block-type-item-quote',
        'doc-bubble-block-type-item-code-block',
        'doc-bubble-block-type-item-task-list',
      ]);

      // demo:566-585 给七项画了快捷键列。
      const shortcuts = items.map((n) => n.querySelector('[data-slot="dropdown-menu-shortcut"]')?.textContent ?? null);
      expect(shortcuts).toEqual([
        null,
        '⌘⌥1',
        '⌘⌥2',
        '⌘⌥3',
        '⌘⇧8',
        '⌘⇧7',
        '⌘⇧B',
        '⌘⌥C',
        null,
      ]);
    });

    it('greys the task list item out, the way the demo draws it', async () => {
      const editor = open('<p>the quick brown fox</p>');
      mount(editor);
      await selectWithFocus(editor, 1, 10);
      const menu = await hoverOpen('doc-bubble-block-type');

      const taskList = menu.querySelector(
        '[data-testid="doc-bubble-block-type-item-task-list"]',
      ) as HTMLElement;
      expect(taskList.getAttribute('aria-disabled')).toBe('true');
    });

    it('lists the three alignments the demo draws', async () => {
      const editor = open('<p>the quick brown fox</p>');
      mount(editor);
      await selectWithFocus(editor, 1, 10);
      const menu = await hoverOpen('doc-bubble-align');

      expect(
        Array.from(menu.querySelectorAll('[data-testid^="doc-bubble-align-item-"]')).map((n) =>
          n.getAttribute('data-testid'),
        ),
      ).toEqual([
        'doc-bubble-align-item-left',
        'doc-bubble-align-item-center',
        'doc-bubble-align-item-right',
      ]);
    });

    it('lays the colour panel out in two rows of seven, the way the demo draws it', async () => {
      const editor = open('<p>the quick brown fox</p>');
      mount(editor);
      await selectWithFocus(editor, 1, 10);
      const menu = await hoverOpen('doc-bubble-color');

      expect(menu.querySelectorAll('[data-testid^="doc-bubble-color-text-"]')).toHaveLength(7);
      expect(menu.querySelectorAll('[data-testid^="doc-bubble-color-fill-"]')).toHaveLength(7);
    });

    it('lists the nine AI commands the ruling draws', async () => {
      const editor = open('<p>the quick brown fox</p>');
      mount(editor);
      await selectWithFocus(editor, 1, 10);
      const menu = await hoverOpen('doc-bubble-coming-ai');

      expect(
        menu.querySelectorAll('[data-testid^="doc-bubble-ai-item-"]'),
      ).toHaveLength(9);
    });
  });

  describe('命令接没接上', () => {
    // 这三个今天在条上是平铺按钮、点了真的改文档。搬进菜单之后照旧（C1）。
    it.each([
      ['bullet-list', '<bulletlist>'],
      ['ordered-list', '<orderedlist'],
      ['quote', '<blockquote>'],
    ])('running %s from the menu still changes the document', async (id, marker) => {
      const editor = open('<p>hello world</p>');
      mount(editor);
      await selectWithFocus(editor, 1, 6);
      expect(markupOf()).not.toContain(marker);

      const menu = await hoverOpen('doc-bubble-block-type');
      act(() => {
        (menu.querySelector(`[data-testid="doc-bubble-block-type-item-${id}"]`) as HTMLElement).click();
      });

      expect(markupOf()).toContain(marker);
    });

    // 其余每一项点了文档一个字不许变（C2）。
    it.each([
      ['doc-bubble-block-type', 'paragraph'],
      ['doc-bubble-block-type', 'heading-1'],
      ['doc-bubble-block-type', 'code-block'],
      ['doc-bubble-block-type', 'task-list'],
    ])('clicking %s / %s leaves the document alone', async (slot, item) => {
      const editor = open('<p>hello world</p>');
      mount(editor);
      await selectWithFocus(editor, 1, 6);
      const before = markupOf();

      const menu = await hoverOpen(slot);
      act(() => {
        (menu.querySelector(`[data-testid="${slot}-item-${item}"]`) as HTMLElement).click();
      });

      expect(markupOf()).toBe(before);
    });
  });

  describe('出现时机', () => {
    /**
     * tiptap 的 `updateDelay` 默认 250ms，判据是「选区静止 250ms」，拖拽中一
     * 停顿就满足 —— 这正是条会跳的根因。业界解法是鼠标门控：BlockNote
     * `FormattingToolbar.ts:52-103`（`pointerdown` 收起、`pointerup` 显示，
     * `setTimeout` 零命中）· Plate `useFloatingToolbar.ts:111-136`。
     */
    it('stays away while the pointer is down, and comes back when it lifts', async () => {
      const editor = open('<p>the quick brown fox</p>');
      mount(editor);
      await selectWithFocus(editor, 1, 10);

      act(() => {
        fireEvent.pointerDown(editor.view.dom);
      });
      await waitFor(() => {
        expect(screen.queryByTestId('doc-selection-bubble-bar')).toBeNull();
      });

      // 按着不放，选区一路在变 —— 条一次都不许冒出来。
      act(() => {
        editor.commands.setTextSelection({ from: 1, to: 14 });
        editor.commands.setTextSelection({ from: 1, to: 18 });
      });
      expect(screen.queryByTestId('doc-selection-bubble-bar')).toBeNull();

      act(() => {
        fireEvent.pointerUp(editor.view.root as unknown as Element);
      });
      await waitFor(() => {
        expect(screen.queryByTestId('doc-selection-bubble-bar')).not.toBeNull();
      });
    });

    it('shows for a keyboard selection without waiting for any pointer', async () => {
      const editor = open('<p>the quick brown fox</p>');
      mount(editor);
      // 不经过任何 pointer 事件，直接改选区（Shift 加方向键那条路）。
      await selectWithFocus(editor, 1, 10);
      expect(screen.queryByTestId('doc-selection-bubble-bar')).not.toBeNull();
    });
  });
});
