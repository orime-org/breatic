// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * 「全部正文」这个选区要活过别人的一次编辑。
 *
 * 协作是这个编辑器的常态，不是边角情形：两个人开着同一份文档，一个人选中全部正文、
 * 另一个人敲一个字，第一个人的选区必须还是「全部正文」。
 *
 * 这条盯的是 `BodySelection` 在协作层的存活。`@tiptap/y-tiptap` 在每次 Yjs 侧变更时
 * 会拿变更前的选区做一次相对定位往返（`getRelativeSelection` 按
 * `state.selection.jsonID` 记类型，`restoreRelativeSelection` 按类型重建），而它只
 * 认得 `all` / `node` / `nodeRange` 三种，**其余一律重建成
 * `TextSelection.between`**（`y-tiptap.js:374`）。`TextSelection` 的端点必须落在
 * inline content 上，正是 `BodySelection` 存在的理由要绕开的那件事 —— 于是正文首尾
 * 那种放不进光标的块（分割线、`unsupportedBlock`）会被挤出选区。
 *
 * **判据用 `selection.toJSON().type`，不用 `instanceof BodySelection`。** 后者在这里
 * 问的是「是不是同一个类对象」，而那在浏览器里恒真、在这个测试进程里恒假：这个包一个
 * 进程跑完，文件之间重置模块注册表，所以我们的源码每个文件重新求值一份新的
 * `BodySelection` 类，而 `prosemirror-state` 的 `jsonID` 注册表在 node_modules 里不
 * 被重置、只认第一份。重建出来的是第一份类的实例，行为一模一样、类对象不同。
 * `type` 直接说「它仍然是一个 body 选区」，两种环境下都成立，而且照样测得出 patch
 * 有没有生效 —— 没生效就会是 `'text'`。
 */

import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import * as Y from 'yjs';
import { documentBodyFragment, encodeInitialSpaceContent } from '@breatic/shared';

import { buildDocumentExtensions } from '@web/spaces/document/document-extensions';
import { BODY_SELECTION_ID } from '@web/spaces/document/document-body-selection';

const editors: Editor[] = [];
const docs: Y.Doc[] = [];

afterEach(() => {
  editors.splice(0).forEach((e) => {
    e.destroy();
  });
  docs.splice(0).forEach((d) => {
    d.destroy();
  });
});

/**
 * 一个客户端：一份带服务端种子的 Yjs 文档 + 绑上去的编辑器。
 * @param seed - Space 建的时候后端写进去的字节。
 * @returns 这个客户端的文档和编辑器。
 */
function client(seed: Uint8Array): { doc: Y.Doc; editor: Editor } {
  const doc = new Y.Doc();
  docs.push(doc);
  Y.applyUpdate(doc, seed);
  const editor = new Editor({
    extensions: buildDocumentExtensions({ fragment: documentBodyFragment(doc) }),
  });
  editors.push(editor);
  return { doc, editor };
}

/**
 * 按一次 `Ctrl+A`，派真实的 DOM 事件。
 * @param editor - 收这个键的编辑器。
 */
function pressCtrlA(editor: Editor): void {
  editor.view.dom.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true, cancelable: true }),
  );
}

describe('别人编辑之后，「全部正文」还得是全部正文', () => {
  it('远端敲一个字，选区仍然是 BodySelection，末尾的分割线没掉出去', () => {
    const seed = encodeInitialSpaceContent('document', 'TITLE');
    const a = client(seed);
    const b = client(seed);
    // 正文末块是分割线 —— 那正是 TextSelection 装不下的形状。
    a.editor.commands.setContent('<h1 class="doc-title">TITLE</h1><p>first</p><p>second</p><hr>');
    Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc));

    // A 按两次：当前块 → 全部正文。
    const body = a.editor.state.doc;
    const pos = body.child(0).nodeSize;
    a.editor.view.dispatch(
      a.editor.state.tr.setSelection(TextSelection.create(body, pos + 1)),
    );
    pressCtrlA(a.editor);
    pressCtrlA(a.editor);
    expect(a.editor.state.selection.toJSON().type, '前提：按两次之后拿到的是 body 选区').toBe(
      BODY_SELECTION_ID,
    );
    const before = { from: a.editor.state.selection.from, to: a.editor.state.selection.to };
    expect(before.to).toBe(a.editor.state.doc.content.size);

    // B 在自己那边敲一个字，同步给 A。
    b.editor.commands.insertContentAt(b.editor.state.doc.content.size - 2, 'x');
    Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc));

    expect(
      a.editor.state.selection.toJSON().type,
      '别人编辑之后 A 的选区仍该是「全部正文」，不是一个向内收缩的文本选区',
    ).toBe(BODY_SELECTION_ID);
    expect(
      a.editor.state.selection.to,
      '末尾那条分割线不许掉出选区',
    ).toBe(a.editor.state.doc.content.size);
    expect(a.editor.state.selection.from).toBe(a.editor.state.doc.child(0).nodeSize);
  });

  it('远端删掉正文里的一块，选区跟着缩到新的正文范围，仍是 BodySelection', () => {
    const seed = encodeInitialSpaceContent('document', 'TITLE');
    const a = client(seed);
    const b = client(seed);
    a.editor.commands.setContent(
      '<h1 class="doc-title">TITLE</h1><p>first</p><p>second</p><p>third</p>',
    );
    Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc));

    const pos = a.editor.state.doc.child(0).nodeSize;
    a.editor.view.dispatch(
      a.editor.state.tr.setSelection(TextSelection.create(a.editor.state.doc, pos + 1)),
    );
    pressCtrlA(a.editor);
    pressCtrlA(a.editor);
    expect(a.editor.state.selection.toJSON().type).toBe(BODY_SELECTION_ID);

    // B 删掉最后一个段落。
    const bDoc = b.editor.state.doc;
    const lastStart = bDoc.content.size - bDoc.lastChild!.nodeSize;
    b.editor.view.dispatch(b.editor.state.tr.delete(lastStart, bDoc.content.size));
    Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc));

    expect(a.editor.state.selection.toJSON().type, '删掉一块之后仍该是「全部正文」').toBe(
      BODY_SELECTION_ID,
    );
    expect(a.editor.state.selection.from).toBe(a.editor.state.doc.child(0).nodeSize);
    expect(a.editor.state.selection.to).toBe(a.editor.state.doc.content.size);
  });

  it('远端把正文整个删空，不抛异常，选区落在一个合法位置上', () => {
    // 正文零块时没有任何可选的正文，文档里唯一能放光标的地方就是标题 —— 这是
    // 内容规则 `title block*` 决定的，不是选区逻辑的选择。要求只有两条：别抛
    // 异常，别留下一个非法选区。
    const seed = encodeInitialSpaceContent('document', 'TITLE');
    const a = client(seed);
    const b = client(seed);
    a.editor.commands.setContent('<h1 class="doc-title">TITLE</h1><p>only</p>');
    Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc));

    const pos = a.editor.state.doc.child(0).nodeSize;
    a.editor.view.dispatch(
      a.editor.state.tr.setSelection(TextSelection.create(a.editor.state.doc, pos + 1)),
    );
    pressCtrlA(a.editor);
    pressCtrlA(a.editor);
    expect(a.editor.state.selection.toJSON().type).toBe(BODY_SELECTION_ID);

    const bDoc = b.editor.state.doc;
    expect(() => {
      b.editor.view.dispatch(
        b.editor.state.tr.delete(bDoc.child(0).nodeSize, bDoc.content.size),
      );
      Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc));
    }).not.toThrow();

    const sel = a.editor.state.selection;
    expect(sel.from).toBeGreaterThanOrEqual(0);
    expect(sel.to).toBeLessThanOrEqual(a.editor.state.doc.content.size);
  });
});
