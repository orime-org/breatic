// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The editor chrome: the scrolling body, the command rail, the bubble bar. The
 * editor comes from the container, so these tests drive a real one through the
 * real user path — no test-only hooks into the component.
 *
 * ## 只读那两条去哪了
 *
 * 这里原来有两条 viewer 测试，钉的是「横条的控件对 viewer 全部禁用」和
 * 「viewer 点横条按钮改不了共享文档」。横条整条去掉之后，它们钉的那个入口
 * 不存在了 —— **保护由 `selection-bubble-bar.test.tsx` 的 A7 接手**：viewer
 * 眼里浮出条整条不出现（`doc-bubble-tool-*` 一个都查不到），所以那条路上
 * 没有任何控件可点。删掉的是测试，不是那条不变量。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import type { Editor } from '@tiptap/react';
import * as Y from 'yjs';

import { Awareness } from 'y-protocols/awareness';

import { BODY_SCROLLER_CLASS } from '@web/spaces/document/document-body-scroller';
import { DocumentEditor } from '@web/spaces/document/DocumentEditor';
import { _resetDocumentEditorCacheForTests } from '@web/spaces/document/document-editor-cache';
import { useDocumentEditor } from '@web/spaces/document/use-document-editor';

describe('DocumentEditor', () => {
  const NAME = 'project-p/document-chrome';
  let doc: Y.Doc;
  let awareness: Awareness;
  let editor: Editor;

  beforeEach(async () => {
    doc = new Y.Doc();
    awareness = new Awareness(doc);
    const { result } = renderHook(() =>
      useDocumentEditor({ doc, name: NAME, caretProvider: { awareness } }),
    );
    await waitFor(() => expect(result.current).not.toBeNull());
    editor = result.current!.editor;
  });

  afterEach(() => {
    _resetDocumentEditorCacheForTests();
    awareness.destroy();
    doc.destroy();
  });

  it('常驻的东西只有两样：右上角那个入口，和正文的滚动容器', () => {
    // 顶部横条整条去掉（user 2026-08-21 拍定，任务 #129）。钉的是「现在有哪
    // 几样」而不是「那几个 testid 没有」—— 后者在横条删掉之后恒真，再也逮不
    // 到任何东西回来；这一条对新加的常驻 chrome 一律会红，不管它叫什么。
    // 浮出条不在其中：它只在有选区时才渲染。
    const { container } = render(<DocumentEditor editor={editor} />);
    const children = [...container.firstElementChild!.children];

    expect(children).toHaveLength(2);
    expect(children[0]).toContainElement(
      screen.getByTestId('doc-doc-menu-trigger'),
    );
    expect(children[1]).toHaveClass(BODY_SCROLLER_CLASS);
  });

  it('渲染正文和右上角那个整篇文档命令的入口', () => {
    render(<DocumentEditor editor={editor} />);
    expect(screen.getByTestId('document-editor-content')).toBeInTheDocument();
    expect(screen.getByTestId('doc-doc-menu-trigger')).toBeInTheDocument();
  });

  it('滚轮落在入口上时，正文照样滚', () => {
    // 入口画在滚动容器外面（它得逃出那个裁切上下文），所以浏览器沿祖先链
    // 找不到可滚的东西 —— 指针停在刚点完的按钮上滚，正文纹丝不动。把滚动
    // 量转交给正文那个 viewport，这块 32×32 就不再是死区。
    render(<DocumentEditor editor={editor} />);
    const viewport = document.querySelector(
      '.doc-body-scroller [data-radix-scroll-area-viewport]',
    ) as HTMLElement;
    const scrollBy = vi.fn();
    viewport.scrollBy = scrollBy;

    const layer = screen.getByTestId('doc-doc-menu-trigger').parentElement!;
    fireEvent.wheel(layer, { deltaY: 120, deltaX: 8 });

    expect(scrollBy).toHaveBeenCalledWith({ top: 120, left: 8 });
  });
});
