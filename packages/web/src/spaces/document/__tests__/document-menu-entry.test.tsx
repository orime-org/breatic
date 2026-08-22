// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * 正文区右上角那个入口：作用对象是整篇文档的命令都收在它里面。
 *
 * **常驻在屏幕上的只有一个 `⋯` 按钮**（user 2026-08-22 拍定），点开才出命令。
 * 依据是菜单体系定稿 §2.1 的六产品调研表——整篇文档那一行是「右上角的『…』
 * 菜单」，Notion / Google Docs / Coda / Confluence / Craft 五家全是一个入口。
 * 这次展开后是两个尚未开放的快照命令（功能归 #19）。
 *
 * 「尚未开放」态照仓里既有的 `ComingEntry`（`StudioAccountMenu.tsx:99-119`）
 * 逐项照搬：变暗、`aria-disabled`、点了不做事、光标说不可点、右边一个常驻的
 * note 徽章。**不用 HTML `disabled`** —— 它会把菜单项排出焦点序，而一个要能
 * 被发现的控件得留在里面。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Editor } from '@tiptap/react';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';

import { DocumentEditor } from '@web/spaces/document/DocumentEditor';
import { _resetDocumentEditorCacheForTests } from '@web/spaces/document/document-editor-cache';
import { useDocumentEditor } from '@web/spaces/document/use-document-editor';

const ITEM_IDS = ['doc-doc-menu-restore-snapshot', 'doc-doc-menu-save-snapshot'];

describe('整篇文档命令的入口', () => {
  const NAME = 'project-p/document-menu-entry';
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

  it('常驻在屏幕上的只有那一个入口按钮', () => {
    // 这一处往后要收导出、文档设置、清空文档。收进一个入口之前，命令越多常驻
    // 面积越大；这条钉的就是「加多少命令，常驻的还是一个按钮」。
    render(<DocumentEditor editor={editor} />);
    expect(screen.getByTestId('doc-doc-menu-trigger')).toBeInTheDocument();
    for (const id of ITEM_IDS) {
      expect(screen.queryByTestId(id)).toBeNull();
    }
  });

  it('点开之后是那两项，一个不多一个不少', async () => {
    // 整份一起断言，不逐个查存在性：将来多加一个或少一个都要在这里红，
    // 而两条各自的正向断言之间正好有条缝能让它溜过去。
    const user = userEvent.setup();
    render(<DocumentEditor editor={editor} />);
    await user.click(screen.getByTestId('doc-doc-menu-trigger'));
    await screen.findByTestId('doc-doc-menu-save-snapshot');

    const ids = Array.from(
      document.querySelectorAll('[data-testid^="doc-doc-menu-"]'),
    )
      .map((el) => el.getAttribute('data-testid'))
      .filter((id) => id !== 'doc-doc-menu-trigger');

    expect(ids.sort()).toEqual(ITEM_IDS);
  });

  it('两项都是尚未开放态：变暗、aria-disabled、光标说不可点、带徽章', async () => {
    const user = userEvent.setup();
    render(<DocumentEditor editor={editor} />);
    await user.click(screen.getByTestId('doc-doc-menu-trigger'));

    for (const id of ITEM_IDS) {
      const item = await screen.findByTestId(id);
      expect(item).toHaveAttribute('aria-disabled', 'true');
      expect(item.className).toContain('cursor-not-allowed');
      expect(item.querySelector('.opacity-50')).not.toBeNull();
      // 常驻的 note 徽章 —— `ComingEntry` 用它说明为什么不可用。断言的是徽章
      // 这个元素本身有字，不是某一种语言的字：测试跑在英文 locale 下，写死
      // 中文只会钉住测试环境的语言，钉不住「这里有没有说明」。
      const note = item.querySelector('.text-2xs');
      expect(note).not.toBeNull();
      expect(note?.textContent?.trim()).toBeTruthy();
    }
  });

  it('不用 HTML disabled，它会把菜单项排出焦点序', async () => {
    const user = userEvent.setup();
    render(<DocumentEditor editor={editor} />);
    await user.click(screen.getByTestId('doc-doc-menu-trigger'));

    for (const id of ITEM_IDS) {
      const item = await screen.findByTestId(id);
      expect(item.hasAttribute('disabled')).toBe(false);
      expect(item.getAttribute('data-disabled')).toBeNull();
    }
  });

  it('点菜单项什么都不发生', async () => {
    const user = userEvent.setup();
    render(<DocumentEditor editor={editor} />);
    const before = editor.getHTML();
    await user.click(screen.getByTestId('doc-doc-menu-trigger'));
    const item = await screen.findByTestId('doc-doc-menu-save-snapshot');
    await user.click(item);

    // 菜单没被关掉（`onSelect` 里 preventDefault），文档一个字没变。
    expect(screen.getByTestId('doc-doc-menu-save-snapshot')).toBeInTheDocument();
    expect(editor.getHTML()).toBe(before);
  });

  it('入口按钮有能被读出来的名字', () => {
    // 它是纯图标按钮，没有可见文字；缺了 aria-label 就只是一个方块。
    render(<DocumentEditor editor={editor} />);
    const label = screen
      .getByTestId('doc-doc-menu-trigger')
      .getAttribute('aria-label');
    expect(label).toBeTruthy();
    expect(label).not.toBe('');
  });
});
