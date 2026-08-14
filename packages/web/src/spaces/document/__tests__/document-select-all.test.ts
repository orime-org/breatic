// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * 分级 `Ctrl+A`：标题和正文互不越界。
 *
 * 规则是 user 2026-08-11 拍定的（inner 的菜单体系定稿 §3.1.1）：正文里按一次选当前
 * 这一块、再按一次选全部正文；标题上只选标题、再按不扩大；光标哪儿都不在时选全部正文。
 * 核心一句是**从正文出发永远选不到标题，从标题出发永远选不到正文**。
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
import { GapCursor } from '@tiptap/pm/gapcursor';
import { AllSelection, NodeSelection, TextSelection } from '@tiptap/pm/state';
import type { ResolvedPos } from '@tiptap/pm/model';
import * as Y from 'yjs';
import { documentBodyFragment, encodeInitialSpaceContent } from '@breatic/shared';

import { buildDocumentExtensions } from '@web/spaces/document/document-extensions';
import { DocumentSelectAll } from '@web/spaces/document/document-select-all';

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
  it('按一次只选中当前这一块，碰不到标题', () => {
    const editor = open('<p>first</p><p>second</p><p>third</p>');
    caretIn(editor, 2, 2);

    pressCtrlA(editor);

    expect(selection(editor)).toEqual(blockRange(editor, 2));
    expect(touchesTitle(editor)).toBe(false);
  });

  it('块里已经选中一部分（双击选词那种），按一次仍然给当前这一块', () => {
    // Gate 1 咬出的那条：把档位 keyed 在选区形状上，这种选区会落进兜底、直接跳到全部正文。
    const editor = open('<p>first</p><p>second word here</p>');
    const block = blockRange(editor, 2);
    editor.view.dispatch(
      editor.state.tr.setSelection(
        TextSelection.create(editor.state.doc, block.from + 2, block.from + 6),
      ),
    );

    pressCtrlA(editor);

    expect(selection(editor)).toEqual(block);
    expect(touchesTitle(editor)).toBe(false);
  });

  it('光标停在空块里，按一次直接给全部正文 —— 空块上这两档是同一个范围', () => {
    // 写字时最常见的位置：正文末尾按 Enter 新起一段，那一段是空的。
    //
    // 空块上「选中这一块」和「光标停在这一块」是**同一个零长度范围**，所以任何
    // 「拿当前选区去推档位」的规则都分不出第一次按和第二次按 —— 答「这一块」会
    // 永远停在那儿出不去（实测过：加一条「塌缩就给这一块」之后，按两次仍是
    // 15..15，到不了全部正文）。要分开只能存按了几次，而**不存次数正是这个设计
    // 的前提**（见 `document-select-all.ts` 文件头和「档位是从选区现场推导的」
    // 那一组）。所以这里钉住的是真实行为，不是遗憾。
    const editor = open('<p>alpha</p><p></p>');
    const empty = blockRange(editor, 2);
    expect(empty.from, '前提：第二个块是空的').toBe(empty.to);
    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, empty.from)),
    );

    pressCtrlA(editor);

    expect(selection(editor).from).toBe(titleSize(editor));
    expect(selection(editor).to).toBe(editor.state.doc.content.size);
    expect(touchesTitle(editor), '跳档也不许碰到标题').toBe(false);
  });

  it('空块里连按两次，停在全部正文不再变', () => {
    const editor = open('<p>alpha</p><p></p>');
    const empty = blockRange(editor, 2);
    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, empty.from)),
    );

    pressCtrlA(editor);
    const afterOne = selection(editor);
    pressCtrlA(editor);

    expect(selection(editor)).toEqual(afterOne);
  });

  it('选区从块首开始但没覆盖整块时，按一次给整块 —— 双击首词、按 Home 都是这个形状', () => {
    // 变异实测逮出来的缺口：把「选区是否恰好等于这一块」的判据改成只比起点，
    // 整套用例一条都不红 —— 因为没有一个用例的选区是从块首开始的（每个
    // `caretIn` 都传了非零 offset）。而双击第一个词、按 Home、点行首都落在这儿。
    const editor = open('<p>first</p><p>second word</p>');
    const block = blockRange(editor, 2);
    editor.view.dispatch(
      editor.state.tr.setSelection(
        TextSelection.create(editor.state.doc, block.from, block.from + 3),
      ),
    );

    pressCtrlA(editor);

    expect(selection(editor), '只选了块首几个字，第一档该给整块').toEqual(block);
    expect(touchesTitle(editor)).toBe(false);
  });

  it('再按一次扩大到全部正文，仍然碰不到标题', () => {
    const editor = open('<p>first</p><p>second</p><p>third</p>');
    caretIn(editor, 2, 2);

    pressCtrlA(editor);
    pressCtrlA(editor);

    // 「全部正文」覆盖每个正文块的**完整节点**（含块本身），所以两端是正文的
    // 边界而不是首末块的文字起止 —— 这是 BodySelection 带来的语义，也是能把
    // 分割线这类放不进光标的块选中的原因。
    const all = selection(editor);
    expect(all.from).toBe(titleSize(editor));
    expect(all.to).toBe(editor.state.doc.content.size);
    expect(touchesTitle(editor)).toBe(false);
  });

  it('第三次按下不再扩大，而停住的那个值就是全部正文', () => {
    // 「两次相同」一条断言不够：现状是每次都全选整篇，它天然满足幂等。
    // 所以还要钉住停住的那个值是对的。
    const editor = open('<p>first</p><p>second</p>');
    caretIn(editor, 1, 1);

    pressCtrlA(editor);
    pressCtrlA(editor);
    const afterTwo = selection(editor);
    pressCtrlA(editor);

    expect(selection(editor)).toEqual(afterTwo);
    expect(afterTwo.from).toBe(titleSize(editor));
    expect(afterTwo.to).toBe(editor.state.doc.content.size);
    expect(touchesTitle(editor)).toBe(false);
  });

  it('正文末块是 atom 时，第三次按下也不再扩大', () => {
    // 真机咬出来的：那份文档最后一个块是 `unsupportedBlock`（#105 的兜底类型，
    // 也是 atom）。算范围用 `Selection.near` 拿到的是 atom 的外沿，造选区用
    // `TextSelection.between` 会把那一端往内缩 —— 两把尺，于是「已经是全部正文」
    // 这道判定永远不命中，选区在第一块和全部正文之间来回跳。
    const editor = open('<p>first</p><p>second</p><hr>');
    caretIn(editor, 1, 1);

    pressCtrlA(editor);
    pressCtrlA(editor);
    const afterTwo = selection(editor);
    pressCtrlA(editor);

    expect(selection(editor)).toEqual(afterTwo);
    expect(touchesTitle(editor)).toBe(false);
  });

  it('正文只有一块时，第一次给那一块、第二次给全部正文（两者范围相同）', () => {
    const editor = open('<p>only</p>');
    caretIn(editor, 1, 1);

    pressCtrlA(editor);
    const first = selection(editor);
    pressCtrlA(editor);

    // 第一档仍是那一块的文字；第二档是正文边界，两者不再是同一个范围。
    expect(first).toEqual(blockRange(editor, 1));
    expect(selection(editor).from).toBe(titleSize(editor));
    expect(selection(editor).to).toBe(editor.state.doc.content.size);
    expect(touchesTitle(editor)).toBe(false);
  });
});

describe('选区已经跨过一块以上时，按下去要继续扩大', () => {
  it('用鼠标从第一块拖到第三块，按一次给全部正文，不是缩回第一块', () => {
    // 真浏览器量到的：跨块拖选 361 字，按一次变成 344 字（光标所在那一块）——
    // 一个意为「扩大」的键先把选区缩小了。规则说「按一次选当前这一块」，指的是
    // 起点，跨块的选区已经越过第一档了。
    const editor = open('<p>first</p><p>second</p><p>third</p>');
    const from = blockRange(editor, 1).from;
    const to = blockRange(editor, 3).to;
    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, from, to)),
    );

    pressCtrlA(editor);

    expect(selection(editor).from).toBe(titleSize(editor));
    expect(selection(editor).to).toBe(editor.state.doc.content.size);
    expect(touchesTitle(editor)).toBe(false);
  });

  it('跨块选区只覆盖两块中间的一部分时，同样给全部正文', () => {
    const editor = open('<p>first</p><p>second</p><p>third</p>');
    const from = blockRange(editor, 1).from + 2;
    const to = blockRange(editor, 2).to - 1;
    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, from, to)),
    );

    pressCtrlA(editor);

    expect(selection(editor).from).toBe(titleSize(editor));
    expect(selection(editor).to).toBe(editor.state.doc.content.size);
  });
  it('两块内容一样时也算跨块 —— 复制出来的块跟原块是同一个节点对象', () => {
    // ProseMirror 的节点不可变，复制一段内容时**产出的块跟原块是同一个 JS 对象**
    // （实测：拖拽复制走 `selection.content()` + `replaceRange`，两个位置的
    // `$from.parent === $to.parent` 为 true，而它们分属两个块）。所以「是不是同一个
    // 块」不能问对象身份，要问 `ResolvedPos.sameParent` —— 它比的是父块内容的起点
    // 位置，位置是唯一的。
    const editor = open('<p>one</p><p>two</p><p>three</p>');
    const d0 = editor.state.doc;
    const slice = d0.slice(blockRange(editor, 1).from, d0.content.size - 2, true);
    editor.view.dispatch(
      editor.state.tr.replaceRange(d0.content.size, d0.content.size, slice),
    );
    const doc = editor.state.doc;
    const twins: number[] = [];
    doc.descendants((n, pos) => {
      if (n.isBlock && n.textContent === 'two') twins.push(pos);
      return true;
    });
    expect(twins.length, '前提：复制之后有两个内容相同的块').toBe(2);
    const a = doc.resolve(twins[0] + 1);
    const b = doc.resolve(twins[1] + 1);
    expect(a.parent === b.parent, '前提：这两个块共用一个节点对象').toBe(true);
    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(doc, a.pos, b.pos)),
    );

    pressCtrlA(editor);

    expect(selection(editor).from, '跨两个块，按一次要给全部正文').toBe(titleSize(editor));
    expect(selection(editor).to).toBe(editor.state.doc.content.size);
  });
});

describe('光标在标题里', () => {
  it('按一次只选中标题，碰不到正文', () => {
    const editor = open('<p>body</p>');
    caretIn(editor, 0, 2);

    pressCtrlA(editor);

    expect(selection(editor)).toEqual(titleRange(editor));
    expect(editor.state.selection.to).toBeLessThanOrEqual(titleSize(editor));
  });

  it('标题里已经选中一部分，按一次给整个标题，不跨进正文', () => {
    // 同上，这是 Gate 1 咬出的那条在标题侧的样子：它会直接跳到全部正文。
    const editor = open('<p>body</p>');
    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 2, 4)),
    );

    pressCtrlA(editor);

    expect(selection(editor)).toEqual(titleRange(editor));
    expect(editor.state.selection.to).toBeLessThanOrEqual(titleSize(editor));
  });

  it('再按一次不再扩大，而停住的那个值就是标题本身', () => {
    // 同上：只断言「两次相同」在现状下也绿，得钉住那个值。
    const editor = open('<p>body</p>');
    caretIn(editor, 0, 1);

    pressCtrlA(editor);
    const afterOne = selection(editor);
    pressCtrlA(editor);

    expect(selection(editor)).toEqual(afterOne);
    expect(afterOne).toEqual(titleRange(editor));
    expect(afterOne.to).toBeLessThanOrEqual(titleSize(editor));
  });
});

describe('光标哪儿都不在', () => {
  it('GapCursor 停在分割线旁边时，给全部正文', () => {
    // 合法的 GapCursor 位置实测过：atom 块紧贴文档或容器边界时才有，
    // 两个段落之间一个都没有（设计文档 §9.3）。位置是**找**出来的不是算出来的，
    // 因为它取决于块的嵌套，写死一个偏移量会钉住一个用户到不了的位置。
    // 形状取的是探针验过有合法位置的那个（设计文档 §9.3）：分割线紧贴文档末尾。
    // `<hr><p>after</p>` 反而一个合法位置都没有 —— 分割线前面是标题、后面是段落，
    // 两边都是 inline content，`closedBefore` / `closedAfter` 各自就返回了 false。
    const editor = open('<hr>');
    const reaches = GapCursor as unknown as { valid(pos: ResolvedPos): boolean };
    let gapPos = -1;
    for (let pos = titleSize(editor); pos <= editor.state.doc.content.size; pos += 1) {
      if (reaches.valid(editor.state.doc.resolve(pos))) {
        gapPos = pos;
        break;
      }
    }
    expect(gapPos, '这份文档里本该有一个合法的 GapCursor 位置').toBeGreaterThan(-1);
    editor.view.dispatch(
      editor.state.tr.setSelection(new GapCursor(editor.state.doc.resolve(gapPos))),
    );

    pressCtrlA(editor);

    expect(touchesTitle(editor)).toBe(false);
    expect(editor.state.selection.from).toBeGreaterThanOrEqual(titleSize(editor));
  });

  it('选中一条分割线的 NodeSelection，按一次给全部正文', () => {
    const editor = open('<p>before</p><hr><p>after</p>');
    let hrPos = -1;
    editor.state.doc.forEach((node, offset) => {
      if (node.type.name === 'horizontalRule') hrPos = offset;
    });
    editor.view.dispatch(
      editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, hrPos)),
    );

    pressCtrlA(editor);

    expect(touchesTitle(editor)).toBe(false);
    expect(editor.state.selection.from).toBe(titleSize(editor));
  });
});

describe('正文一个块都没有', () => {
  it('光标在标题里按下：不抛异常，选中标题，不伸进（不存在的）正文', () => {
    // 正文零块时光标只能在标题里，所以这里走的是标题侧，选中标题正是规则要的。
    // 这条真正钉的是 `bodyRange` 返回 null 那条路不崩。
    const editor = open('');
    expect(editor.state.doc.childCount, '这份文档本该只有标题').toBe(1);
    caretIn(editor, 0, 1);

    expect(() => pressCtrlA(editor)).not.toThrow();

    expect(selection(editor)).toEqual(titleRange(editor));
    expect(staysInsideTitle(editor)).toBe(true);
  });

  it('正文零块时从「哪儿都不在」出发，选区原样不动，键仍然被认领', () => {
    // AllSelection 是「哪儿都不在」的一种（`selectAll` 产出的就是它）。正文没有
    // 任何东西可选，正确的答案是**什么都不做**：不换选区，也不把键交回去。
    //
    // 断言必须是「选区没变」，不能是「from 没跨进标题」那种宽松条件 —— 变异实测：
    // 去掉 `hasBody` 那道守卫，得到的是正文起点处的一个空选区，它的 from 恰好等于
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
    // AllSelection 0..9、标题在里面，正是这次要修的越界。
    const editor = open('<p>body</p>');
    caretIn(editor, 0, 1);
    pressCtrlA(editor);

    // 「被认领」的判据是这个键的默认行为被挡掉了：我们的处理器返回 true 时
    // 自己调 `preventDefault`，而没人认领的键会原样冒上去、让浏览器全选整页。
    expect(pressCtrlA(editor), '第二次按下同样要被认领').toBe(true);
    // 交回去的症状就是选区变成整篇：core 的 selectAll 产出 AllSelection 0..N。
    expect(selection(editor)).toEqual(titleRange(editor));
    expect(staysInsideTitle(editor)).toBe(true);
  });
});

describe('档位是从选区现场推导的，不是数按了几次', () => {
  it('把选区放回起点再按，回到第一档', () => {
    // 这条是 A9 的守卫，写法是变异出来的：先前只断言「连按两次结果稳定」，
    // 而一个「每个编辑器存一份计数器」的实现照样能全绿 —— 实测过，14 条一条不红。
    // 真正的区别在这里：现场推导只看当前选区，所以选区退回去，档位也退回去；
    // 计数器只增不减，退不回来。
    const editor = open('<p>first</p><p>second</p><p>third</p>');
    caretIn(editor, 2, 1);

    pressCtrlA(editor);
    const firstTier = selection(editor);
    pressCtrlA(editor);
    expect(selection(editor)).not.toEqual(firstTier);

    // 手动把选区放回按第一次之前的样子
    caretIn(editor, 2, 1);
    pressCtrlA(editor);

    expect(selection(editor)).toEqual(firstTier);
    expect(selection(editor)).toEqual(blockRange(editor, 2));
  });

  it('换一个块按，给的是那个块而不是下一档', () => {
    const editor = open('<p>first</p><p>second</p><p>third</p>');
    caretIn(editor, 1, 1);
    pressCtrlA(editor);

    // 光标挪到另一个块，再按 —— 计数器式实现这时已经在第二档了。
    caretIn(editor, 3, 1);
    pressCtrlA(editor);

    expect(selection(editor)).toEqual(blockRange(editor, 3));
  });
});

describe('绑的是哪个键', () => {
  it('用平台无关的 Mod-a，不是写死某一个平台的键', () => {
    // 这是这份代码里唯一属于我们的那个决定：写 `Mod-a`，让库去解析成
    // mac 的 Cmd 或其它平台的 Ctrl。写死 `Ctrl-a` 会在 mac 上顶掉
    // @tiptap/core 绑在那儿的 selectTextblockStart（dist/index.js:5233）。
    //
    const keys = Object.keys(
      (
        DocumentSelectAll.config.addKeyboardShortcuts as unknown as () => Record<
          string,
          unknown
        >
      ).call({ editor: null }),
    );

    expect(keys).toEqual(['Mod-a']);
  });
});


describe('正文里有不能放光标的块（atom）时，全部正文要覆盖它们', () => {
  it('正文全是分割线：按一次覆盖全部三条，不是只有第一条', () => {
    // 业界依据：ProseMirror 官方 guide 明写「allows 3rd-party code to define new
    // selection types」，官方 `AllSelection` 和官方表格包的 `CellSelection` 都是
    // `Selection` 子类。所以「选不中 atom」不是限制，是我们没写那个类型。
    const editor = open('<hr><hr><hr>');
    const doc = editor.state.doc;
    editor.view.dispatch(
      editor.state.tr.setSelection(NodeSelection.create(doc, titleSize(editor))),
    );

    pressCtrlA(editor);

    const s = editor.state.selection;
    expect(s.from).toBe(titleSize(editor));
    expect(s.to).toBe(editor.state.doc.content.size);
  });

  it('正文末块是分割线：全部正文含那一条', () => {
    const editor = open('<p>first</p><hr>');
    caretIn(editor, 1, 1);

    pressCtrlA(editor);
    pressCtrlA(editor);

    expect(selection(editor).to).toBe(editor.state.doc.content.size);
    expect(touchesTitle(editor)).toBe(false);
  });

  it('正文首块是分割线：全部正文含那一条', () => {
    const editor = open('<hr><p>after</p>');
    caretIn(editor, 2, 1);

    pressCtrlA(editor);
    pressCtrlA(editor);

    expect(selection(editor).from).toBe(titleSize(editor));
    expect(touchesTitle(editor)).toBe(false);
  });
});

describe('容器里的 atom 和 GapCursor 也算「哪儿都不在」', () => {
  it('引用块里的分割线被选中，按一次给全部正文，不是给一个空选区', () => {
    const editor = open('<p>keep me</p><blockquote><hr><hr></blockquote>');
    let hr = -1;
    editor.state.doc.descendants((n, pos) => {
      if (hr < 0 && n.type.name === 'horizontalRule') hr = pos;
      return true;
    });
    editor.view.dispatch(
      editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, hr)),
    );

    pressCtrlA(editor);

    const s = editor.state.selection;
    expect(s.empty, '按全选不该得到一个空选区').toBe(false);
    expect(s.from).toBe(titleSize(editor));
    expect(s.to).toBe(editor.state.doc.content.size);
  });

  it('引用块边界的 GapCursor，按一次给全部正文', () => {
    // 形状取的是探针验过、确实有一个 depth > 0 合法 GapCursor 的那个（设计文档 §9.3）。
    const editor = open('<hr><blockquote><hr><p>x</p><hr></blockquote>');
    const reaches = GapCursor as unknown as { valid(pos: ResolvedPos): boolean };
    let gap = -1;
    for (let p = titleSize(editor); p <= editor.state.doc.content.size; p += 1) {
      const $p = editor.state.doc.resolve(p);
      if (reaches.valid($p) && $p.depth > 0) {
        gap = p;
        break;
      }
    }
    expect(gap, '这份文档本该有一个容器内的合法 GapCursor').toBeGreaterThan(-1);
    editor.view.dispatch(
      editor.state.tr.setSelection(new GapCursor(editor.state.doc.resolve(gap))),
    );

    pressCtrlA(editor);

    expect(selection(editor).from).toBe(titleSize(editor));
    expect(selection(editor).to).toBe(editor.state.doc.content.size);
  });
});
