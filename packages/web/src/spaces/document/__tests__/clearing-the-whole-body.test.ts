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
 * **A4 的用例分两半，两半的红绿含义不同**（文件里另住着 A9 和 A11 的
 * 防回归组，它们不属于这两半）：
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

  /**
   * tiptap 在 pc 平台绑了五个删除组合（`dist:5352`）：裸 Backspace、
   * Mod-Backspace、Shift-Backspace、裸 Delete、Mod-Delete。jsdom 按 pc 判定，
   * 这里钉带修饰键的那三个（裸的两个各有十种结构的组）。mac 的另外几个绑定
   * 走同一条链，jsdom 驱动不到；没绑定的组合（Alt+Backspace 等）在真浏览器
   * 走原生编辑加 DOM 差分，产生的同样是 transaction，被同一条规则接住。
   */
  it.each([
    ['Ctrl+Backspace', 'Backspace', { ctrlKey: true }],
    ['Shift+Backspace', 'Backspace', { shiftKey: true }],
    ['Ctrl+Delete', 'Delete', { ctrlKey: true }],
  ] as Array<[string, string, Partial<KeyboardEventInit>]>)(
    '带修饰键的删除也算：%s',
    (_name, key, mod) => {
      const e = open('<ul><li><p>aa</p></li><li><p>bb</p></li></ul>');
      selectWholeBody(e);
      press(e, key, mod);
      expect(body(e)).toBe('<p></p>');
    },
  );

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

  it('Cmd+click 选中正文里唯一那个块，按回车也算——coversWholeBody 的三个消费方（appendTransaction、回车绑定、compositionstart）各自调它，这条钉回车那条', () => {
    const e = open('<ul><li><p>aa</p></li><li><p>bb</p></li></ul>');
    const at = e.state.doc.child(0).nodeSize;
    e.view.dispatch(e.state.tr.setSelection(NodeSelection.create(e.state.doc, at)));
    press(e, 'Enter');
    expect(body(e)).toBe('<p></p><p></p>');
    expect(caretParent(e)).toBe('paragraph');
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

  /**
   * 粘贴单个块是 `putsBackOnlyInline` 唯一「非它不可」的场景。
   *
   * 双块粘贴也是它先拒的（执行顺序上 tookTheSelectionAway 在 nothingOldLeft
   * 之前），但把它删掉之后双块用例照样绿——「正文块数不超过一个」那条会接住，
   * 所以双块用例钉不住它；单块粘贴没有第二道防线，删掉它这几条当场红。
   */
  it.each([
    ['一个正文标题', '<h2>H</h2>'],
    ['一个引用块', '<blockquote><p>Q</p></blockquote>'],
    ['一个列表', '<ul><li><p>L</p></li></ul>'],
    ['一个代码块', '<pre><code>C</code></pre>'],
  ])('全选之后粘贴%s：原样进来，不许被压成普通段落', (_name, html) => {
    const e = open('<p>aa</p><p>bb</p>');
    selectWholeBody(e);
    e.commands.insertContent(html);
    expect(body(e)).toBe(html);
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

  /**
   * 引用里装的不是普通段落时，`nothingOldLeft` 的第一条是唯一守着的那道。
   *
   * 取消引用产生的 `ReplaceAroundStep` 的 slice 是空的（留下的内容住在它的 gap
   * 里），所以按 step 形状判的那道看不见它，只能在结果上判：留下来的文字跟这次
   * 放回去的文字不一样，就说明原来的东西还在，不是清空。
   */
  it.each([
    ['正文标题', '<blockquote><h2>H</h2></blockquote>', '<h2>H</h2>'],
    ['代码块', '<blockquote><pre><code>C</code></pre></blockquote>', '<pre><code>C</code></pre>'],
  ])('全选之后取消引用，引用里装的是%s：原样留下，不许被降级', (_name, html, expected) => {
    const e = open(html);
    selectWholeBody(e);
    e.chain().toggleBlockquote().run();
    expect(body(e)).toBe(expected);
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
      // 判据③要钉满：光标在正文顶部那个新的空段落里——不是「随便哪个段落」。
      // 一个把光标留在 <p>hello</p> 里的回归，前两条断言照样绿。
      expect(caretParent(e)).toBe('paragraph');
      expect(e.state.selection.$from.parent.textContent).toBe('');
      expect(e.state.selection.from).toBe(e.state.doc.child(0).nodeSize + 1);
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

describe('输入法组字：组字期间不插手，组字结束了才收尾（A4）', () => {
  /** 让编辑器进入组字状态，跟浏览器按下第一个组字键时一样。 */
  function startComposing(e: Editor): void {
    (e.view as unknown as { input: { composing: boolean } }).input.composing = true;
    e.view.dom.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
  }

  /** 结束组字，跟浏览器上屏时一样。 */
  function endComposing(e: Editor): void {
    (e.view as unknown as { input: { composing: boolean } }).input.composing = false;
    e.view.dom.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
  }

  it('组字进行到一半时，正文保持编辑器自己的形状，不被收敛', () => {
    const e = open('<blockquote><p>abc</p></blockquote>');
    selectWholeBody(e);
    startComposing(e);
    e.view.dispatch(e.state.tr.insertText('h'));
    expect(body(e)).toBe('<blockquote><p>h</p></blockquote>');
  });

  it('组字结束之后，正文收敛成一个段落装着打出来的字', async () => {
    const e = open('<blockquote><p>abc</p></blockquote>');
    selectWholeBody(e);
    startComposing(e);
    e.view.dispatch(e.state.tr.insertText('好'));
    // 这一句是这条测试的一半：组字还没结束，引用块的外壳必须还在
    expect(body(e)).toBe('<blockquote><p>好</p></blockquote>');
    endComposing(e);
    await Promise.resolve();
    await Promise.resolve();
    expect(body(e)).toBe('<p>好</p>');
    expect(caretParent(e)).toBe('paragraph');
  });

  it('十种正文结构，组字结束之后都收敛成一个段落装着那个字', async () => {
    for (const [, html] of SHAPES) {
      const e = open(html);
      selectWholeBody(e);
      startComposing(e);
      e.view.dispatch(e.state.tr.insertText('好'));
      endComposing(e);
      await Promise.resolve();
      await Promise.resolve();
      expect(body(e)).toBe('<p>好</p>');
    }
  });

  /**
   * 组字期间那一刻只能拿带块容器的结构来钉。
   *
   * 「两个段落」这类结构，编辑器自己就会把跨块的选区替换成一个段落——组字期间和
   * 收尾之后长得一样，断言写在它身上分辨不出我们有没有插手。带外壳的三种它会把
   * 外壳留着，外壳还在就证明我们没动手。
   */
  it.each([
    ['一个引用块', '<blockquote><p>abc</p></blockquote>', '<blockquote><p>好</p></blockquote>'],
    ['两项无序列表', '<ul><li><p>aa</p></li><li><p>bb</p></li></ul>', '<ul><li><p>好</p></li></ul>'],
    ['一个代码块', '<pre><code>abc</code></pre>', '<pre><code>好</code></pre>'],
  ])('组字期间 %s 的外壳还在', (_name, html, midway) => {
    const e = open(html);
    selectWholeBody(e);
    startComposing(e);
    e.view.dispatch(e.state.tr.insertText('好'));
    expect(body(e)).toBe(midway);
  });

  /**
   * 组字窗口里远程协作者动了正文：收尾作废，别人的块一个都不许压平。
   *
   * 「用户说这片不要了」说的是他组字时看到的那片；窗口里 Bob 加进来的块不在
   * 那片里。两个窗口都要钉，走的是同一条路：appendTransaction 在
   * 「组字期间或收尾还挂着期间」观察每一批 transaction，见到带 y-sync meta
   * 且 changesBody 为真的就掐掉标志和 token——组字期间到达的和
   * compositionend 之后、微任务收尾之前到达的，都被它接住。
   */
  it('组字期间远程协作者加了一个块：收尾放弃，那个块原样活着', async () => {
    const docA = new Y.Doc();
    Y.applyUpdate(docA, encodeInitialSpaceContent('document', TITLE));
    const a = new Editor({
      extensions: buildDocumentExtensions({ fragment: documentBodyFragment(docA) }),
    });
    editors.push(a);
    a.commands.setContent(`<h1 class="doc-title">${TITLE}</h1><p>aa</p><p>bb</p>`);
    const docB = new Y.Doc();
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
    const b = new Editor({
      extensions: buildDocumentExtensions({ fragment: documentBodyFragment(docB) }),
    });
    editors.push(b);

    selectWholeBody(a);
    startComposing(a);
    a.view.dispatch(a.state.tr.insertText('好'));

    b.commands.focus('end');
    b.commands.insertContent('<h2>from-bob</h2>');
    Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB, Y.encodeStateVector(docA)));

    endComposing(a);
    await Promise.resolve();
    await Promise.resolve();
    expect(body(a)).toContain('<h2>from-bob</h2>');
  });

  it('组字刚结束、收尾还没跑，远程块插进来：收尾放弃，那个块原样活着', async () => {
    const docA = new Y.Doc();
    Y.applyUpdate(docA, encodeInitialSpaceContent('document', TITLE));
    const a = new Editor({
      extensions: buildDocumentExtensions({ fragment: documentBodyFragment(docA) }),
    });
    editors.push(a);
    a.commands.setContent(`<h1 class="doc-title">${TITLE}</h1><p>aa</p><p>bb</p>`);
    const docB = new Y.Doc();
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
    const b = new Editor({
      extensions: buildDocumentExtensions({ fragment: documentBodyFragment(docB) }),
    });
    editors.push(b);

    selectWholeBody(a);
    startComposing(a);
    a.view.dispatch(a.state.tr.insertText('好'));
    endComposing(a);
    // 收尾排在微任务里还没跑，这时远程更新到了
    b.commands.focus('end');
    b.commands.insertContent('<h2>late-bob</h2>');
    Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB, Y.encodeStateVector(docA)));
    await Promise.resolve();
    await Promise.resolve();
    expect(body(a)).toContain('<h2>late-bob</h2>');
  });

  /**
   * 收尾的取消判据必须精确：让路给该让的，只拦该拦的。
   *
   * 该让的：`prosemirror-view` 自己在 `compositionend` 时会排一个微任务冲刷
   * 还没进文档的上屏改动（`dist:3421`）。收尾要等它跑完、把它的结果一起收进去，
   * 不能拿「文档变了」当放弃的理由——那样丢的是用户刚上屏的字。
   *
   * 该拦的：远程协作者**动了正文**。只动文档标题的远程编辑跟「这片正文不要了」
   * 无关，不构成放弃收尾的理由。
   */
  it('组字结束后编辑器自己补冲刷上屏改动：收尾等它，最终收敛的是上屏的字', async () => {
    const e = open('<blockquote><p>abc</p></blockquote>');
    selectWholeBody(e);
    startComposing(e);
    e.view.dispatch(e.state.tr.insertText('hao'));
    // 记录 dispatch 次序：收尾（带 CLEARED_BY_US）必须排在冲刷之后。
    // jsdom 里模拟不出「收尾先跑会让真实冲刷的 mutation records 失效丢字」，
    // 但次序本身可观测——prosemirror-view 的冲刷微任务比我们的收尾后入队
    // （`dist:3421`），只有两跳才能让它先落地。
    const order: string[] = [];
    e.on('transaction', ({ transaction }) => {
      if (transaction.getMeta('documentSelection:cleared') === true) order.push('cleanup');
      else if (transaction.docChanged) order.push('edit');
    });
    endComposing(e);
    // 冲刷跟真实一样走微任务，在我们第一跳之后入队
    void Promise.resolve().then(() => {
      let at = -1;
      let size = 0;
      const start = e.state.doc.child(0).nodeSize;
      e.state.doc.descendants((node, pos) => {
        if (node.isText && pos >= start) {
          at = pos;
          size = node.nodeSize;
        }
      });
      e.view.dispatch(e.state.tr.insertText('好', at, at + size));
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(body(e)).toBe('<p>好</p>');
    expect(order).toEqual(['edit', 'cleanup']);
  });

  it('组字期间远程协作者只改了文档标题：收尾照常，正文收敛、标题保留远程改动', async () => {
    const docA = new Y.Doc();
    Y.applyUpdate(docA, encodeInitialSpaceContent('document', TITLE));
    const a = new Editor({
      extensions: buildDocumentExtensions({ fragment: documentBodyFragment(docA) }),
    });
    editors.push(a);
    a.commands.setContent(`<h1 class="doc-title">${TITLE}</h1><blockquote><p>abc</p></blockquote>`);
    const docB = new Y.Doc();
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
    const b = new Editor({
      extensions: buildDocumentExtensions({ fragment: documentBodyFragment(docB) }),
    });
    editors.push(b);

    selectWholeBody(a);
    startComposing(a);
    a.view.dispatch(a.state.tr.insertText('好'));
    // B 只改文档标题
    b.view.dispatch(b.state.tr.insertText('Z', 1));
    Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB, Y.encodeStateVector(docA)));
    endComposing(a);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    // 不用 body()：它按原标题字符串剥前缀，标题被远程改过就剥不掉了
    expect(a.state.doc.childCount).toBe(2);
    expect(a.state.doc.child(1).type.name).toBe('paragraph');
    expect(a.state.doc.child(1).textContent).toBe('好');
    expect(a.state.doc.child(0).textContent).toContain('Z');
  });

  it('组字刚结束远程只改了标题：收尾照常，正文收敛', async () => {
    const docA = new Y.Doc();
    Y.applyUpdate(docA, encodeInitialSpaceContent('document', TITLE));
    const a = new Editor({
      extensions: buildDocumentExtensions({ fragment: documentBodyFragment(docA) }),
    });
    editors.push(a);
    a.commands.setContent(`<h1 class="doc-title">${TITLE}</h1><blockquote><p>abc</p></blockquote>`);
    const docB = new Y.Doc();
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
    const b = new Editor({
      extensions: buildDocumentExtensions({ fragment: documentBodyFragment(docB) }),
    });
    editors.push(b);

    selectWholeBody(a);
    startComposing(a);
    a.view.dispatch(a.state.tr.insertText('好'));
    endComposing(a);
    b.view.dispatch(b.state.tr.insertText('Z', 1));
    Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB, Y.encodeStateVector(docA)));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(a.state.doc.childCount).toBe(2);
    expect(a.state.doc.child(1).type.name).toBe('paragraph');
    expect(a.state.doc.child(1).textContent).toBe('好');
    expect(a.state.doc.child(0).textContent).toContain('Z');
  });

  it('两次组字紧挨着：旧收尾被新的顶掉，只收敛一次、按第二次的结果', async () => {
    const e = open('<blockquote><p>abc</p></blockquote>');
    let cleanups = 0;
    e.on('transaction', ({ transaction }) => {
      if (transaction.getMeta('documentSelection:cleared') === true) cleanups += 1;
    });
    selectWholeBody(e);
    startComposing(e);
    e.view.dispatch(e.state.tr.insertText('一'));
    endComposing(e);
    // 第一次的收尾还排在微任务里，第二次组字立刻开始
    selectWholeBody(e);
    startComposing(e);
    e.view.dispatch(e.state.tr.insertText('二'));
    endComposing(e);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(body(e)).toBe('<p>二</p>');
    expect(cleanups).toBe(1);
  });

  it('选区没盖住整个正文时组字，结束之后一个字都不许动', async () => {
    const e = open('<p>aa</p><p>bb</p>');
    const start = e.state.doc.child(0).nodeSize;
    e.view.dispatch(
      e.state.tr.setSelection(
        TextSelection.between(e.state.doc.resolve(start + 1), e.state.doc.resolve(start + 2)),
      ),
    );
    startComposing(e);
    e.view.dispatch(e.state.tr.insertText('好'));
    endComposing(e);
    await Promise.resolve();
    await Promise.resolve();
    expect(body(e)).toBe('<p>好a</p><p>bb</p>');
  });

  it('组字期间选区没盖住整个正文，就算结束时盖住了也不收尾', async () => {
    const e = open('<p>aa</p>');
    const start = e.state.doc.child(0).nodeSize;
    e.view.dispatch(
      e.state.tr.setSelection(TextSelection.create(e.state.doc, start + 1)),
    );
    startComposing(e);
    e.view.dispatch(e.state.tr.insertText('好'));
    endComposing(e);
    await Promise.resolve();
    await Promise.resolve();
    expect(body(e)).toBe('<p>好aa</p>');
  });
});
