// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * `document-split-block.ts` 存在的前提：tiptap 自带的 `splitBlock` 在跨两个
 * 列表项的选区上会抛。这份测试跑的就是 tiptap 自带的那份实现（把我们的替换
 * 扩展滤掉），断言它**还在抛**。
 *
 * **这条红了是好消息**：说明上游把 ueberdosis/tiptap#7734 修了。那时候去看
 * 上游合的是什么——`document-split-block.ts` 文件头写着，#7990 那种只挪
 * `canSplit` 的修法产出跟浏览器不一致——确认无误后删掉我们的替换和这份
 * 测试。在那之前，这条绿着就证明替换还有存在的理由。
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

/** 一份滤掉了 DocumentSplitBlock 的编辑器——回车走 tiptap 自带的 splitBlock。 */
function openStock(bodyHtml: string): Editor {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, encodeInitialSpaceContent('document'));
  const all = buildDocumentExtensions({ fragment: documentBodyFragment(doc) });
  const editor = new Editor({
    extensions: all.filter((x) => (x as { name?: string }).name !== 'documentSplitBlock'),
  });
  editors.push(editor);
  editor.commands.setContent(bodyHtml);
  return editor;
}

/** 真实按键路径。 */
function press(e: Editor, key: string): void {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  e.view.someProp('handleKeyDown', (f) => f(e.view, event));
}

/** 选中正文里第 first 到第 last 个文本节点之间那一段（含两端）。 */
function selectText(e: Editor, first: number, last: number): void {
  const positions: Array<{ pos: number; size: number }> = [];
  e.state.doc.descendants((node, pos) => {
    if (node.isText) positions.push({ pos, size: node.nodeSize });
  });
  const a = positions[first];
  const b = positions[last];
  e.view.dispatch(
    e.state.tr.setSelection(
      TextSelection.between(e.state.doc.resolve(a.pos), e.state.doc.resolve(b.pos + b.size)),
    ),
  );
}

describe('上游的 splitBlock 还坏着吗（红了 = 上游修了，去看 document-split-block.ts 文件头）', () => {
  it.each([
    ['无序列表', '<p>x</p><ul><li><p>aa</p></li><li><p>bb</p></li></ul><p>y</p>'],
    ['有序列表', '<p>x</p><ol><li><p>aa</p></li><li><p>bb</p></li></ol><p>y</p>'],
  ])('拖过两个%s项按回车，tiptap 自带实现仍抛 TransformError', (_name, html) => {
    const e = openStock(html);
    selectText(e, 1, 2);
    expect(() => {
      press(e, 'Enter');
    }).toThrow(/Inserted content deeper than insertion position/);
  });
});
