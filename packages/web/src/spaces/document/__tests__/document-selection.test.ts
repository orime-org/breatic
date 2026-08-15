// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * `Ctrl+A` 只有一档：标题和正文互不越界。
 *
 * 规则是 user 2026-08-15 拍定的：**Ctrl+A 按它本来的意思就是全选，没有「先选这一块、
 * 再选全部」那种分级**。光标在正文里就全选正文，在标题里就全选标题，两边互不波及。
 * user 原话：「Ctrl+A 按照原始的含义就是全选，并没有所谓的『选中第一级』和『选中
 * 第二级』的逻辑……我们并不是去再造一个飞书」。ProseMirror 官方的 basic 示例实测
 * 也是一档：按一次选 515 字，再按一次还是 515。
 *
 * **这个扩展存在的唯一理由是挡住标题**。tiptap 自带的 `Mod-a` 绑的是 `selectAll()`，
 * 实测产出从位置 0 开始的 `AllSelection`，而位置 0 在标题里 —— 标题是文档的名字，
 * AI 那条线会替换选中的内容，让它落在名字上是不可接受的。我们的标题是同一份
 * ProseMirror 文档的第一个块（内容规则 `title block*`），所以「全部」真的包含它；
 * 标题独立成字段的编辑器不会有这个问题。
 *
 * 键名绑的是 `Mod-a`，一条平台无关的写法：`prosemirror-keymap` 在模块加载时读
 * `navigator.platform`，mac 上把它解析成 `Cmd-a`、其它平台解析成 `Ctrl-a`（源码
 * :81 原话「You can use `Mod-` as a shorthand for `Cmd-` on Mac and `Ctrl-` on
 * other platforms」）。**那个解析是库的行为，不在这里测** —— 这里只钉两样：绑的
 * 键名确实是 `Mod-a`（见「绑的是哪个键」那组），以及按下去之后选中什么。
 *
 * **只读（viewer）不在这份测试的范围里**（user 2026-08-14 定：归只读模式那个独立任务）。
 * 那条路上真浏览器实测过：不可编辑时编辑器 DOM 是 `contenteditable="false"` 且没有
 * `tabindex`，点正文焦点落在 body 上，按键根本到不了编辑器，跟这个扩展绑在哪个 prop
 * 上无关。
 *
 * 行为用例跑在 jsdom 默认环境下，那里 `navigator.platform` 是空串、`Mod-` 解析成
 * `Ctrl-`，所以事件用 `ctrlKey`。
 */

import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import { AllSelection, NodeSelection, TextSelection } from '@tiptap/pm/state';
import * as Y from 'yjs';
import { documentBodyFragment, encodeInitialSpaceContent } from '@breatic/shared';

import { buildDocumentExtensions } from '@web/spaces/document/document-extensions';
import { DocumentSelection } from '@web/spaces/document/document-selection';

const editors: Editor[] = [];

afterEach(() => {
  editors.splice(0).forEach((e) => {
    e.destroy();
  });
});

/**
 * 一份带标题和给定正文的文档。
 * @param bodyHtml - 标题之后的正文 HTML，空串就是正文零块。
 * @param title - 标题文本。
 * @returns 绑好的编辑器。
 */
function open(bodyHtml = '', title = 'TITLE'): Editor {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, encodeInitialSpaceContent('document', title));
  const editor = new Editor({
    extensions: buildDocumentExtensions({ fragment: documentBodyFragment(doc) }),
  });
  editors.push(editor);
  if (bodyHtml) {
    editor.commands.setContent(`<h1 class="doc-title">${title}</h1>${bodyHtml}`);
  }
  return editor;
}

/**
 * 按一次 `Ctrl+A`，派真实的 DOM 事件。
 *
 * **走真事件，不问 `someProp`**。绑定确实在 `handleKeyDown` 里
 * （`addKeyboardShortcuts` → `prosemirror-keymap` → 那个 prop），所以
 * `someProp('handleKeyDown')` 问得到它；但它**绕过了 `prosemirror-view` 的
 * `editable` 闸门**（`initInput` 的 `view.editable || !(event.type in
 * editHandlers)`，而 `keydown` 就在 `editHandlers` 里），也绕过了 `preventDefault`
 * 那一步。派真事件走的才是产品走的那条路，而这里没有任何理由不走它。
 * @param editor - 收这个键的编辑器。
 * @returns 这个键有没有被认领 —— 认领的那一方要挡掉浏览器自己的全选。
 */
function pressCtrlA(editor: Editor): boolean {
  const event = new KeyboardEvent('keydown', {
    key: 'a',
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  });
  editor.view.dom.dispatchEvent(event);
  return event.defaultPrevented;
}

/** 标题节点占多少位置 —— 正文的一切都在它之后。 */
function titleSize(editor: Editor): number {
  return editor.state.doc.child(0).nodeSize;
}

/** 标题内容的文本范围。 */
function titleRange(editor: Editor): { from: number; to: number } {
  return { from: 1, to: 1 + editor.state.doc.child(0).content.size };
}

/** 当前选区，取成一对好断言的数字。 */
function selection(editor: Editor): { from: number; to: number } {
  const { from, to } = editor.state.selection;
  return { from, to };
}

/**
 * 把光标放进第 index 个顶层块里（0 是标题）。
 * @param editor - 目标编辑器。
 * @param index - 顶层块序号。
 * @param offset - 块内偏移。
 */
function caretIn(editor: Editor, index: number, offset = 0): void {
  const doc = editor.state.doc;
  let pos = 0;
  for (let i = 0; i < index; i += 1) pos += doc.child(i).nodeSize;
  const $inside = doc.resolve(pos + 1 + offset);
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.near($inside)));
}

/** 第 index 个顶层块里那段文本的范围。 */
function blockRange(editor: Editor, index: number): { from: number; to: number } {
  const doc = editor.state.doc;
  let pos = 0;
  for (let i = 0; i < index; i += 1) pos += doc.child(i).nodeSize;
  const $inside = doc.resolve(pos + 1);
  return { from: $inside.start(), to: $inside.end() };
}

/**
 * 正文里每一段文字所占的位置区间（标题里的不算）。
 *
 * 用来判「全选正文」有没有真的覆盖全部，**而不是拿两个位置数字去比**。位置算术
 * 依赖块的嵌套深度：正文是一串顶层段落时正文起点是 `titleSize + 1`，正文首块换成
 * 引用块就变成 `titleSize + 2`，写死任何一个数字都只对其中一种形状成立。问「每一段
 * 文字在不在选区里」对任何形状都是同一个问题。
 * @param editor - 目标编辑器。
 * @returns 每段文字的起止位置。
 */
function bodyTextSpans(editor: Editor): { from: number; to: number }[] {
  const spans: { from: number; to: number }[] = [];
  const body = titleSize(editor);
  editor.state.doc.descendants((node, pos) => {
    if (node.isText && pos >= body) spans.push({ from: pos, to: pos + node.nodeSize });
    return true;
  });
  return spans;
}

/**
 * 选区有没有覆盖正文里的每一段文字。
 * @param editor - 目标编辑器。
 * @returns 每一段都在选区里就为真。
 */
function coversAllBodyText(editor: Editor): boolean {
  const { from, to } = editor.state.selection;
  const spans = bodyTextSpans(editor);
  if (spans.length === 0) return false;
  return spans.every((span) => span.from >= from && span.to <= to);
}

/**
 * 选区有没有伸进标题 —— 「从正文出发选不到标题」那半的判据。
 *
 * 只在**正文侧**的用例里有意义：光标本来就在标题里时，选中标题当然从位置 1
 * 开始，拿这个函数去要求它为 false 是问错了问题。标题侧要断言的是
 * 「`to` 没越过标题」，见 `staysInsideTitle`。
 */
function touchesTitle(editor: Editor): boolean {
  return editor.state.selection.from < titleSize(editor);
}

/** 选区有没有伸出标题 —— 「从标题出发选不到正文」那半的判据。 */
function staysInsideTitle(editor: Editor): boolean {
  return editor.state.selection.to <= titleSize(editor);
}

describe('光标在正文里', () => {
  it('按一次就给全部正文，不是光标所在的那一块', () => {
    const editor = open('<p>first</p><p>second</p><p>third</p>');
    caretIn(editor, 2, 2);

    pressCtrlA(editor);

    expect(coversAllBodyText(editor), '三段文字都要在选区里').toBe(true);
    expect(selection(editor)).not.toEqual(blockRange(editor, 2));
    expect(touchesTitle(editor)).toBe(false);
  });

  it('两端落在文字上，不是落在块的边界上', () => {
    // 一档之后正文选区是普通的 `TextSelection`，两端都在 inline content 里 ——
    // 这正是「全选之后按回车 / 字符 / 删除跟浏览器原生一致」的前提：那些命令
    // 靠 `$from.parent.inlineContent` 判断自己能不能干活，端点落在块边界上时
    // 它们会拒绝，于是回车什么都不删、只在末尾多出一个空段落。
    const editor = open('<p>first</p><p>second</p>');
    caretIn(editor, 1, 1);

    pressCtrlA(editor);

    const { $from, $to } = editor.state.selection;
    expect($from.parent.inlineContent, '起点要落在能放文字的块里').toBe(true);
    expect($to.parent.inlineContent, '终点要落在能放文字的块里').toBe(true);
    expect(selection(editor)).toEqual({
      from: blockRange(editor, 1).from,
      to: blockRange(editor, 2).to,
    });
  });

  it('块里已经选中一部分（双击选词那种），按一次同样给全部正文', () => {
    const editor = open('<p>first</p><p>second word here</p>');
    const block = blockRange(editor, 2);
    editor.view.dispatch(
      editor.state.tr.setSelection(
        TextSelection.create(editor.state.doc, block.from + 2, block.from + 6),
      ),
    );

    pressCtrlA(editor);

    expect(coversAllBodyText(editor)).toBe(true);
    expect(touchesTitle(editor)).toBe(false);
  });

  it('光标停在空块里，按一次也给全部正文', () => {
    // 写字时最常见的位置：正文末尾按 Enter 新起一段，那一段是空的。分级那版在
    // 这里有个走不出去的坑（空块上「这一块」和「光标」是同一个零长度范围，
    // 任何从选区现场推档位的规则都分不出第一次按和第二次按）；一档没有档位，
    // 这个坑跟着消失。
    const editor = open('<p>alpha</p><p></p>');
    const empty = blockRange(editor, 2);
    expect(empty.from, '前提：第二个块是空的').toBe(empty.to);
    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, empty.from)),
    );

    pressCtrlA(editor);

    expect(coversAllBodyText(editor)).toBe(true);
    expect(touchesTitle(editor)).toBe(false);
  });

  it('连按两次，第二次什么都不变 —— 这就是「一档」的定义', () => {
    const editor = open('<p>first</p><p>second</p>');
    caretIn(editor, 1, 1);

    pressCtrlA(editor);
    const afterOne = selection(editor);
    pressCtrlA(editor);

    expect(selection(editor), '一档：再按一次不该有第二个结果').toEqual(afterOne);
    expect(coversAllBodyText(editor)).toBe(true);
    expect(touchesTitle(editor)).toBe(false);
  });

  it('正文只有一块时，按一次给那一块的全部文字', () => {
    const editor = open('<p>only</p>');
    caretIn(editor, 1, 1);

    pressCtrlA(editor);

    expect(selection(editor)).toEqual(blockRange(editor, 1));
    expect(touchesTitle(editor)).toBe(false);
  });

  it('正文块嵌在容器里时，照样覆盖到最里面那段文字', () => {
    // 位置算术会在这种形状上出错而断言仍然通过，所以判据问的是「每段文字在不在
    // 选区里」：引用块和列表把文字又包了一层，正文起点不再是 `titleSize + 1`。
    const editor = open(
      '<blockquote><p>quoted</p></blockquote><ul><li><p>item</p></li></ul>',
    );
    caretIn(editor, 1, 1);

    pressCtrlA(editor);

    expect(coversAllBodyText(editor), '引用和列表里的文字都要在选区里').toBe(true);
    expect(touchesTitle(editor)).toBe(false);
  });
});

describe('光标在标题里', () => {
  it('按一次只选中标题，碰不到正文', () => {
    const editor = open('<p>body</p>');
    caretIn(editor, 0, 2);

    pressCtrlA(editor);

    expect(selection(editor)).toEqual(titleRange(editor));
    expect(staysInsideTitle(editor)).toBe(true);
  });

  it('标题里已经选中一部分，按一次给整个标题，不跨进正文', () => {
    const editor = open('<p>body</p>');
    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 2, 4)),
    );

    pressCtrlA(editor);

    expect(selection(editor)).toEqual(titleRange(editor));
    expect(staysInsideTitle(editor)).toBe(true);
  });

  it('连按两次，第二次什么都不变', () => {
    const editor = open('<p>body</p>');
    caretIn(editor, 0, 1);

    pressCtrlA(editor);
    const afterOne = selection(editor);
    pressCtrlA(editor);

    expect(selection(editor)).toEqual(afterOne);
    expect(afterOne).toEqual(titleRange(editor));
    expect(staysInsideTitle(editor)).toBe(true);
  });
});

describe('光标哪儿都不在', () => {
  it('整块被选中时（Cmd+click 的产物），按一次给全部正文，不是给标题', () => {
    // 这个手势是 ProseMirror 内建的：`prosemirror-view@1.42.2:3338` 有
    // `const selectNodeModifier = mac ? "metaKey" : "ctrlKey"`，:3397 据它建
    // `NodeSelection`；我们放行它（`document-click-to-write.ts:124-131` 对带
    // 修饰键的点击明确 `return false`）。选中一整块时选区位置在那个块**外面**、
    // 文档这一层，`$from.parent` 是 `doc` 而不是 `paragraph`，所以「光标在哪」
    // 这个问题的答案是「都不在」。
    //
    // 答成「给标题」会让用户在正文点一下、按 Ctrl+A、再敲一个字，文档的名字被
    // 覆盖 —— 而这个扩展存在的全部理由就是挡这件事。
    const editor = open('<p>first</p><p>second</p>');
    editor.view.dispatch(
      editor.state.tr.setSelection(
        NodeSelection.create(editor.state.doc, titleSize(editor)),
      ),
    );
    expect(
      editor.state.selection.$from.parent.type.name,
      '前提：整块选中时选区的父节点是文档本身',
    ).toBe('doc');

    pressCtrlA(editor);

    expect(coversAllBodyText(editor)).toBe(true);
    expect(touchesTitle(editor), '不许滑到标题上去').toBe(false);
  });

  it('AllSelection 也算哪儿都不在，按一次收敛到正文', () => {
    // tiptap 自带的 `selectAll` 产出的就是它，从位置 0 开始、标题在里面。
    const editor = open('<p>first</p><p>second</p>');
    editor.view.dispatch(
      editor.state.tr.setSelection(new AllSelection(editor.state.doc)),
    );

    pressCtrlA(editor);

    expect(coversAllBodyText(editor)).toBe(true);
    expect(touchesTitle(editor)).toBe(false);
  });
});

describe('正文一个块都没有', () => {
  it('光标在标题里按下：不抛异常，选中标题，不伸进（不存在的）正文', () => {
    const editor = open('');
    expect(editor.state.doc.childCount, '这份文档本该只有标题').toBe(1);
    caretIn(editor, 0, 1);

    expect(() => pressCtrlA(editor)).not.toThrow();

    expect(selection(editor)).toEqual(titleRange(editor));
    expect(staysInsideTitle(editor)).toBe(true);
  });

  it('正文零块时从「哪儿都不在」出发，选区原样不动，键仍然被认领', () => {
    // 正文没有任何东西可选，正确的答案是**什么都不做**：不换选区，也不把键交回去。
    //
    // 断言必须是「选区没变」，不能是「from 没跨进标题」那种宽松条件 —— 变异实测：
    // 去掉正文为空那道守卫，得到的是正文起点处的一个空选区，它的 from 恰好等于
    // 标题的 nodeSize，宽松条件照样通过。
    const editor = open('');
    editor.view.dispatch(
      editor.state.tr.setSelection(new AllSelection(editor.state.doc)),
    );
    const before = selection(editor);

    const claimed = pressCtrlA(editor);

    expect(selection(editor), '正文零块时不许换掉用户的选区').toEqual(before);
    expect(editor.state.selection, '类型也不许换').toBeInstanceOf(AllSelection);
    // 交回去就落到 @tiptap/core 的 selectAll，那会产出一个含标题的 AllSelection。
    expect(claimed, '没东西可选也要吃掉这个键').toBe(true);
  });
});

describe('这个键永远由我们认领', () => {
  it('结果跟现状一样时也不把键交回去', () => {
    // 交回去就落到 @tiptap/core 自己那条 `Mod-a` → selectAll，实测它产出
    // AllSelection 0..9、标题在里面，正是这次要挡的越界。
    const editor = open('<p>body</p>');
    caretIn(editor, 0, 1);
    pressCtrlA(editor);

    // 「被认领」的判据是这个键的默认行为被挡掉了：我们的处理器返回 true 时
    // 自己调 `preventDefault`，而没人认领的键会原样冒上去、让浏览器全选整页。
    expect(pressCtrlA(editor), '第二次按下同样要被认领').toBe(true);
    expect(selection(editor)).toEqual(titleRange(editor));
    expect(staysInsideTitle(editor)).toBe(true);
  });
});

describe('全选正文之后，格式操作对选中的每一段文字都生效', () => {
  it('加粗落在正文每一段文字上，标题一个字都不受影响', () => {
    // **判据是读每个文本节点的 marks，不是读 `textContent`**。加粗不改
    // `textContent`，拿它当观察量会得出「没生效」的相反结论 —— 这次任务里
    // 真的这么错过一次（设计文档 §9 第二条教训）。
    const editor = open('<p>first</p><blockquote><p>quoted</p></blockquote>');
    caretIn(editor, 1, 1);

    pressCtrlA(editor);
    editor.commands.toggleBold();

    const body = titleSize(editor);
    const bolded: boolean[] = [];
    const titleMarks: string[] = [];
    editor.state.doc.descendants((node, pos) => {
      if (!node.isText) return true;
      if (pos >= body) bolded.push(node.marks.some((m) => m.type.name === 'bold'));
      else titleMarks.push(...node.marks.map((m) => m.type.name));
      return true;
    });

    expect(bolded.length, '前提：正文里有文字可以加粗').toBeGreaterThan(0);
    expect(bolded.every(Boolean), '正文每一段文字都要变粗').toBe(true);
    expect(titleMarks, '标题不该沾上任何标记').toEqual([]);
  });
});

describe('鼠标拖选不许跨过标题和正文之间那条线', () => {
  /**
   * 问编辑器：DOM 上从 anchor 拖到 head，你要造一个什么样的选区？
   *
   * **走 `someProp`，不直接调我们的函数**。`createSelectionBetween` 是
   * ProseMirror 的官方钩子（`prosemirror-view@1.42.2:2401` 的 `selectionBetween`
   * 里 `view.someProp("createSelectionBetween", …) || TextSelection.between(…)`），
   * `prosemirror-gapcursor` 和 `prosemirror-tables` 用的也是它。`someProp` 走的
   * 是插件注册的那条真实路径，所以这里同时钉住了「逻辑对」和「它真的挂上去了」。
   *
   * **为什么不用真的拖一次**：jsdom 里合成的 mousedown / mousemove / mouseup
   * 驱动不了 ProseMirror 的拖选（两个方向实测都返回空选区，连本该成功的方向
   * 都驱不动），所以真拖只能在真浏览器里做，那是 smoke 的事。这里钉的是收到
   * 这两个端点之后该给出什么答案。
   * @param editor - 目标编辑器。
   * @param anchor - 按下鼠标的位置。
   * @param head - 松开鼠标的位置。
   * @returns 编辑器给出的选区。
   */
  function askForSelection(
    editor: Editor,
    anchor: number,
    head: number,
  ): { from: number; to: number; anchor: number; head: number } | null {
    const { doc } = editor.state;
    const made = editor.view.someProp(
      'createSelectionBetween',
      (f) => f(editor.view, doc.resolve(anchor), doc.resolve(head)),
    );
    if (!made) return null;
    return { from: made.from, to: made.to, anchor: made.anchor, head: made.head };
  }

  /**
   * 同上，但要求真的给了一个选区 —— 用在跨线的用例里。
   * @param editor - 目标编辑器。
   * @param anchor - 按下鼠标的位置。
   * @param head - 松开鼠标的位置。
   * @returns 夹紧之后的选区。
   */
  function askAndExpectClamped(
    editor: Editor,
    anchor: number,
    head: number,
  ): { from: number; to: number; anchor: number; head: number } {
    const made = askForSelection(editor, anchor, head);
    expect(made, '跨线的拖选必须被夹住，不能交给编辑器自己处理').not.toBeNull();
    return made as NonNullable<typeof made>;
  }

  it('从正文往上拖进标题，选区停在正文起点', () => {
    // 真浏览器实测的形状（2026-08-15）：从第一段中间往上拖到标题上，得到的是
    // 6..15 —— 6 在标题里（标题占 0..9），标题末尾两个字被选中，接着敲一个字
    // 文档的名字就少一截。
    const editor = open('<p>first</p><p>second</p>');
    const body = titleSize(editor);
    const s = askAndExpectClamped(editor, body + 3, 2);

    expect(s.from, '不许伸进标题').toBeGreaterThanOrEqual(body);
    expect(s.anchor, '按下鼠标的那一端不动').toBe(body + 3);
  });

  it('从标题往下拖进正文，选区停在标题末尾', () => {
    // 另一半：反方向拖同样不许越界。规则是「互不越界」，不是「正文优先」。
    const editor = open('<p>first</p><p>second</p>');
    const body = titleSize(editor);
    const s = askAndExpectClamped(editor, 2, body + 3);

    expect(s.to, '不许伸进正文').toBeLessThanOrEqual(body);
    expect(s.anchor, '按下鼠标的那一端不动').toBe(2);
  });

  it('两端都在正文里时，一个字都不动', () => {
    // 夹紧只在跨线时发生。正文内部的拖选是编辑器自己的事，我们不插手 ——
    // 这条是变异守卫：一个「永远返回正文选区」的实现会在这里红。
    const editor = open('<p>first</p><p>second</p><p>third</p>');
    const from = blockRange(editor, 1).from + 1;
    const to = blockRange(editor, 3).to - 1;

    // null 的意思是「我们没有意见」，编辑器自己的 `TextSelection.between` 接手。
    // 那正是同侧拖选该走的路，所以这里断言的是「我们没插手」。
    expect(askForSelection(editor, from, to)).toBeNull();
  });

  it('两端都在标题里时，一个字都不动', () => {
    const editor = open('<p>first</p>');

    expect(askForSelection(editor, 2, 4)).toBeNull();
  });

  it('正文一个块都没有时，跨线的拖选收进标题而不是抛异常', () => {
    // 正文没有可落脚的位置，夹进正文是做不到的事。答案是夹进标题 ——
    // 那是这份文档此刻唯一有内容的地方。
    const editor = open('');
    const body = titleSize(editor);

    expect(() => askForSelection(editor, 2, body)).not.toThrow();
    const s = askAndExpectClamped(editor, 2, body);
    expect(s.to).toBeLessThanOrEqual(body);
  });
});

describe('绑的是哪个键', () => {
  it('用平台无关的 Mod-a，不是写死某一个平台的键', () => {
    // 这是这份代码里唯一属于我们的那个决定：写 `Mod-a`，让库去解析成
    // mac 的 Cmd 或其它平台的 Ctrl。写死 `Ctrl-a` 会在 mac 上顶掉
    // @tiptap/core 绑在那儿的 selectTextblockStart（dist/index.js:5233）。
    const keys = Object.keys(
      (
        DocumentSelection.config.addKeyboardShortcuts as unknown as () => Record<
          string,
          unknown
        >
      ).call({ editor: null }),
    );

    expect(keys).toEqual(['Mod-a']);
  });
});
