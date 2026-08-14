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
 * 键名确实是 `Mod-a`（见文件末尾那条），以及按下去之后选中什么。
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
 * 按一次 `Ctrl+A`。
 *
 * 走 `someProp` 而不是 `editor.commands`：命令那条路会另外 dispatch 一个从**运行前**
 * 的状态取来的事务，把处理器自己派发的东西盖掉（`document-title-keymap.test` 实测过）。
 * @param editor - 收这个键的编辑器。
 * @returns 这个键有没有被谁认领。
 */
function pressCtrlA(editor: Editor): boolean {
  let handled = false;
  editor.view.someProp('handleKeyDown', (f) => {
    // `handleKeyDown` 的签名是 `boolean | void`：没认领的处理器可以什么都不返回。
    handled = f(editor.view, new KeyboardEvent('keydown', { key: 'a', ctrlKey: true })) === true;
    return handled;
  });
  return handled;
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

  it('再按一次扩大到全部正文，仍然碰不到标题', () => {
    const editor = open('<p>first</p><p>second</p><p>third</p>');
    caretIn(editor, 2, 2);

    pressCtrlA(editor);
    pressCtrlA(editor);

    const all = selection(editor);
    expect(all.from).toBeGreaterThanOrEqual(titleSize(editor));
    expect(all.from).toBe(blockRange(editor, 1).from);
    expect(all.to).toBe(blockRange(editor, 3).to);
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
    expect(afterTwo.from).toBe(blockRange(editor, 1).from);
    expect(afterTwo.to).toBe(blockRange(editor, 2).to);
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

    expect(first).toEqual(blockRange(editor, 1));
    expect(selection(editor)).toEqual(first);
    expect(touchesTitle(editor)).toBe(false);
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
    expect(editor.state.selection.from).toBe(blockRange(editor, 1).from);
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

  it('正文零块时从「哪儿都不在」出发，不产生跨进标题的选区', () => {
    // AllSelection 是「哪儿都不在」的一种（`selectAll` 产出的就是它）。
    // 正文没有任何东西可选，唯一不许发生的是把标题圈进来。
    const editor = open('');
    editor.view.dispatch(
      editor.state.tr.setSelection(new AllSelection(editor.state.doc)),
    );

    expect(() => pressCtrlA(editor)).not.toThrow();

    expect(
      editor.state.selection.from >= titleSize(editor) ||
        editor.state.selection instanceof AllSelection,
      '正文零块时不许新造一个跨进标题的范围选区',
    ).toBe(true);
  });
});

describe('这个键永远由我们认领', () => {
  it('结果跟现状一样时也不把键交回去', () => {
    // 交回去就落到 @tiptap/core 自己那条 `Mod-a` → selectAll，实测它产出
    // AllSelection 0..9、标题在里面，正是这次要修的越界。
    const editor = open('<p>body</p>');
    caretIn(editor, 0, 1);
    pressCtrlA(editor);

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

describe('只读的人', () => {
  it('viewer 的分级跟 editor 完全一样', () => {
    // user 2026-08-14：Ctrl+A 不改变任何数据内容，所以角色不进这个判断。
    const editor = open('<p>first</p><p>second</p>');
    editor.setEditable(false);
    caretIn(editor, 2, 1);

    pressCtrlA(editor);
    expect(selection(editor)).toEqual(blockRange(editor, 2));

    pressCtrlA(editor);
    expect(selection(editor).from).toBe(blockRange(editor, 1).from);
    expect(touchesTitle(editor)).toBe(false);
  });
});
