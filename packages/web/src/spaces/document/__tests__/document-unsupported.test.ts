// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * 三个兜底类型的 spec（验收 1）。
 *
 * 它们必须**在上线之前**就进 schema：只有所有版本都带着它们，补丁才有东西
 * 可以拿来承载看不懂的内容。等到出问题那天再加，已经开着的旧标签页连
 * `unsupportedBlock` 这个名字都不认识，问题原样复发。
 *
 * 从真实 schema 里读，而不是读扩展定义 —— 这样同时验证它们真的被注册进去了。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Editor, getSchema } from '@tiptap/core';
import type { Schema } from '@tiptap/pm/model';
import * as Y from 'yjs';

import { getLocale, setLocale, t } from '@breatic/shared';
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

describe('兜底节点在屏幕上是可见的占位，标签跟随语言（H 组 smoke + 实现对抗第 1 轮 #3）', () => {
  // 标签走 decoration + CSS attr()，不烤进 renderHTML：节点 DOM 只在节点
  // 自己变化时重画，切语言不重画它——decoration 每次 dispatch 重算，
  // LocaleRedraw 的空 dispatch 正好触发（跟空态占位同一套机制）。
  const liveEditors: Editor[] = [];
  let originalLocale: ReturnType<typeof getLocale>;

  beforeEach(() => {
    originalLocale = getLocale();
  });
  afterEach(() => {
    setLocale(originalLocale);
    liveEditors.splice(0).forEach((e) => e.destroy());
  });

  /**
   * 一个共享文档里躺着一个陌生元素的活编辑器。
   * @param elementName - 那个陌生元素的名字。
   * @param inline - 造行内形态（包在段落里）还是块级形态。
   * @returns 编辑器。
   */
  function openWithUnknown(elementName: string, inline = false): Editor {
    const doc = new Y.Doc();
    doc.transact(() => {
      const body = doc.getXmlFragment('body');
      if (inline) {
        const para = new Y.XmlElement('paragraph');
        para.insert(0, [new Y.XmlText('before '), new Y.XmlElement(elementName)]);
        body.insert(0, [para]);
      } else {
        body.insert(0, [new Y.XmlElement(elementName)]);
      }
    });
    const editor = new Editor({
      extensions: buildDocumentExtensions({
        fragment: doc.getXmlFragment('body'),
        caretProvider: null,
        undoManager: undefined,
        resolveCollaboratorName: () => null,
      }),
    });
    liveEditors.push(editor);
    return editor;
  }

  it('块级兜底的 DOM 带着本地化标签', () => {
    setLocale('zh-CN');
    const editor = openWithUnknown('title');
    const el = editor.view.dom.querySelector('[data-unsupported-block]');
    expect(el).not.toBeNull();
    expect(el?.getAttribute('data-label')).toBe(t('spaces.document.unsupported.label'));
    expect(el?.getAttribute('data-original-name')).toBe('title');
  });

  it('行内兜底带着同一个标签', () => {
    setLocale('zh-CN');
    const editor = openWithUnknown('mentionish', true);
    const el = editor.view.dom.querySelector('[data-unsupported-inline]');
    expect(el).not.toBeNull();
    expect(el?.getAttribute('data-label')).toBe(t('spaces.document.unsupported.label'));
  });

  it('切换语言后标签跟上，不冻结在绘制那一刻', async () => {
    setLocale('zh-CN');
    const editor = openWithUnknown('title');
    // LocaleRedraw 在 'create' 事件里订阅，而 tiptap v3 把 'create' 推迟到
    // setTimeout(0)——先等订阅落地，再切语言（真实使用里这个窗口只有一拍，
    // 且错过的切换会被下一次切换补上）。
    await new Promise((resolve) => setTimeout(resolve, 0));
    const before = editor.view.dom
      .querySelector('[data-unsupported-block]')
      ?.getAttribute('data-label');
    setLocale('ja');
    await new Promise((resolve) => setTimeout(resolve, 20));
    const after = editor.view.dom
      .querySelector('[data-unsupported-block]')
      ?.getAttribute('data-label');
    expect(before).not.toBe(after);
    expect(after).toBe(t('spaces.document.unsupported.label'));
  });
});
