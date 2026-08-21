// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { documentBodyFragment, encodeInitialSpaceContent } from '@breatic/shared';
import { Editor } from '@tiptap/react';
import { buildDocumentExtensions } from '@web/spaces/document/document-extensions';
import { hasTextIn } from '@web/spaces/document/SelectionBubbleBar';

/**
 * `isWarranted` 判「选区里有没有文字」用的是 `hasTextIn`，而它替换掉的是
 * `doc.textBetween(from, to).length > 0`。换掉的理由是后者要把整个选区构成
 * 字符串，而这个判断跑在每一个鼠标事件上——全选时那就是整篇文档。
 *
 * 换之前先证明两者答案一样：十种文档结构，每一对 (from, to) 全量比对，不抽样。
 */
describe('hasTextIn 跟 textBetween 逐位置比对', () => {
  it.each([
    ['<p>hello world</p>'],
    ['<p></p>'],
    ['<p></p><p></p>'],
    ['<p>a</p><p></p><p>b</p>'],
    ['<blockquote><p>quoted</p></blockquote>'],
    ['<ul><li><p>item</p></li></ul>'],
    ['<p><strong>bold</strong></p>'],
    ['<p>a<strong>b</strong>c</p>'],
    ['<pre><code>code</code></pre>'],
    ['<p>前后都是中文</p>'],
  ])('%s 的每一对 (from,to) 两者答案一致', (html) => {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, encodeInitialSpaceContent('document'));
    const editor = new Editor({
      extensions: buildDocumentExtensions({ fragment: documentBodyFragment(doc) }),
    });
    editor.commands.setContent(html);
    const d = editor.state.doc;
    const size = d.content.size;
    const mismatches: string[] = [];
    for (let from = 0; from <= size; from += 1) {
      for (let to = from; to <= size; to += 1) {
        const viaText = d.textBetween(from, to).length > 0;
        const viaWalk = hasTextIn(d, from, to);
        if (viaText !== viaWalk) {
          mismatches.push(`${from}..${to}: textBetween=${viaText} walk=${viaWalk} text=${JSON.stringify(d.textBetween(from, to))}`);
        }
      }
    }
    editor.destroy();
    doc.destroy();
    expect(mismatches).toEqual([]);
  });
});
