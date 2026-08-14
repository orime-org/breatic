// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * `BodySelection` 自己那几个方法。
 *
 * Gate 2 用变异实测过：这个类除了构造函数以外零行为覆盖 —— `map` / `eq` /
 * `toJSON` / `fromJSON` / jsonID 注册五个变异全部不红。这份补上。
 *
 * 判据一律走 `toJSON().type` 而不是 `instanceof`，理由跟
 * `select-all-survives-collaboration.test.ts` 文件头写的那条一样：这个包一个进程跑完
 * 且文件之间重置模块注册表，`instanceof` 问的是「是不是同一个类对象」，那在浏览器里
 * 恒真、在这里取决于哪个文件先跑。
 */

import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import { Selection, TextSelection } from '@tiptap/pm/state';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import * as Y from 'yjs';
import { documentBodyFragment, encodeInitialSpaceContent } from '@breatic/shared';

import { buildDocumentExtensions } from '@web/spaces/document/document-extensions';
import { BodySelection } from '@web/spaces/document/document-body-selection';

const editors: Editor[] = [];

afterEach(() => {
  editors.splice(0).forEach((e) => {
    e.destroy();
  });
});

/**
 * 一份带标题和给定正文的文档。
 * @param bodyHtml - 标题之后的正文 HTML，空串就是正文零块。
 * @returns 那份文档。
 */
function doc(bodyHtml = ''): ProseMirrorNode {
  const ydoc = new Y.Doc();
  Y.applyUpdate(ydoc, encodeInitialSpaceContent('document', 'TITLE'));
  const editor = new Editor({
    extensions: buildDocumentExtensions({ fragment: documentBodyFragment(ydoc) }),
  });
  editors.push(editor);
  if (bodyHtml) editor.commands.setContent(`<h1 class="doc-title">TITLE</h1>${bodyHtml}`);
  return editor.state.doc;
}

/** 正文起点 —— 标题占的位置数。 */
function bodyStart(d: ProseMirrorNode): number {
  return d.child(0).nodeSize;
}

describe('范围是从文档算出来的，不是存下来的', () => {
  it('构造出来就覆盖标题之后的全部内容', () => {
    const d = doc('<p>one</p><hr>');
    const sel = new BodySelection(d);

    expect(sel.from).toBe(bodyStart(d));
    expect(sel.to).toBe(d.content.size);
  });

  it('map 换一份更长的文档，范围跟着变成那份的正文', () => {
    const short = doc('<p>one</p>');
    const long = doc('<p>one</p><p>two</p><p>three</p>');
    const sel = new BodySelection(short);

    const mapped = sel.map(long);

    expect(mapped.toJSON().type).toBe('body');
    expect(mapped.from).toBe(bodyStart(long));
    expect(mapped.to).toBe(long.content.size);
  });

  it('fromJSON 同样按给它的那份文档算，不看存下来的坐标', () => {
    const d = doc('<p>one</p><p>two</p>');

    const restored = Selection.fromJSON(d, { type: 'body', anchor: 999, head: -5 });

    expect(restored.toJSON().type).toBe('body');
    expect(restored.from).toBe(bodyStart(d));
    expect(restored.to).toBe(d.content.size);
  });
});

describe('正文一个块都没有的时候', () => {
  it('hasBody 答 false', () => {
    expect(BodySelection.hasBody(doc())).toBe(false);
    expect(BodySelection.hasBody(doc('<p>one</p>'))).toBe(true);
  });

  it('of 不返回 body 选区，而是一个合法的选区', () => {
    const d = doc();

    const sel = BodySelection.of(d);

    expect(sel.toJSON().type).not.toBe('body');
    expect(sel.from).toBeGreaterThanOrEqual(0);
    expect(sel.to).toBeLessThanOrEqual(d.content.size);
  });

  it('map 到一份空正文的文档上，同样退回合法选区', () => {
    const sel = new BodySelection(doc('<p>one</p>'));

    const mapped = sel.map(doc());

    expect(mapped.toJSON().type).not.toBe('body');
  });
});

describe('相等判定', () => {
  it('同一份文档的两个 body 选区相等', () => {
    const d = doc('<p>one</p>');

    expect(new BodySelection(d).eq(new BodySelection(d))).toBe(true);
  });

  it('跟同范围的文本选区不相等', () => {
    const d = doc('<p>one</p>');
    const text = TextSelection.create(d, bodyStart(d) + 1, d.content.size - 1);

    expect(new BodySelection(d).eq(text)).toBe(false);
  });

  it('范围不同的两个 body 选区不相等', () => {
    const short = doc('<p>one</p>');
    const long = doc('<p>one</p><p>two</p>');

    expect(new BodySelection(short).eq(new BodySelection(long))).toBe(false);
  });
});

describe('序列化', () => {
  it('toJSON 只写类型，不写坐标', () => {
    const d = doc('<p>one</p>');

    expect(new BodySelection(d).toJSON()).toEqual({ type: 'body' });
  });

  it('这个类型名注册过了，Selection.fromJSON 认得它', () => {
    const d = doc('<p>one</p>');

    // 注册没生效的话这里会抛 RangeError（"No selection type body defined"）。
    expect(() => Selection.fromJSON(d, { type: 'body' })).not.toThrow();
  });

  it('实例带着 jsonID，y-tiptap 靠这个属性认出该怎么重建', () => {
    // 这条盯的是重复注册被拒之后仍然补上 prototype 那一步：少了它，第二个测试
    // 文件起的实例就没有 jsonID，协作那条路会静默退回 TextSelection。
    //
    // ⚠️ **单跑这个文件时它恒绿，测不出任何东西。** 单跑时这个模块是第一次求值，
    // `Selection.jsonID` 注册成功、prototype 由库自己写上，那段 catch 根本不执行。
    // 只有跟别的文件一起跑、且本文件不是第一个求值它的，才走得到补写那条路。
    // 变异实测：去掉补写那一行，单跑 12 条全绿，`vitest run src/spaces/document/`
    // 跑全量则这一条红。所以要验它，跑目录、别跑单文件。
    const sel = new BodySelection(doc('<p>one</p>'));

    expect((sel as unknown as { jsonID?: string }).jsonID).toBe('body');
  });
});
