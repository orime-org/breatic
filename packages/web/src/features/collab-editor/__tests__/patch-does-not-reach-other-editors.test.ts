// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * y-tiptap 的补丁是**包级**的：画布的文本节点和生成面板的 prompt 编辑器
 * 用的是同一个 y-tiptap，所以它也作用在它们身上（验收 22）。
 *
 * 而设计说这次不碰它们。这条测试把「不碰」钉住 —— 判据是补丁自己的那道门：
 * 它只有在 schema 里**存在**兜底类型时才改变行为，而兜底类型只注册进了
 * document space 的扩展。所以对另外两个编辑器，补丁走的是 y-tiptap 原来
 * 那条路，行为跟打补丁之前一模一样。
 *
 * 这里同时验两件事，缺一不可：那两个编辑器的 schema 里确实没有兜底类型
 * （门关着），以及它们遇到不认识的内容时确实还是原行为（门关着的后果）。
 */

import { describe, it, expect, afterEach } from 'vitest';
import { Editor, Node as TiptapNode } from '@tiptap/core';
import { getSchema } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import Collaboration from '@tiptap/extension-collaboration';
import * as Y from 'yjs';

import { buildCollabExtensions } from '@web/features/collab-editor/collab-extensions';

const editors: Editor[] = [];
const docs: Y.Doc[] = [];

afterEach(() => {
  editors.splice(0).forEach((e) => {
    try {
      e.destroy();
    } catch {
      // 已销毁的忽略
    }
  });
  docs.splice(0).forEach((d) => d.destroy());
});

/** 只有「新版本」认识的块。 */
const Callout = TiptapNode.create({
  name: 'callout',
  group: 'block',
  content: 'block+',
  parseHTML: () => [{ tag: 'div[data-callout]' }],
  renderHTML: () => ['div', { 'data-callout': '' }, 0],
});

describe('共用的协作扩展本身不带兜底类型', () => {
  it('`buildCollabExtensions` 一个兜底类型都不贡献', () => {
    const doc = new Y.Doc();
    docs.push(doc);
    const schema = getSchema([
      Document,
      Paragraph,
      Text,
      ...buildCollabExtensions({
        fragment: doc.getXmlFragment('body'),
        caretProvider: null,
      }),
    ]);

    expect(schema.nodes.unsupportedBlock).toBeUndefined();
    expect(schema.nodes.unsupportedInline).toBeUndefined();
    expect(schema.marks.unsupportedMark).toBeUndefined();
  });
});

describe('没有兜底类型的编辑器，行为跟打补丁之前一样', () => {
  it('遇到不认识的块，照旧把它从共享文档里删掉', () => {
    const freshDoc = new Y.Doc();
    const staleDoc = new Y.Doc();
    docs.push(freshDoc, staleDoc);

    /**
     * 建一个不带兜底类型的编辑器（画布文本节点和 prompt 编辑器就是这个形状）。
     * @param doc - 绑定的文档。
     * @param extra - 这一版多出来的扩展。
     * @returns 编辑器。
     */
    const make = (doc: Y.Doc, extra: typeof Callout[] = []): Editor => {
      const editor = new Editor({
        extensions: [
          Document,
          Paragraph,
          Text,
          ...extra,
          Collaboration.configure({ fragment: doc.getXmlFragment('body') }),
        ],
      });
      editors.push(editor);
      return editor;
    };

    const fresh = make(freshDoc, [Callout]);
    fresh.commands.setContent('<p>a</p><div data-callout><p>x</p></div><p>b</p>');

    make(staleDoc);
    Y.applyUpdate(staleDoc, Y.encodeStateAsUpdate(freshDoc));

    // 上游原本的处置：它从共享文档里消失。这是我们**接受**的现状，
    // 不是遗漏 —— 这次的范围只有 document space 正文。
    expect(staleDoc.getXmlFragment('body').toString()).not.toContain('<callout>');
    expect(staleDoc.getXmlFragment('body').toString()).toContain('<paragraph>');
  });
});
