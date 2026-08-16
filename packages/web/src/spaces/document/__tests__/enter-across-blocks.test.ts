// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * 选区盖不住整个正文时按回车，不许抛异常（验收项 A10）。
 *
 * 根因和做法在设计文档 2026-08-15-document-selection-design 的 §3.8 和 §5.7。
 * 一句话：`@tiptap/core@3.29.2` 的 `splitBlock` 用**删之前**的文档回答「这里能不能
 * 分块」，然后在**删之后**的文档上真的分——两个列表项的内容被删光之后结构塌了，
 * 那个「能」不再成立，`tr.split` 就抛 `TransformError`。官方
 * `prosemirror-commands` 的 `splitBlockAs` 顺序是反的，删完再重算整条深度链。
 *
 * 上游 issue ueberdosis/tiptap#7734 开着，修复 PR #7990 没合、维护者在质疑它的
 * 做法（它只挪 `canSplit`，我实测过那样产出跟浏览器不一致）。
 *
 * 按键走 `handleKeyDown`，不走 `keyboardShortcut`（设计文档 §3.6）。
 */

import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import * as Y from 'yjs';
import { documentBodyFragment, encodeInitialSpaceContent } from '@breatic/shared';

import { buildDocumentExtensions } from '@web/spaces/document/document-extensions';

const editors: Editor[] = [];

afterEach(() => {
  editors.splice(0).forEach((e) => {
    e.destroy();
  });
});

const TITLE = 'T';

/**
 * 一份带文档标题和给定正文的文档。
 * @param bodyHtml - 正文 HTML。
 * @returns 绑好的编辑器。
 */
function open(bodyHtml: string): Editor {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, encodeInitialSpaceContent('document', TITLE));
  const editor = new Editor({
    extensions: buildDocumentExtensions({ fragment: documentBodyFragment(doc) }),
  });
  editors.push(editor);
  editor.commands.setContent(`<h1 class="doc-title">${TITLE}</h1>${bodyHtml}`);
  return editor;
}

/** 正文那一段的 HTML。 */
function body(e: Editor): string {
  return e.getHTML().replace(`<h1 class="doc-title">${TITLE}</h1>`, '');
}

/** 选中给定的两个位置之间。 */
function selectBetween(e: Editor, from: number, to: number): void {
  e.view.dispatch(
    e.state.tr.setSelection(
      TextSelection.between(e.state.doc.resolve(from), e.state.doc.resolve(to)),
    ),
  );
}

/** 按下一个键，走真实按键路径。 */
function press(e: Editor, key: string): void {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  e.view.someProp('handleKeyDown', (f) => f(e.view, event));
}

/** 选中正文里所有文本节点之间那一段（含两端）。 */
function selectAllText(e: Editor, first: number, last: number): void {
  const positions: Array<{ pos: number; size: number }> = [];
  const start = e.state.doc.child(0).nodeSize;
  e.state.doc.descendants((node, pos) => {
    if (node.isText && pos >= start) positions.push({ pos, size: node.nodeSize });
  });
  const a = positions[first];
  const b = positions[last];
  selectBetween(e, a.pos, b.pos + b.size);
}

describe('跨块选区上按回车（A10）', () => {
  it('拖过两个列表项的全部文字，前后还有段落：不抛，中间留一个空段落', () => {
    const e = open('<p>x</p><ul><li><p>aa</p></li><li><p>bb</p></li></ul><p>y</p>');
    selectAllText(e, 1, 2);
    expect(() => {
      press(e, 'Enter');
    }).not.toThrow();
    expect(body(e)).toBe('<p>x</p><p></p><p>y</p>');
  });

  it('有序列表同样', () => {
    const e = open('<p>x</p><ol><li><p>aa</p></li><li><p>bb</p></li></ol><p>y</p>');
    selectAllText(e, 1, 2);
    expect(() => {
      press(e, 'Enter');
    }).not.toThrow();
    expect(body(e)).toBe('<p>x</p><p></p><p>y</p>');
  });

  it('两个列表项各选一半：不抛，行为跟今天一样', () => {
    const e = open('<ul><li><p>abcd</p></li><li><p>efgh</p></li></ul>');
    const start = e.state.doc.child(0).nodeSize;
    selectBetween(e, start + 5, start + 11);
    expect(() => {
      press(e, 'Enter');
    }).not.toThrow();
    expect(body(e)).toBe(
      '<ul><li><p>ab</p><p>efgh</p></li></ul>',
    );
  });

  it('在一行加粗文字末尾按回车，接着打的字还是粗的', () => {
    const e = open('<p><strong>aa</strong></p>');
    const at = e.state.doc.content.size - 1;
    e.view.dispatch(e.state.tr.setSelection(TextSelection.create(e.state.doc, at)));
    press(e, 'Enter');
    expect(e.state.storedMarks?.map((m) => m.type.name) ?? []).toContain('bold');
  });

  describe('光标回车的行为一个都不许变', () => {
    const cases: Array<[string, string, (e: Editor) => number]> = [
      ['段落中间', '<p>abcd</p>', (e) => e.state.doc.child(0).nodeSize + 3],
      ['段落末尾', '<p>abcd</p>', (e) => e.state.doc.content.size - 1],
      ['段落开头', '<p>abcd</p>', (e) => e.state.doc.child(0).nodeSize + 1],
      ['正文标题中间', '<h2>abcd</h2>', (e) => e.state.doc.child(0).nodeSize + 3],
      ['正文标题末尾', '<h2>abcd</h2>', (e) => e.state.doc.content.size - 1],
      ['列表项中间', '<ul><li><p>abcd</p></li></ul>', (e) => e.state.doc.child(0).nodeSize + 5],
      ['引用块中间', '<blockquote><p>abcd</p></blockquote>', (e) => e.state.doc.child(0).nodeSize + 4],
      ['代码块中间', '<pre><code>abcd</code></pre>', (e) => e.state.doc.child(0).nodeSize + 3],
      ['有序列表 start=5 中间', '<ol start="5"><li><p>abcd</p></li></ol>', (e) => e.state.doc.child(0).nodeSize + 5],
    ];
    const expected: Record<string, string> = {
      段落中间: '<p>ab</p><p>cd</p>',
      段落末尾: '<p>abcd</p><p></p>',
      段落开头: '<p></p><p>abcd</p>',
      正文标题中间: '<h2>ab</h2><h2>cd</h2>',
      正文标题末尾: '<h2>abcd</h2><p></p>',
      列表项中间: '<ul><li><p>ab</p></li><li><p>cd</p></li></ul>',
      引用块中间: '<blockquote><p>ab</p><p>cd</p></blockquote>',
      代码块中间: '<pre><code>ab\ncd</code></pre>',
      '有序列表 start=5 中间': '<ol start="5"><li><p>ab</p></li><li><p>cd</p></li></ol>',
    };
    it.each(cases)('%s', (name, html, at) => {
      const e = open(html);
      e.view.dispatch(e.state.tr.setSelection(TextSelection.create(e.state.doc, at(e))));
      press(e, 'Enter');
      expect(body(e)).toBe(expected[name]);
    });
  });
});
