// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * 链接浮层的四个状态和它们之间的转移（任务 #903，浮出条切片二）。
 *
 * 设计文档 §5.3 那张转移表是这一批用例的来源：一个事实（当前是哪个状态）
 * 有四种取值、有三条路径能改它，所以表先于代码存在，这里逐格兑现。
 *
 * 判据、写入、归一化三层归 `document-link.test.ts`，那一层不碰 React。
 * 这里只问载体：按下去开的是哪个状态、里面有什么、按了之后去哪。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Editor } from '@tiptap/react';
import * as Y from 'yjs';

import { documentBodyFragment, encodeInitialSpaceContent } from '@breatic/shared';
import { buildDocumentExtensions } from '@web/spaces/document/document-extensions';
import { TooltipProvider } from '@web/components/ui/tooltip';
import { DocumentEditor } from '@web/spaces/document/DocumentEditor';

const editors: Editor[] = [];
let doc: Y.Doc;

const HREF = 'https://a.example/docs';

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
 * 装好正文的编辑器，已挂进 document。
 * @param bodyHtml - 正文 HTML。
 * @returns 编辑器。
 */
function mount(bodyHtml: string): Editor {
  const editor = new Editor({
    extensions: buildDocumentExtensions({ fragment: documentBodyFragment(doc) }),
  });
  editors.push(editor);
  editor.commands.setContent(bodyHtml);
  render(
    <TooltipProvider>
      <DocumentEditor editor={editor} readOnly={false} />
    </TooltipProvider>,
  );
  return editor;
}

/**
 * 选中一段文字并让编辑器真的持有焦点，等浮出条出现。
 *
 * 焦点是硬条件：插件的 `shouldShow` 要求 `view.hasFocus()`，而浮出条那个
 * 元素是在 `show()` 里才挂进 DOM 的。
 * @param editor - 编辑器。
 * @param from - 选区起点。
 * @param to - 选区终点。
 */
async function selectWithFocus(editor: Editor, from: number, to: number): Promise<void> {
  act(() => {
    editor.view.dom.focus();
    editor.commands.setTextSelection({ from, to });
  });
  await waitFor(() => {
    expect(screen.getByTestId('doc-bubble-tool-link')).toBeInTheDocument();
  });
}

/**
 * 选中一段文字，然后按下链接按钮。
 * @param editor - 编辑器。
 * @param from - 选区起点。
 * @param to - 选区终点。
 */
async function openPopoverOver(editor: Editor, from: number, to: number): Promise<void> {
  await selectWithFocus(editor, from, to);
  await pressLinkButton();
  await waitFor(() => {
    expect(screen.getByTestId('doc-link-popover')).toBeInTheDocument();
  });
}

/**
 * 按下浮出条上的链接按钮。
 *
 * 走完整的指针序列：插件在捕获相的 mousedown 里把 `preventHide` 立起来
 * （`@tiptap/extension-bubble-menu` dist:78-79），浮层一开正文就失焦，少了那
 * 一下 `blurHandler` 会把整条浮出条从 document 里摘掉。
 */
async function pressLinkButton(): Promise<void> {
  await userEvent.click(screen.getByTestId('doc-bubble-tool-link'));
}

/** 正文 `see<a>our docs</a>for more`：链接占 [4,12)。 */
const ONE_LINK = `<p>see<a href="${HREF}">our docs</a>for more</p>`;

describe('链接按钮', () => {
  it('选区碰到链接时是按下态', async () => {
    const editor = mount(ONE_LINK);
    await selectWithFocus(editor, 2, 14);

    expect(screen.getByTestId('doc-bubble-tool-link')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('选区只是贴着链接边界时不是按下态', async () => {
    const editor = mount(ONE_LINK);
    await selectWithFocus(editor, 12, 20);

    expect(screen.getByTestId('doc-bubble-tool-link')).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });
});

describe('按下去开的是哪个状态', () => {
  it('选区碰到链接时开出查看态', async () => {
    const editor = mount(ONE_LINK);
    await openPopoverOver(editor, 4, 12);

    expect(screen.getByTestId('doc-link-url')).toHaveTextContent(HREF);
    expect(screen.getByTestId('doc-link-edit')).toBeInTheDocument();
    expect(screen.getByTestId('doc-link-remove')).toBeInTheDocument();
    expect(screen.queryByTestId('doc-link-input')).not.toBeInTheDocument();
  });

  it('查看态那个网址自己就是能点开的链接', async () => {
    const editor = mount(ONE_LINK);
    await openPopoverOver(editor, 4, 12);

    const url = screen.getByTestId('doc-link-url');
    expect(url).toHaveAttribute('href', HREF);
    expect(url).toHaveAttribute('target', '_blank');
    expect(url).toHaveAttribute('rel', expect.stringContaining('noopener'));
  });

  it('选区没有链接时开出新建态，输入框空着、确定按不了', async () => {
    const editor = mount('<p>plain text</p>');
    await openPopoverOver(editor, 1, 6);

    expect(screen.getByTestId('doc-link-input')).toHaveValue('');
    expect(screen.getByTestId('doc-link-confirm')).toBeDisabled();
    expect(screen.queryByTestId('doc-link-remove')).not.toBeInTheDocument();
  });
});

describe('新建一条链接', () => {
  it('输入合法网址后确定可按', async () => {
    const editor = mount('<p>plain text</p>');
    await openPopoverOver(editor, 1, 6);

    fireEvent.change(screen.getByTestId('doc-link-input'), {
      target: { value: 'example.com' },
    });

    expect(screen.getByTestId('doc-link-confirm')).not.toBeDisabled();
  });

  it('输入不成形的网址时确定按不了', async () => {
    const editor = mount('<p>plain text</p>');
    await openPopoverOver(editor, 1, 6);

    fireEvent.change(screen.getByTestId('doc-link-input'), {
      target: { value: 'hello world' },
    });

    expect(screen.getByTestId('doc-link-confirm')).toBeDisabled();
  });

  it('按确定把链接写进文档并关掉浮层', async () => {
    const editor = mount('<p>plain text</p>');
    await openPopoverOver(editor, 1, 6);

    fireEvent.change(screen.getByTestId('doc-link-input'), {
      target: { value: 'example.com' },
    });
    fireEvent.click(screen.getByTestId('doc-link-confirm'));

    await waitFor(() => {
      expect(screen.queryByTestId('doc-link-popover')).not.toBeInTheDocument();
    });
    expect(editor.getHTML()).toContain('https://example.com');
  });

  it('提交前文档里没有任何链接', async () => {
    const editor = mount('<p>plain text</p>');
    await openPopoverOver(editor, 1, 6);
    fireEvent.change(screen.getByTestId('doc-link-input'), {
      target: { value: 'example.com' },
    });

    expect(editor.getHTML()).not.toContain('<a');
  });
});

describe('改一条已有的链接', () => {
  it('按编辑进入编辑态，输入框带着原网址', async () => {
    const editor = mount(ONE_LINK);
    await openPopoverOver(editor, 4, 12);

    fireEvent.click(screen.getByTestId('doc-link-edit'));

    await waitFor(() => {
      expect(screen.getByTestId('doc-link-input')).toHaveValue(HREF);
    });
  });

  it('改完按确定换掉网址并关掉浮层', async () => {
    const editor = mount(ONE_LINK);
    await openPopoverOver(editor, 4, 12);
    fireEvent.click(screen.getByTestId('doc-link-edit'));
    await waitFor(() => {
      expect(screen.getByTestId('doc-link-input')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByTestId('doc-link-input'), {
      target: { value: 'https://b.example/other' },
    });
    fireEvent.click(screen.getByTestId('doc-link-confirm'));

    await waitFor(() => {
      expect(screen.queryByTestId('doc-link-popover')).not.toBeInTheDocument();
    });
    expect(editor.getHTML()).toContain('https://b.example/other');
    expect(editor.getHTML()).not.toContain(HREF);
  });
});

describe('去掉一条链接', () => {
  it('按去掉链接解掉它并关掉浮层', async () => {
    const editor = mount(ONE_LINK);
    await openPopoverOver(editor, 4, 12);

    fireEvent.click(screen.getByTestId('doc-link-remove'));

    await waitFor(() => {
      expect(screen.queryByTestId('doc-link-popover')).not.toBeInTheDocument();
    });
    expect(editor.getHTML()).not.toContain('<a');
    expect(editor.getHTML()).toContain('our docs');
  });
});

describe('关掉浮层', () => {
  it('按 Escape 关掉，草稿不留到下一次', async () => {
    const editor = mount('<p>plain text</p>');
    await openPopoverOver(editor, 1, 6);
    fireEvent.change(screen.getByTestId('doc-link-input'), {
      target: { value: 'example.com' },
    });

    fireEvent.keyDown(screen.getByTestId('doc-link-popover'), { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByTestId('doc-link-popover')).not.toBeInTheDocument();
    });

    await pressLinkButton();
    await waitFor(() => {
      expect(screen.getByTestId('doc-link-input')).toBeInTheDocument();
    });
    expect(screen.getByTestId('doc-link-input')).toHaveValue('');
  });

  it('编辑态按 Escape 一步关到底，不退回查看态', async () => {
    const editor = mount(ONE_LINK);
    await openPopoverOver(editor, 4, 12);
    fireEvent.click(screen.getByTestId('doc-link-edit'));
    await waitFor(() => {
      expect(screen.getByTestId('doc-link-input')).toBeInTheDocument();
    });

    fireEvent.keyDown(screen.getByTestId('doc-link-popover'), { key: 'Escape' });

    await waitFor(() => {
      expect(screen.queryByTestId('doc-link-popover')).not.toBeInTheDocument();
    });
  });
});

describe('浮层的锚点', () => {
  it('住在编辑器里，不在浮出条里', async () => {
    const editor = mount(ONE_LINK);
    await openPopoverOver(editor, 4, 12);

    const anchor = screen.getByTestId('doc-link-anchor');
    const bar = screen.getByTestId('doc-bubble-tool-link').closest('[data-testid^="doc-bubble"]')
      ?.parentElement;

    expect(editor.view.dom.parentElement?.contains(anchor)).toBe(true);
    expect(bar?.contains(anchor)).toBe(false);
  });
});
