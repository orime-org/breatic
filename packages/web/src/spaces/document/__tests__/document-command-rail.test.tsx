// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * 正文区右侧那一列：作用对象是整篇文档的命令都进这儿。
 *
 * 这次只放两个尚未开放的快照按钮（功能归 #19）。它们的「尚未开放」态照仓里
 * 既有的 `ComingEntry`（`StudioAccountMenu.tsx:99-119`）：变暗、`aria-disabled`、
 * 点了不做事、光标说不可点，且**留在焦点序里** —— 一个要能被发现的控件不能
 * 被 HTML `disabled` 排出去。
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

describe('正文区右侧的命令列', () => {
  const NAME = 'project-p/document-command-rail';
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

  it('两个快照按钮都在，一个不多一个不少', () => {
    // 整列一起断言，不逐个查存在性：将来多加一个或少一个都要在这里红，
    // 而两条各自的正向断言之间正好有条缝能让它溜过去。
    render(<DocumentEditor editor={editor} />);
    const ids = Array.from(
      document.querySelectorAll('[data-testid^="doc-rail-"]'),
    ).map((el) => el.getAttribute('data-testid'));

    expect(ids.sort()).toEqual(['doc-rail-restore-snapshot', 'doc-rail-save-snapshot']);
  });

  it('两个都是尚未开放态：变暗、aria-disabled、光标说不可点', () => {
    render(<DocumentEditor editor={editor} />);
    for (const id of ['doc-rail-save-snapshot', 'doc-rail-restore-snapshot']) {
      const button = screen.getByTestId(id);
      expect(button).toHaveAttribute('aria-disabled', 'true');
      expect(button.className).toContain('opacity-50');
      expect(button.className).toContain('cursor-not-allowed');
    }
  });

  it('不用 HTML disabled —— 它会把按钮排出焦点序，而这个控件要能被发现', () => {
    render(<DocumentEditor editor={editor} />);
    for (const id of ['doc-rail-save-snapshot', 'doc-rail-restore-snapshot']) {
      const button = screen.getByTestId(id);
      expect(button).not.toBeDisabled();
      expect(button.tabIndex).toBe(0);
    }
  });

  it('点下去什么都不发生', () => {
    render(<DocumentEditor editor={editor} />);
    const before = editor.getHTML();
    const button = screen.getByTestId('doc-rail-save-snapshot');

    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    button.dispatchEvent(event);

    // 事件被拦下（`preventDefault`），文档一个字没变。
    expect(event.defaultPrevented).toBe(true);
    expect(editor.getHTML()).toBe(before);
  });

  it('每个按钮都有能被读出来的名字', () => {
    // 它们是纯图标按钮，没有可见文字；缺了 aria-label 就只是两个方块。
    render(<DocumentEditor editor={editor} />);
    for (const id of ['doc-rail-save-snapshot', 'doc-rail-restore-snapshot']) {
      const label = screen.getByTestId(id).getAttribute('aria-label');
      expect(label).toBeTruthy();
      expect(label).not.toBe('');
    }
  });
});
