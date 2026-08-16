// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * 用户说「这片不要了」的时候，给他一片干净的空白（验收项 A4）。
 *
 * 规则和判据在设计文档 2026-08-15-document-selection-design 的 §5.6。一句话：
 * 选区盖住整个正文、用户又做了一件「把这片拿掉」的事（删除、剪切、打字符、
 * 输入法开始组字），正文就收敛成一个段落，装着还剩下的内联内容；按回车则收敛成
 * 两个空段落。别的操作一律不碰——加粗、粘贴、拖放、转块类型、取消块类型、
 * 纯选区变化、别人的远程编辑。
 *
 * **这份测试分两半，两半的红绿含义不同**：
 *
 * - 「该接管」那几组在规则实现之前**必须红**，它们钉的是这次要新增的行为。
 * - 「不该接管」那几组在规则实现之前**就是绿的**，它们钉的是「这条规则不许碰
 *   别的操作」。设计对抗五轮里，误接管出现过三次（加粗、粘贴、取消引用），
 *   每次都是判据太宽，所以这半边必须跟另一半同时存在——只有它红了才说明
 *   判据又宽了。
 *
 * 按键一律走 `handleKeyDown`，不走 `editor.commands.keyboardShortcut()`：后者
 * 把捕获的 transaction 拆成 step 逐个重映射再 `maybeStep`，做不了的 step 被静默
 * 丢掉，测出来的不是产品行为（设计文档 §3.6）。
 */

import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import * as Y from 'yjs';
import { documentBodyFragment, encodeInitialSpaceContent } from '@breatic/shared';

import { buildDocumentExtensions } from '@web/spaces/document/document-extensions';

const editors: Editor[] = [];

afterEach(() => {
  editors.splice(0).forEach((e) => {
    e.destroy();
  });
});

const TITLE = 'TITLE';

/**
 * 一份带文档标题和给定正文的文档。
 * @param bodyHtml - 文档标题之后的正文 HTML；空串就是正文零块。
 * @returns 绑好的编辑器。
 */
function open(bodyHtml: string): Editor {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, encodeInitialSpaceContent('document', TITLE));
  const editor = new Editor({
    extensions: buildDocumentExtensions({ fragment: documentBodyFragment(doc) }),
  });
  editors.push(editor);
  if (bodyHtml) {
    editor.commands.setContent(`<h1 class="doc-title">${TITLE}</h1>${bodyHtml}`);
  }
  return editor;
}

/** 正文那一段的 HTML，文档标题剥掉。 */
function body(e: Editor): string {
  return e.getHTML().replace(`<h1 class="doc-title">${TITLE}</h1>`, '');
}

/** 全选正文，跟按 Ctrl+A 得到的选区一样。 */
function selectWholeBody(e: Editor): void {
  const start = e.state.doc.child(0).nodeSize;
  const end = e.state.doc.content.size;
  e.view.dispatch(
    e.state.tr.setSelection(
      TextSelection.between(e.state.doc.resolve(start), e.state.doc.resolve(end)),
    ),
  );
}

/** 真实按键路径：让 keymap 插件自己处理并提交。 */
function press(e: Editor, key: string, mods: Partial<KeyboardEventInit> = {}): void {
  const event = new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
    ...mods,
  });
  e.view.someProp('handleKeyDown', (f) => f(e.view, event));
}

/** 光标此刻停在哪种块里。 */
function caretParent(e: Editor): string {
  return e.state.selection.$from.parent.type.name;
}

/** 十种正文结构，覆盖 §3.7 那张表。 */
const SHAPES: Array<[string, string]> = [
  ['两个段落', '<p>aa</p><p>bb</p>'],
  ['一个段落', '<p>aa</p>'],
  ['段落加列表', '<p>aa</p><ul><li><p>bb</p></li></ul>'],
  ['段落加引用块', '<p>aa</p><blockquote><p>bb</p></blockquote>'],
  ['两项无序列表', '<ul><li><p>aa</p></li><li><p>bb</p></li></ul>'],
  ['两项有序列表', '<ol><li><p>aa</p></li><li><p>bb</p></li></ol>'],
  ['一个引用块', '<blockquote><p>aa</p></blockquote>'],
  ['列表加段落', '<ul><li><p>aa</p></li></ul><p>bb</p>'],
  ['一个代码块', '<pre><code>aa</code></pre>'],
  ['两个引用块', '<blockquote><p>aa</p></blockquote><blockquote><p>bb</p></blockquote>'],
];

describe('说「这片不要了」的时候（A4）', () => {
  describe('按删除键，十种正文结构都收敛成一个空段落', () => {
    it.each(SHAPES)('%s', (_name, html) => {
      const e = open(html);
      selectWholeBody(e);
      press(e, 'Delete');
      expect(body(e)).toBe('<p></p>');
      expect(e.state.doc.child(0).textContent).toBe(TITLE);
      expect(caretParent(e)).toBe('paragraph');
    });
  });

  describe('按退格键，结果跟删除键一样', () => {
    it.each(SHAPES)('%s', (_name, html) => {
      const e = open(html);
      selectWholeBody(e);
      press(e, 'Backspace');
      expect(body(e)).toBe('<p></p>');
      expect(caretParent(e)).toBe('paragraph');
    });
  });

  it('带修饰键的删除也算——tiptap 把 11 个绑定路由到同一条链', () => {
    for (const mods of [{ shiftKey: true }, { ctrlKey: true }]) {
      const e = open('<ul><li><p>aa</p></li><li><p>bb</p></li></ul>');
      selectWholeBody(e);
      press(e, 'Backspace', mods);
      expect(body(e)).toBe('<p></p>');
    }
  });

  describe('剪切，十种正文结构都收敛成一个空段落', () => {
    it.each(SHAPES)('%s', (_name, html) => {
      const e = open(html);
      selectWholeBody(e);
      // prosemirror-view 的 cut handler 直接 dispatch 这一条，不经过任何 keymap
      e.view.dispatch(
        e.state.tr.deleteSelection().scrollIntoView().setMeta('uiEvent', 'cut'),
      );
      expect(body(e)).toBe('<p></p>');
      expect(caretParent(e)).toBe('paragraph');
    });
  });

  describe('打一个字符，十种正文结构都收敛成一个装着它的段落', () => {
    it.each(SHAPES)('%s', (_name, html) => {
      const e = open(html);
      selectWholeBody(e);
      e.view.dispatch(e.state.tr.insertText('x'));
      expect(body(e)).toBe('<p>x</p>');
      expect(caretParent(e)).toBe('paragraph');
    });
  });

  it('打字符时它继承的格式要留着', () => {
    const e = open('<blockquote><p><strong>aa</strong></p></blockquote>');
    selectWholeBody(e);
    e.view.dispatch(e.state.tr.insertText('x'));
    expect(body(e)).toBe('<p><strong>x</strong></p>');
  });

  describe('按回车，十种正文结构都收敛成两个空段落', () => {
    it.each(SHAPES)('%s', (_name, html) => {
      const e = open(html);
      selectWholeBody(e);
      press(e, 'Enter');
      expect(body(e)).toBe('<p></p><p></p>');
      expect(e.state.doc.child(0).textContent).toBe(TITLE);
      // 光标落在第二个空段落里
      expect(caretParent(e)).toBe('paragraph');
      expect(e.state.selection.from).toBe(e.state.doc.content.size - 1);
    });
  });

  it('Cmd+click 选中正文里唯一那个块，按删除也算——屏幕上跟 Ctrl+A 一样', () => {
    const e = open('<ul><li><p>aa</p></li><li><p>bb</p></li></ul>');
    const at = e.state.doc.child(0).nodeSize;
    e.view.dispatch(e.state.tr.setSelection(NodeSelection.create(e.state.doc, at)));
    press(e, 'Delete');
    expect(body(e)).toBe('<p></p>');
    expect(caretParent(e)).toBe('paragraph');
  });
});

describe('这条规则不许碰的操作', () => {
  it('全选之后加粗：每个块各自带上格式，块结构一个不少（A7）', () => {
    const e = open('<h2>Head</h2><ul><li><p>one</p></li></ul><p>tail</p>');
    selectWholeBody(e);
    e.commands.toggleBold();
    expect(body(e)).toBe(
      '<h2><strong>Head</strong></h2><ul><li><p><strong>one</strong></p></li></ul><p><strong>tail</strong></p>',
    );
  });

  it('全选之后粘贴带标题和列表的内容：结构原样进来', () => {
    const e = open('<p>aa</p><p>bb</p>');
    selectWholeBody(e);
    e.commands.insertContent('<h2>H</h2><ul><li><p>one</p></li></ul>');
    expect(body(e)).toBe('<h2>H</h2><ul><li><p>one</p></li></ul>');
  });

  it('全选之后粘贴多行纯文本：分成多段，不挤成一段', () => {
    const e = open('<p>aa</p><p>bb</p>');
    selectWholeBody(e);
    // 走编辑器自己的剪贴板管线，不是 insertContent——后者把换行当普通文字
    e.view.pasteText('ab\ncd');
    expect(body(e)).toBe('<p>ab</p><p>cd</p>');
  });

  it('全选之后转成列表：内容原样在，只换块类型', () => {
    const e = open('<p>aa</p><p>bb</p>');
    selectWholeBody(e);
    e.commands.toggleBulletList();
    expect(body(e)).toBe('<ul><li><p>aa</p></li><li><p>bb</p></li></ul>');
  });

  it('全选之后取消引用（引用块里有字）：两段不许被合并成一段', () => {
    const e = open('<blockquote><p>aa</p><p>bb</p></blockquote>');
    selectWholeBody(e);
    e.chain().toggleBlockquote().run();
    expect(body(e)).toBe('<p>aa</p><p>bb</p>');
  });

  it('全选之后取消引用（引用块里全是空段落）：两段照样不许被合并', () => {
    const e = open('<blockquote><p></p><p></p></blockquote>');
    selectWholeBody(e);
    e.chain().toggleBlockquote().run();
    expect(body(e)).toBe('<p></p><p></p>');
  });

  it('全选之后清除格式：内容原样在', () => {
    const e = open('<p><strong>aa</strong></p><p>bb</p>');
    selectWholeBody(e);
    e.commands.unsetAllMarks();
    expect(body(e)).toBe('<p>aa</p><p>bb</p>');
  });

  it('全选之后往别处拖一段东西进来：选中的这片没被动', () => {
    const e = open('<h2>Head</h2><p>tail</p>');
    selectWholeBody(e);
    e.view.dispatch(e.state.tr.insertText('D', e.state.doc.content.size - 1));
    expect(body(e)).toBe('<h2>Head</h2><p>tailD</p>');
  });

  it('全选之后再按一次 Ctrl+A：正文一个字不变（A3 的连按两次结果不变）', () => {
    const e = open('<blockquote><p>aa</p><p>bb</p></blockquote>');
    selectWholeBody(e);
    press(e, 'a', { ctrlKey: true });
    expect(body(e)).toBe('<blockquote><p>aa</p><p>bb</p></blockquote>');
  });

  it('全选之后点一下别处：正文一个字不变', () => {
    const e = open('<blockquote><p>aa</p><p>bb</p></blockquote>');
    selectWholeBody(e);
    const at = e.state.doc.child(0).nodeSize + 2;
    e.view.dispatch(e.state.tr.setSelection(TextSelection.create(e.state.doc, at)));
    expect(body(e)).toBe('<blockquote><p>aa</p><p>bb</p></blockquote>');
  });

  it('全选着不动，另一个协作者改了文档：本地正文结构一个字不变', () => {
    const docA = new Y.Doc();
    Y.applyUpdate(docA, encodeInitialSpaceContent('document', TITLE));
    const a = new Editor({
      extensions: buildDocumentExtensions({ fragment: documentBodyFragment(docA) }),
    });
    editors.push(a);
    a.commands.setContent(
      `<h1 class="doc-title">${TITLE}</h1><h2>Head</h2><ul><li><p>one</p></li></ul><p>tail</p>`,
    );
    const docB = new Y.Doc();
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
    const b = new Editor({
      extensions: buildDocumentExtensions({ fragment: documentBodyFragment(docB) }),
    });
    editors.push(b);

    selectWholeBody(a);
    b.commands.focus('end');
    b.commands.insertContent('Z');
    Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB, Y.encodeStateVector(docA)));

    expect(body(a)).toBe('<h2>Head</h2><ul><li><p>one</p></li></ul><p>tailZ</p>');
  });

  describe('选区盖不住整个正文的时候，一律不碰', () => {
    it('光标在段落中间打字', () => {
      const e = open('<p>abcd</p>');
      const at = e.state.doc.child(0).nodeSize + 2;
      e.view.dispatch(e.state.tr.setSelection(TextSelection.create(e.state.doc, at)));
      e.view.dispatch(e.state.tr.insertText('x'));
      expect(body(e)).toBe('<p>axbcd</p>');
    });

    it('只选中一个段落里的两个字删掉', () => {
      const e = open('<p>abcd</p><p>efgh</p>');
      const at = e.state.doc.child(0).nodeSize + 1;
      e.view.dispatch(
        e.state.tr.setSelection(
          TextSelection.between(e.state.doc.resolve(at), e.state.doc.resolve(at + 2)),
        ),
      );
      press(e, 'Delete');
      expect(body(e)).toBe('<p>cd</p><p>efgh</p>');
    });

    it('正文只有一个空的正文标题，打第一个字：它还是正文标题', () => {
      const e = open('<h2></h2>');
      e.commands.focus('end');
      e.view.dispatch(e.state.tr.insertText('x'));
      expect(body(e)).toBe('<h2>x</h2>');
    });

    it('正文只有一个空代码块，按回车：代码块里加一个换行', () => {
      const e = open('<pre><code></code></pre>');
      e.commands.focus('end');
      press(e, 'Enter');
      expect(body(e)).toBe('<pre><code>\n</code></pre>');
    });

    it('A11：Ctrl+A 选中文档标题之后按回车，正文顶部多一个空段落', () => {
      const e = open('<p>hello</p><p>world</p>');
      e.view.dispatch(e.state.tr.setSelection(TextSelection.create(e.state.doc, 1)));
      press(e, 'a', { ctrlKey: true });
      const blocksBefore = e.state.doc.childCount - 1;
      press(e, 'Enter');
      expect(e.state.doc.child(0).textContent).toBe('');
      expect(e.state.doc.childCount - 1).toBe(blocksBefore + 1);
      expect(caretParent(e)).toBe('paragraph');
    });
  });
});

describe('Ctrl+A 判「在哪一侧」看的是位置，不是父节点类型（A9）', () => {
  it('Cmd+click 选中文档标题之后按 Ctrl+A，选中的是文档标题', () => {
    const e = open('<p>aa</p><p>bb</p>');
    e.view.dispatch(e.state.tr.setSelection(NodeSelection.create(e.state.doc, 0)));
    press(e, 'a', { ctrlKey: true });
    const titleSize = e.state.doc.child(0).nodeSize;
    expect(e.state.selection.from).toBeGreaterThanOrEqual(1);
    expect(e.state.selection.to).toBeLessThanOrEqual(titleSize - 1);
  });

  it('Cmd+click 选中正文某个段落之后按 Ctrl+A，选中的是整个正文', () => {
    const e = open('<p>aa</p><p>bb</p>');
    const at = e.state.doc.child(0).nodeSize;
    e.view.dispatch(e.state.tr.setSelection(NodeSelection.create(e.state.doc, at)));
    press(e, 'a', { ctrlKey: true });
    expect(e.state.selection.from).toBeGreaterThanOrEqual(at);
    expect(e.state.selection.to).toBe(e.state.doc.content.size - 1);
  });
});
