// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * #123 验收 B1 / B2 / B3 / B4 / B5：两档 Ctrl+A 与全文档选区的按键行为。
 * 权威定稿 inner engineering/decisions/2026-08-17-document-structure-dd.md §10
 * 两张转移表；全文档删除走确认接缝（onClearDocumentRequest 回调 +
 * clearDocument 命令），确认对话框本体在组件层另测。
 *
 * TDD 红灯批次二：旧世界（标题块 + 按侧钳制）下本文件必须全红。
 * GapCursor 档的格子在实现阶段随 gapcursor 选区构造一起钉（本批不含）。
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { Editor } from '@tiptap/core';
import { AllSelection, NodeSelection, TextSelection } from '@tiptap/pm/state';
import * as Y from 'yjs';

import { documentBodyFragment } from '@breatic/shared';
import { buildDocumentExtensions } from '@web/spaces/document/document-extensions';

const editors: Editor[] = [];

afterEach(() => {
  editors.splice(0).forEach((e) => {
    e.destroy();
  });
});

function openOn(
  doc: Y.Doc,
  onClearDocumentRequest?: () => void,
): Editor {
  const editor = new Editor({
    extensions: buildDocumentExtensions({
      fragment: documentBodyFragment(doc),
      onClearDocumentRequest,
    }),
  });
  editors.push(editor);
  return editor;
}

function openWithBlocks(onClearDocumentRequest?: () => void): Editor {
  const e = openOn(new Y.Doc(), onClearDocumentRequest);
  e.commands.setContent('<p>alpha</p><p>beta</p><p>gamma</p>');
  return e;
}

function press(
  e: Editor,
  key: string,
  modifiers: { ctrlKey?: boolean } = {},
): void {
  const event = new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
    ...modifiers,
  });
  e.view.someProp('handleKeyDown', (f) => f(e.view, event));
}

/** jsdom 判成 pc 平台，Mod-a 即 Ctrl-a。 */
function pressSelectAll(e: Editor): void {
  press(e, 'a', { ctrlKey: true });
}

/** 把光标放进第 index 个块的文本里。 */
function caretIntoBlock(e: Editor, index: number): void {
  let pos = 0;
  for (let i = 0; i < index; i += 1) pos += e.state.doc.child(i).nodeSize;
  e.view.dispatch(
    e.state.tr.setSelection(TextSelection.create(e.state.doc, pos + 2)),
  );
}

/** 第 index 个块的文本范围 [from, to]。 */
function blockTextRange(e: Editor, index: number): { from: number; to: number } {
  let pos = 0;
  for (let i = 0; i < index; i += 1) pos += e.state.doc.child(i).nodeSize;
  const block = e.state.doc.child(index);
  return { from: pos + 1, to: pos + 1 + block.content.size };
}

describe('B1 两档 Ctrl+A', () => {
  it('光标在块内第一次按：选中当前块的全部文本', () => {
    const e = openWithBlocks();
    caretIntoBlock(e, 1);
    pressSelectAll(e);
    const { from, to } = blockTextRange(e, 1);
    expect(e.state.selection).toBeInstanceOf(TextSelection);
    expect(e.state.selection.from).toBe(from);
    expect(e.state.selection.to).toBe(to);
  });

  it('当前块已全选后第二次按：AllSelection 覆盖整个文档', () => {
    const e = openWithBlocks();
    caretIntoBlock(e, 1);
    pressSelectAll(e);
    pressSelectAll(e);
    expect(e.state.selection).toBeInstanceOf(AllSelection);
  });

  it('块内部分选区按一次：进第一档（当前块全选）', () => {
    const e = openWithBlocks();
    const { from } = blockTextRange(e, 1);
    e.view.dispatch(
      e.state.tr.setSelection(
        TextSelection.create(e.state.doc, from, from + 2),
      ),
    );
    pressSelectAll(e);
    const range = blockTextRange(e, 1);
    expect(e.state.selection.from).toBe(range.from);
    expect(e.state.selection.to).toBe(range.to);
  });

  it('跨块选区按一次：直接全选整个文档', () => {
    const e = openWithBlocks();
    const first = blockTextRange(e, 0);
    const second = blockTextRange(e, 1);
    e.view.dispatch(
      e.state.tr.setSelection(
        TextSelection.create(e.state.doc, first.from + 1, second.from + 1),
      ),
    );
    pressSelectAll(e);
    expect(e.state.selection).toBeInstanceOf(AllSelection);
  });

  it('全文档已选再按：不变', () => {
    const e = openWithBlocks();
    e.view.dispatch(e.state.tr.setSelection(new AllSelection(e.state.doc)));
    pressSelectAll(e);
    expect(e.state.selection).toBeInstanceOf(AllSelection);
    expect(e.state.doc.childCount).toBe(3);
  });

  it('零块文档按：空操作不抛', () => {
    const e = openOn(new Y.Doc());
    expect(() => {
      pressSelectAll(e);
    }).not.toThrow();
    expect(e.state.doc.childCount).toBe(0);
  });
});

describe('B3 全文档删除走确认接缝', () => {
  it.each(['Backspace', 'Delete'])(
    '全文档选区按 %s：只发确认请求，文档不动',
    (key) => {
      const onClear = vi.fn();
      const e = openWithBlocks(onClear);
      e.view.dispatch(e.state.tr.setSelection(new AllSelection(e.state.doc)));
      press(e, key);
      expect(onClear).toHaveBeenCalledTimes(1);
      expect(e.state.doc.childCount).toBe(3);
      expect(e.getHTML()).toContain('alpha');
    },
  );

  it('跨块（非全文档）选区按 Backspace：照常删除，不发确认请求', () => {
    const onClear = vi.fn();
    const e = openWithBlocks(onClear);
    const first = blockTextRange(e, 0);
    const second = blockTextRange(e, 1);
    e.view.dispatch(
      e.state.tr.setSelection(
        TextSelection.create(e.state.doc, first.from + 1, second.to - 1),
      ),
    );
    press(e, 'Backspace');
    expect(onClear).not.toHaveBeenCalled();
    expect(e.state.doc.textContent).not.toContain('beta');
  });

  it('clearDocument 命令：清空到零块，之后可再写', () => {
    const e = openWithBlocks();
    e.commands.clearDocument();
    expect(e.state.doc.childCount).toBe(0);
    e.commands.insertContent('again');
    expect(e.getHTML()).toBe('<p>again</p>');
  });
});

describe('B4 全文档回车：内容不动、文末追加空段落', () => {
  it('全选后按 Enter：三个块都在，第四个是空段落，光标落入', () => {
    const e = openWithBlocks();
    e.view.dispatch(e.state.tr.setSelection(new AllSelection(e.state.doc)));
    press(e, 'Enter');
    expect(e.state.doc.childCount).toBe(4);
    expect(e.getHTML()).toContain('alpha');
    expect(e.getHTML()).toContain('gamma');
    const last = e.state.doc.child(3);
    expect(last.type.name).toBe('paragraph');
    expect(last.content.size).toBe(0);
    expect(e.state.selection.empty).toBe(true);
    expect(e.state.selection.from).toBe(e.state.doc.content.size - 1);
  });
});

describe('B2 全文档选区打字：替换为单段', () => {
  it('全选后插入字符：全文被替换成一个段落', () => {
    const e = openWithBlocks();
    e.view.dispatch(e.state.tr.setSelection(new AllSelection(e.state.doc)));
    e.commands.insertContent('x');
    expect(e.state.doc.childCount).toBe(1);
    expect(e.getHTML()).toBe('<p>x</p>');
  });
});

describe('B5 零块选区归一守卫', () => {
  it('零块文档：指向 doc 层的退化 TextSelection 被归一为 AllSelection', () => {
    const e = openOn(new Y.Doc());
    expect(e.state.doc.childCount).toBe(0);
    e.view.dispatch(
      e.state.tr.setSelection(Selection0(e)),
    );
    expect(e.state.selection).toBeInstanceOf(AllSelection);
  });

  it('空文档的静息 AllSelection 在内容到达后收拢成文首光标', () => {
    // AllSelection 经映射永远还是全文档——不收拢的话，空文档里静息的它
    // 会在协作者的第一段内容到达时静默变成「全选了那段内容」。
    const e = openOn(new Y.Doc());
    expect(e.state.selection).toBeInstanceOf(AllSelection);
    e.commands.setContent('<p>arrived</p>');
    expect(e.state.selection).not.toBeInstanceOf(AllSelection);
    expect(e.state.selection.empty).toBe(true);
    expect(e.state.selection.$from.parent.isTextblock).toBe(true);
  });

  it('有内容的文档：退化 TextSelection 归一到最近光标位，不升格成全选', () => {
    // 升格会把「什么都没选」翻成「全选」——下一记 Backspace 就误触
    // 整篇删除的确认框（setContent 后的残留选区实测踩过这一步）。
    const e = openWithBlocks();
    e.view.dispatch(e.state.tr.setSelection(Selection0(e)));
    expect(e.state.selection).toBeInstanceOf(TextSelection);
    expect(e.state.selection.empty).toBe(true);
    expect(e.state.selection.$from.parent.isTextblock).toBe(true);
  });
});

describe('B1 NodeSelection 档（兜底块被整体选中时）', () => {
  it('NodeSelection 上按 Ctrl+A：全选整个文档', () => {
    const doc = new Y.Doc();
    const title = new Y.XmlElement('title');
    title.insert(0, [new Y.XmlText('old')]);
    documentBodyFragment(doc).push([title]);
    const e = openOn(doc);
    e.commands.insertContent('after');
    e.view.dispatch(
      e.state.tr.setSelection(NodeSelection.create(e.state.doc, 0)),
    );
    pressSelectAll(e);
    expect(e.state.selection).toBeInstanceOf(AllSelection);
  });
});

/**
 * 造一个指向 doc 层位置 0 的退化 TextSelection——E2a 告警与 E4c 残留
 * 的形态（零块文档里没有任何文本位置，TextSelection 指到 doc 上）。
 * @param e - 零块编辑器。
 * @returns 那个退化选区。
 */
function Selection0(e: Editor): TextSelection {
  return new TextSelection(e.state.doc.resolve(0));
}
