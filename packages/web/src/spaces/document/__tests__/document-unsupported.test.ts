// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * 三个兜底类型的 spec（验收 1）。
 *
 * 它们必须**在上线之前**就进 schema：只有所有版本都带着它们，补丁才有东西
 * 可以拿来承载看不懂的内容。等到出问题那天再加，已经开着的旧标签页连
 * `unsupportedBlock` 这个名字都不认识，问题原样复发。
 *
 * 从真实 schema 里读，而不是读扩展定义 —— 这样同时验证它们真的被注册进去了。
 */

import { describe, it, expect } from 'vitest';
import { getSchema } from '@tiptap/core';
import type { Schema } from '@tiptap/pm/model';
import * as Y from 'yjs';

import { buildDocumentExtensions } from '@web/spaces/document/document-extensions';

/**
 * 建一份真实 schema。
 * @returns 编辑器实际会用的 schema。
 */
function realSchema(): Schema {
  const doc = new Y.Doc();
  try {
    return getSchema(
      buildDocumentExtensions({
        fragment: doc.getXmlFragment('body'),
        caretProvider: null,
        undoManager: undefined,
        resolveCollaboratorName: () => null,
      }),
    );
  } finally {
    doc.destroy();
  }
}

describe('兜底块 unsupportedBlock', () => {
  it('是块级的原子节点，可以被选中', () => {
    const type = realSchema().nodes.unsupportedBlock;
    expect(type).toBeDefined();
    expect(type.spec.group).toContain('block');
    expect(type.isAtom).toBe(true);
    expect(type.spec.selectable).toBe(true);
  });

  it('记得住原来那个名字', () => {
    const type = realSchema().nodes.unsupportedBlock;
    expect(Object.keys(type.spec.attrs ?? {})).toEqual(['originalName']);
    expect(type.create({ originalName: 'taskList' }).attrs.originalName).toBe('taskList');
  });

  it('能待在正文里放块的位置', () => {
    const schema = realSchema();
    const node = schema.nodes.unsupportedBlock.create({ originalName: 'x' });
    // doc 的 content 是 `block*`，块位置收得下它。
    expect(schema.nodes.doc.contentMatch.matchType(node.type)).not.toBeNull();
    expect(
      schema.nodes.blockquote.contentMatch.matchType(node.type),
    ).not.toBeNull();
  });
});

describe('兜底行内 unsupportedInline', () => {
  it('是行内的原子节点', () => {
    const type = realSchema().nodes.unsupportedInline;
    expect(type).toBeDefined();
    expect(type.isInline).toBe(true);
    expect(type.isAtom).toBe(true);
  });

  it('记得住原来那个名字', () => {
    const type = realSchema().nodes.unsupportedInline;
    expect(Object.keys(type.spec.attrs ?? {})).toEqual(['originalName']);
  });

  it('能待在段落里', () => {
    const schema = realSchema();
    const node = schema.nodes.unsupportedInline.create({ originalName: 'mention' });
    expect(schema.nodes.paragraph.contentMatch.matchType(node.type)).not.toBeNull();
  });
});

describe('兜底标记 unsupportedMark', () => {
  it('可以跟别的标记、以及自己的另一个实例同时挂在一段文字上', () => {
    const type = realSchema().marks.unsupportedMark;
    expect(type).toBeDefined();
    // `excludes: ''` 表示它谁都不排斥，包括它自己。
    expect(type.excludes(type)).toBe(false);
  });

  it('记得住原来的键和原来的值', () => {
    const type = realSchema().marks.unsupportedMark;
    expect(Object.keys(type.spec.attrs ?? {}).sort()).toEqual([
      'originalName',
      'originalValue',
    ]);
    const mark = type.create({ originalName: 'comment', originalValue: { id: 'c1' } });
    expect(mark.attrs.originalName).toBe('comment');
    expect(mark.attrs.originalValue).toEqual({ id: 'c1' });
  });

  it('同一段文字上挂两个不同的它，两个都留得住', () => {
    const schema = realSchema();
    const type = schema.marks.unsupportedMark;
    const first = type.create({ originalName: 'comment', originalValue: 1 });
    const second = type.create({ originalName: 'highlight', originalValue: 2 });
    const both = second.addToSet([first]);
    expect(both).toHaveLength(2);
  });
});
