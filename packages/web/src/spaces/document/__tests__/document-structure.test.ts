// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * #123 验收 A1 / A3：无标题块的 `block*` 文档结构。
 * 权威定稿：文档结构决议（2026-08-17，私有工程文档）§6.1。
 *
 * TDD 红灯批次一：本文件在标题世界（`title block*`）下必须全红——
 * schema 里还有 title 节点、空 fragment 会被本地补上幻影标题、
 * 旧 title 元素被解析成 title 而不是兜底块。
 */

import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import * as Y from 'yjs';

import { documentBodyFragment } from '@breatic/shared';
import { buildDocumentExtensions } from '@web/spaces/document/document-extensions';

const editors: Editor[] = [];

afterEach(() => {
  editors.splice(0).forEach((e) => {
    e.destroy();
  });
});

function openOn(doc: Y.Doc): Editor {
  const editor = new Editor({
    extensions: buildDocumentExtensions({
      fragment: documentBodyFragment(doc),
    }),
  });
  editors.push(editor);
  return editor;
}

describe('A1 无标题块的 block* 结构', () => {
  it('schema 里不再注册 title 节点', () => {
    const e = openOn(new Y.Doc());
    expect(e.schema.nodes.title).toBeUndefined();
  });

  it('doc 的 content 规则允许零块', () => {
    const e = openOn(new Y.Doc());
    expect(e.schema.nodes.doc.spec.content).toBe('block*');
  });

  it('绑空 fragment 得到零块文档，没有本地幻影补块', () => {
    const e = openOn(new Y.Doc());
    expect(e.state.doc.childCount).toBe(0);
    expect(e.getHTML()).toBe('');
  });
});

describe('A3 存量文档的 title 元素走兜底块', () => {
  it('旧种子里的 title 元素显示为 unsupportedBlock、原始名保留', () => {
    const doc = new Y.Doc();
    const title = new Y.XmlElement('title');
    title.insert(0, [new Y.XmlText('Old document name')]);
    documentBodyFragment(doc).push([title]);

    const e = openOn(doc);
    expect(e.state.doc.childCount).toBe(1);
    expect(e.state.doc.child(0).type.name).toBe('unsupportedBlock');
    expect(e.state.doc.child(0).attrs.originalName).toBe('title');
  });
});
