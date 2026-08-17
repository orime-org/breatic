// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * 跨块选区上按回车，不许抛异常（#111 时代的验收项 A10，无标题世界照钉）。
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
import { Selection, TextSelection } from '@tiptap/pm/state';
import * as Y from 'yjs';
import { documentBodyFragment, encodeInitialSpaceContent } from '@breatic/shared';

import { buildDocumentExtensions } from '@web/spaces/document/document-extensions';

const editors: Editor[] = [];

afterEach(() => {
  editors.splice(0).forEach((e) => {
    e.destroy();
  });
});

/**
 * 一份给定内容的文档。
 * @param bodyHtml - 文档 HTML。
 * @returns 绑好的编辑器。
 */
function open(bodyHtml: string): Editor {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, encodeInitialSpaceContent('document'));
  const editor = new Editor({
    extensions: buildDocumentExtensions({ fragment: documentBodyFragment(doc) }),
  });
  editors.push(editor);
  editor.commands.setContent(bodyHtml);
  return editor;
}

/** 文档的 HTML。 */
function body(e: Editor): string {
  return e.getHTML();
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

/** 选中文档里第 first 到第 last 个文本节点之间那一段（含两端）。 */
function selectAllText(e: Editor, first: number, last: number): void {
  const positions: Array<{ pos: number; size: number }> = [];
  e.state.doc.descendants((node, pos) => {
    if (node.isText) positions.push({ pos, size: node.nodeSize });
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
    selectBetween(e, 5, 11);
    expect(() => {
      press(e, 'Enter');
    }).not.toThrow();
    expect(body(e)).toBe(
      '<ul><li><p>ab</p><p>efgh</p></li></ul>',
    );
  });

  /**
   * 设计 §3.7 第二张表的第五、六种：改实现之前就正常的两种跨块形状。
   * 换掉分块命令之后「不抛」不再是唯一风险，产出形状也可能变，所以钉产出。
   */
  it('从段落拖到列表项、选区盖住全部文字：不抛，删除生效、分块在零块上是空操作', () => {
    // `block*` 下这类删除把文档删空（旧世界有标题垫着、删完还剩一个空段）。
    // 按 #121 定稿 §10：删除选区照做，零块上的分块是空操作。
    const e = open('<p>aa</p><ul><li><p>bb</p></li></ul>');
    selectAllText(e, 0, 1);
    expect(() => {
      press(e, 'Enter');
    }).not.toThrow();
    expect(e.state.doc.childCount).toBe(0);
  });

  it('从引用块拖到段落、选区盖住全部文字：不抛，删除生效、分块在零块上是空操作', () => {
    const e = open('<blockquote><p>aa</p></blockquote><p>bb</p>');
    selectAllText(e, 0, 1);
    expect(() => {
      press(e, 'Enter');
    }).not.toThrow();
    expect(e.state.doc.childCount).toBe(0);
  });

  it('splitBlock({ keepMarks: false })：不保留格式——公开契约的选项不许被吞', () => {
    const e = open('<p><strong>aa</strong></p>');
    const at = e.state.doc.content.size - 1;
    e.view.dispatch(e.state.tr.setSelection(TextSelection.create(e.state.doc, at)));
    e.commands.splitBlock({ keepMarks: false });
    expect(e.state.storedMarks?.map((m) => m.type.name) ?? []).not.toContain('bold');
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
      ['段落中间', '<p>abcd</p>', () => 3],
      ['段落末尾', '<p>abcd</p>', (e) => e.state.doc.content.size - 1],
      ['段落开头', '<p>abcd</p>', () => 1],
      ['正文标题中间', '<h2>abcd</h2>', () => 3],
      ['正文标题末尾', '<h2>abcd</h2>', (e) => e.state.doc.content.size - 1],
      ['列表项中间', '<ul><li><p>abcd</p></li></ul>', () => 5],
      ['引用块中间', '<blockquote><p>abcd</p></blockquote>', () => 4],
      ['代码块中间', '<pre><code>abcd</code></pre>', () => 3],
      ['列表项末尾', '<ul><li><p>abcd</p></li></ul>', (e) => Selection.atEnd(e.state.doc).from],
      ['引用块末尾', '<blockquote><p>abcd</p></blockquote>', (e) => Selection.atEnd(e.state.doc).from],
      ['代码块末尾', '<pre><code>abcd</code></pre>', (e) => Selection.atEnd(e.state.doc).from],
      ['有序列表 start=5 中间', '<ol start="5"><li><p>abcd</p></li></ol>', () => 5],
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
      列表项末尾: '<ul><li><p>abcd</p></li><li><p></p></li></ul>',
      引用块末尾: '<blockquote><p>abcd</p><p></p></blockquote>',
      代码块末尾: '<pre><code>abcd\n</code></pre>',
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
