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
import { render, screen, act, waitFor } from '@testing-library/react';
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
});
