// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * 分级 `Ctrl+A`：标题和正文互不越界。
 *
 * 规则是 user 2026-08-11 拍定的（inner 的菜单体系定稿 §3.1.1）：正文里按一次选当前
 * 这一块、再按一次选全部正文；标题上只选标题、再按不扩大；光标哪儿都不在时选全部正文。
 * 核心一句是**从正文出发永远选不到标题，从标题出发永远选不到正文**。
 *
 * 这里跑的是 `Ctrl-a` 那一路。mac 的 `Cmd-a` 在
 * `document-select-all-mac.test.ts` 里 —— `prosemirror-keymap` 在模块加载时按
 * `navigator.platform` 把 `Mod-` 定死成其中一个，jsdom 那个值是空串，所以两条路
 * 没法在同一个文件里都跑到。
 */

import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import { GapCursor } from '@tiptap/pm/gapcursor';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import type { ResolvedPos } from '@tiptap/pm/model';
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
    handled = f(editor.view, new KeyboardEvent('keydown', { key: 'a', ctrlKey: true }));
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

/** 选区跟标题有没有重叠 —— 互不越界那条的判据。 */
function touchesTitle(editor: Editor): boolean {
  return editor.state.selection.from < titleSize(editor);
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
  it('GapCursor 停在正文最前那条分割线旁边时，给全部正文', () => {
    // 合法的 GapCursor 位置实测过：atom 块紧贴文档或容器边界时才有，
    // 两个段落之间一个都没有（设计文档 §9.3）。
    const editor = open('<hr><p>after</p>');
    const reaches = GapCursor as unknown as { valid(pos: ResolvedPos): boolean };
    const $gap = editor.state.doc.resolve(titleSize(editor) + 1);
    expect(reaches.valid($gap), '这个位置本该是合法的 GapCursor').toBe(true);
    editor.view.dispatch(editor.state.tr.setSelection(new GapCursor($gap)));

    pressCtrlA(editor);

    expect(touchesTitle(editor)).toBe(false);
    expect(editor.state.selection.to).toBe(editor.state.doc.content.size);
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
  it('按下不抛异常，选区不与标题相交', () => {
    const editor = open('');
    expect(editor.state.doc.childCount, '这份文档本该只有标题').toBe(1);
    caretIn(editor, 0, 1);

    expect(() => pressCtrlA(editor)).not.toThrow();

    // 正文没有任何东西可选，唯一不许发生的是把标题选进来。
    expect(editor.state.selection.from).toBeGreaterThanOrEqual(0);
    expect(
      editor.state.selection.from >= titleSize(editor) ||
        editor.state.selection.empty,
      '正文零块时不许产生一个跨进标题的范围选区',
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
    expect(touchesTitle(editor)).toBe(false);
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
