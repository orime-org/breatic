// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * 「这份文档里有我解析不了的内容吗」——直接问 Yjs 文档，不经编辑器（验收 13）。
 *
 * 为什么不经编辑器：拦截状态成立时编辑器**根本不该被创建**（验收 14），
 * 所以判定必须能在建它之前做出来。它也因此不依赖 y-tiptap 的补丁行为——
 * 补丁管的是「收到之后不删」，这里管的是「知不知道自己收到了」。
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as Y from 'yjs';
import { documentBodyFragment } from '@breatic/shared';
import { DOCUMENT_SCHEMA } from '@breatic/shared';

import { findUnknownContent } from '@web/spaces/document/document-schema-guard';

const docs: Y.Doc[] = [];

afterEach(() => {
  docs.splice(0).forEach((d) => d.destroy());
});

/**
 * 造一份文档正文片段。
 * @returns 空的片段，以及它所属的文档。
 */
function fragment(): Y.XmlFragment {
  const doc = new Y.Doc();
  docs.push(doc);
  return documentBodyFragment(doc);
}

describe('全都认识时', () => {
  it('一份普通文档，什么都不报', () => {
    const body = fragment();
    const title = new Y.XmlElement('title');
    const para = new Y.XmlElement('paragraph');
    para.insert(0, [new Y.XmlText('hello')]);
    body.insert(0, [title, para]);

    expect(findUnknownContent(body, DOCUMENT_SCHEMA)).toEqual([]);
  });

  it('嵌套的块也不报', () => {
    const body = fragment();
    const quote = new Y.XmlElement('blockquote');
    const inner = new Y.XmlElement('paragraph');
    inner.insert(0, [new Y.XmlText('inside')]);
    quote.insert(0, [inner]);
    body.insert(0, [quote]);

    expect(findUnknownContent(body, DOCUMENT_SCHEMA)).toEqual([]);
  });

  it('认识的标记也不报，包括带 hash 的可重叠标记', () => {
    const body = fragment();
    const para = new Y.XmlElement('paragraph');
    const text = new Y.XmlText();
    text.insert(0, 'bold bit', { bold: {} });
    // y-tiptap 给可重叠标记的键加 hash，判定前必须剥掉。真键长这样：
    // 名字 + `--` + 正好 8 个 base64 字符（实测 `anno--/mqlLOIu`）。
    text.insert(8, ' linked', { 'link--Ab3+/x9=': { href: 'x' } });
    para.insert(0, [text]);
    body.insert(0, [para]);

    expect(findUnknownContent(body, DOCUMENT_SCHEMA)).toEqual([]);
  });
});

describe('有不认识的东西时', () => {
  it('顶层多一个不认识的块', () => {
    const body = fragment();
    body.insert(0, [new Y.XmlElement('paragraph'), new Y.XmlElement('taskList')]);

    expect(findUnknownContent(body, DOCUMENT_SCHEMA)).toEqual(['taskList']);
  });

  it('藏在嵌套里的也找得到', () => {
    const body = fragment();
    const quote = new Y.XmlElement('blockquote');
    quote.insert(0, [new Y.XmlElement('callout')]);
    body.insert(0, [quote]);

    expect(findUnknownContent(body, DOCUMENT_SCHEMA)).toEqual(['callout']);
  });

  it('段落里的行内元素也找得到', () => {
    const body = fragment();
    const para = new Y.XmlElement('paragraph');
    para.insert(0, [new Y.XmlText('before '), new Y.XmlElement('mention')]);
    body.insert(0, [para]);

    expect(findUnknownContent(body, DOCUMENT_SCHEMA)).toEqual(['mention']);
  });

  it('不认识的标记也算', () => {
    const body = fragment();
    const para = new Y.XmlElement('paragraph');
    const text = new Y.XmlText();
    text.insert(0, 'highlighted', { highlight: {} });
    para.insert(0, [text]);
    body.insert(0, [para]);

    expect(findUnknownContent(body, DOCUMENT_SCHEMA)).toEqual(['highlight']);
  });

  it('带 hash 的不认识标记，报的是剥掉 hash 之后的名字', () => {
    const body = fragment();
    const para = new Y.XmlElement('paragraph');
    const text = new Y.XmlText();
    text.insert(0, 'commented', { 'comment--9xYzQw1/': { id: 'c1' } });
    para.insert(0, [text]);
    body.insert(0, [para]);

    expect(findUnknownContent(body, DOCUMENT_SCHEMA)).toEqual(['comment']);
  });

  it('名字在 Object.prototype 上的，照样报不认识', () => {
    // 清单是个普通对象字面量，带着 Object.prototype。用 `in`
    // 问「认不认识」会让 toString / constructor 这些名字恒为真，而补丁
    // 那边问的是同一个问题、答案相反（prosemirror 的 schema.nodes 是
    // Object.create(null) 建的）—— 两边对同一份文档给出相反的结论。
    const body = fragment();
    body.insert(0, [new Y.XmlElement('toString')]);
    const para = new Y.XmlElement('paragraph');
    const text = new Y.XmlText();
    // 分开写：对象字面量里的 `constructor` 会被 TypeScript 当成
    // Object.prototype.constructor 那个签名去核对，塞不进去。
    const protoMark: Record<string, object> = { constructor: {} };
    text.insert(0, 'x', protoMark);
    para.insert(0, [text]);
    body.insert(1, [para]);

    expect(findUnknownContent(body, DOCUMENT_SCHEMA)).toEqual([
      'toString',
      'constructor',
    ]);
  });

  it('名字里带 `--` 但后缀不是 8 位 base64 的，不当 hash 剥', () => {
    // 剥的规则要跟 y-tiptap 逐字一致（它是 `/(.*)(--[a-zA-Z0-9+/=]{8})$/`）。
    // 无条件切在最后一个 `--` 会把这种名字剥成 `some`，报错报的就是别人的名字。
    const body = fragment();
    const para = new Y.XmlElement('paragraph');
    const text = new Y.XmlText();
    text.insert(0, 'x', { 'some--mark': {} });
    para.insert(0, [text]);
    body.insert(0, [para]);

    expect(findUnknownContent(body, DOCUMENT_SCHEMA)).toEqual(['some--mark']);
  });

  it('同一个名字出现多次只报一次，多个不同的都报', () => {
    const body = fragment();
    body.insert(0, [
      new Y.XmlElement('taskList'),
      new Y.XmlElement('taskList'),
      new Y.XmlElement('callout'),
    ]);

    expect(findUnknownContent(body, DOCUMENT_SCHEMA).sort()).toEqual([
      'callout',
      'taskList',
    ]);
  });
});

describe('兜底类型本身', () => {
  it('不算不认识的内容——它们就是用来装那些东西的', () => {
    const body = fragment();
    const fallback = new Y.XmlElement('unsupportedBlock');
    fallback.setAttribute('originalName', 'taskList');
    body.insert(0, [fallback]);

    // 兜底块在清单里，所以扫不出来。这一条不是漏检：一个客户端把内容
    // 包成了兜底块，说明它当时就已经知道自己不认识那个东西了。
    expect(findUnknownContent(body, DOCUMENT_SCHEMA)).toEqual([]);
  });
});
