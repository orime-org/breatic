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

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderHook, screen, waitFor } from '@testing-library/react';
import { renderWithChrome as render } from '@web/test-utils/render-with-chrome';
import type { Editor } from '@tiptap/react';
import * as Y from 'yjs';

import { Awareness } from 'y-protocols/awareness';

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

  it('顶部横条不存在：一个 doc-toolbar-tool-* 都渲染不出来', () => {
    // 横条整条去掉（user 2026-08-21 拍定，任务 #129）。用前缀查而不是逐个点名，
    // 是因为要断言的是「一个都没有」，点名只能证明点到的那几个没有。
    render(<DocumentEditor editor={editor} />);
    expect(
      document.querySelectorAll('[data-testid^="doc-toolbar-tool-"]'),
    ).toHaveLength(0);
  });

  it('渲染正文和右侧那一列命令', () => {
    render(<DocumentEditor editor={editor} />);
    expect(screen.getByTestId('document-editor-content')).toBeInTheDocument();
    expect(screen.getByTestId('doc-command-rail')).toBeInTheDocument();
  });
});
