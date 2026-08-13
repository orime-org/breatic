// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * 打过补丁的 y-tiptap 收到看不懂的东西时的行为（验收 2 到 7）。
 *
 * 两个客户端，一个的扩展集比另一个多——那就是「跑着新版本的人」和「标签页
 * 一直没关的人」之间的全部差别。兜底类型 import 的是真实的那三个定义，
 * 其余用最小 schema 造，这样能精确造出每一类漂移。
 *
 * 补丁本身是包级的：它对哪个编辑器都一样，所以这里测的是它的行为，不是
 * document space 那份具体的 schema。
 */

import { describe, it, expect, afterEach } from 'vitest';
import { Editor, Node as TiptapNode, Mark as TiptapMark } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import Collaboration from '@tiptap/extension-collaboration';
import type { Extensions } from '@tiptap/core';
import * as Y from 'yjs';

import {
  UnsupportedBlock,
  UnsupportedInline,
  UnsupportedMark,
} from '@web/spaces/document/document-unsupported';

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

/** 只有新版本认识的块级节点。 */
const Callout = TiptapNode.create({
  name: 'callout',
  group: 'block',
  content: 'block+',
  parseHTML: () => [{ tag: 'div[data-callout]' }],
  renderHTML: () => ['div', { 'data-callout': '' }, 0],
});

/** 只有新版本认识的行内节点。 */
const Mention = TiptapNode.create({
  name: 'mention',
  group: 'inline',
  inline: true,
  atom: true,
  addAttributes: () => ({
    label: {
      default: null,
      parseHTML: (element: HTMLElement) => element.getAttribute('data-label'),
      renderHTML: (attrs: Record<string, unknown>) => ({ 'data-label': attrs.label }),
    },
  }),
  parseHTML: () => [{ tag: 'span[data-mention]' }],
  renderHTML: ({ HTMLAttributes }) => ['span', { 'data-mention': '', ...HTMLAttributes }],
});

/** 只有新版本认识的标记（互斥型，键就是它的名字）。 */
const Highlight = TiptapMark.create({
  name: 'highlight',
  parseHTML: () => [{ tag: 'mark' }],
  renderHTML: () => ['mark', 0],
});

/** 两个版本都认识的可重叠标记——它的键带 hash。 */
const Anno = TiptapMark.create({
  name: 'anno',
  excludes: '',
  addAttributes: () => ({
    id: {
      default: null,
      parseHTML: (element: HTMLElement) => element.getAttribute('data-anno'),
      renderHTML: (attrs: Record<string, unknown>) => ({ 'data-anno': attrs.id }),
    },
  }),
  parseHTML: () => [{ tag: 'span[data-anno]' }],
  renderHTML: ({ HTMLAttributes }) => ['span', HTMLAttributes, 0],
});

/** 内容规则是 `block+`，空了就不合法——用来造「同版本也会撞上」的那种失败。 */
const Blockquote = TiptapNode.create({
  name: 'blockquote',
  group: 'block',
  content: 'block+',
  parseHTML: () => [{ tag: 'blockquote' }],
  renderHTML: () => ['blockquote', 0],
});

/** 两个版本都有的那部分。 */
const COMMON: Extensions = [
  Document,
  Paragraph,
  Text,
  Blockquote,
  Anno,
  UnsupportedBlock,
  UnsupportedInline,
  UnsupportedMark,
];

/**
 * 建一个绑在给定文档上的编辑器。
 * @param doc - 它的 Yjs 文档。
 * @param extra - 这一版比公共部分多出来的扩展。
 * @returns 编辑器。
 */
function makeEditor(doc: Y.Doc, extra: Extensions = []): Editor {
  const editor = new Editor({
    extensions: [
      ...COMMON,
      ...extra,
      Collaboration.configure({ fragment: doc.getXmlFragment('body') }),
    ],
  });
  editors.push(editor);
  return editor;
}

/**
 * 建一对客户端：新的认识 `extra` 里那些，旧的不认识。
 * @param extra - 只有新版本有的扩展。
 * @param html - 新版本先写进去的内容。
 * @returns 两边的编辑器和文档。
 */
function pair(
  extra: Extensions,
  html: string,
): { fresh: Editor; stale: Editor; freshDoc: Y.Doc; staleDoc: Y.Doc } {
  const freshDoc = new Y.Doc();
  const staleDoc = new Y.Doc();
  docs.push(freshDoc, staleDoc);

  const fresh = makeEditor(freshDoc, extra);
  fresh.commands.setContent(html);

  const stale = makeEditor(staleDoc);
  Y.applyUpdate(staleDoc, Y.encodeStateAsUpdate(freshDoc));

  return { fresh, stale, freshDoc, staleDoc };
}

/**
 * 把旧客户端手上这份状态送回新客户端，看它那边成了什么样。
 * @param freshDoc - 新客户端的文档。
 * @param staleDoc - 旧客户端的文档。
 */
function sendBack(freshDoc: Y.Doc, staleDoc: Y.Doc): void {
  Y.applyUpdate(freshDoc, Y.encodeStateAsUpdate(staleDoc));
}

describe('验收 2：新增块级节点', () => {
  it('旧客户端不删它，共享文档里那个块连内容完好', () => {
    const { fresh, freshDoc, staleDoc } = pair(
      [Callout],
      '<p>before</p><div data-callout><p>inside</p></div><p>after</p>',
    );

    expect(staleDoc.getXmlFragment('body').toString()).toContain('<callout>');
    expect(staleDoc.getXmlFragment('body').toString()).toContain('inside');

    sendBack(freshDoc, staleDoc);
    expect(fresh.getHTML()).toContain('data-callout');
    expect(fresh.getHTML()).toContain('inside');
  });

  it('旧客户端屏幕上是兜底块，不是原来的内容', () => {
    const { stale } = pair([Callout], '<div data-callout><p>secret</p></div>');
    expect(stale.getHTML()).toContain('data-unsupported-block');
    expect(stale.getHTML()).not.toContain('secret');
  });
});

describe('验收 3：新增行内节点（加载时就发生，没有任何编辑）', () => {
  it('旧客户端不删它，那句话和那个行内元素都还在', () => {
    const { fresh, freshDoc, staleDoc } = pair(
      [Mention],
      '<p>before <span data-mention data-label="alice"></span> after</p>',
    );

    const shared = staleDoc.getXmlFragment('body').toString();
    // 连属性一起保住了：`<mention label="alice">`。
    expect(shared).toContain('<mention label="alice">');
    expect(shared).toContain('before');
    expect(shared).toContain('after');

    sendBack(freshDoc, staleDoc);
    expect(fresh.getHTML()).toContain('data-mention');
    expect(fresh.getHTML()).toContain('before');
  });

  it('旧客户端屏幕上，那一段的文字还在，只有那个元素变成了行内兜底', () => {
    const { stale } = pair(
      [Mention],
      '<p>before <span data-mention data-label="alice"></span> after</p>',
    );
    const html = stale.getHTML();
    expect(html).toContain('before');
    expect(html).toContain('after');
    expect(html).toContain('data-unsupported-inline');
    // 整段没有被换成一个块级兜底 —— 那会连文字一起藏掉。
    expect(html).not.toContain('data-unsupported-block');
  });
});

describe('验收 4：新增标记类型', () => {
  it('旧客户端不删承载它的文本节点', () => {
    const { fresh, freshDoc, staleDoc } = pair(
      [Highlight],
      '<p>keep <mark>this text</mark> please</p>',
    );

    expect(staleDoc.getXmlFragment('body').toString()).toContain('this text');
    sendBack(freshDoc, staleDoc);
    expect(fresh.getHTML()).toContain('this text');
    expect(fresh.getHTML()).toContain('<mark>');
  });
});

describe('验收 5：旧客户端编辑同一段之后', () => {
  it('它不认识的那个标记仍在共享文档里', () => {
    const { fresh, freshDoc, stale, staleDoc } = pair(
      [Highlight],
      '<p>keep <mark>this text</mark> please</p>',
    );

    // 在同一段里打一个字 —— 这一下会让 y-tiptap 把整段的标记比对一遍写回。
    stale.commands.focus();
    stale.commands.setTextSelection(2);
    stale.commands.insertContent('X');

    sendBack(freshDoc, staleDoc);
    expect(fresh.getHTML()).toContain('<mark>');
    expect(fresh.getHTML()).toContain('this text');
  });
});

describe('验收 6：名字认识的构造失败，保持上游自愈', () => {
  it('两个同版本客户端各删引用块里的一段，合并后那个空块被删掉、不变成兜底', () => {
    const seedDoc = new Y.Doc();
    docs.push(seedDoc);
    const seed = makeEditor(seedDoc);
    seed.commands.setContent(
      '<blockquote><p>one</p><p>two</p></blockquote><p>tail</p>',
    );
    const seedUpdate = Y.encodeStateAsUpdate(seedDoc);

    const docA = new Y.Doc();
    const docB = new Y.Doc();
    docs.push(docA, docB);
    Y.applyUpdate(docA, seedUpdate);
    Y.applyUpdate(docB, seedUpdate);

    // 两边扩展集完全一样 —— 没有任何版本差异。
    const clientA = makeEditor(docA);
    const clientB = makeEditor(docB);

    /**
     * 找引用块里第 n 个段落的位置。
     * @param editor - 在哪个编辑器上找。
     * @param nth - 第几个，从 0 数。
     * @returns 位置和大小。
     */
    const nthInQuote = (
      editor: Editor,
      nth: number,
    ): { pos: number; size: number } => {
      const found: Array<{ pos: number; size: number }> = [];
      editor.state.doc.descendants((node, pos, parent) => {
        if (node.type.name === 'paragraph' && parent?.type.name === 'blockquote') {
          found.push({ pos, size: node.nodeSize });
        }
        return true;
      });
      return found[nth];
    };

    const pa = nthInQuote(clientA, 0);
    clientA.commands.deleteRange({ from: pa.pos, to: pa.pos + pa.size });
    const pb = nthInQuote(clientB, 1);
    clientB.commands.deleteRange({ from: pb.pos, to: pb.pos + pb.size });

    Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB));
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));

    // 上游的自愈：那个空引用块被删掉。补丁不该把这个也接管过去 ——
    // 接管了，两个跑着最新版本的人都会看到「不支持的内容」并被拦下来，
    // 而这跟版本漂移毫无关系。
    expect(clientA.getHTML()).not.toContain('data-unsupported-block');
    expect(clientB.getHTML()).not.toContain('data-unsupported-block');
    expect(clientA.getHTML()).toContain('tail');
  });
});

describe('验收 7：可重叠标记不被误判', () => {
  it('两边都认识的 excludes 标记，键带 hash，不该被包成兜底', () => {
    const doc = new Y.Doc();
    docs.push(doc);
    const editor = makeEditor(doc);
    editor.commands.setContent('<p>hello world</p>');
    editor.commands.setTextSelection({ from: 1, to: 6 });
    editor.commands.setMark('anno', { id: 'c1' });

    // 另一个同版本客户端接收它。
    const other = new Y.Doc();
    docs.push(other);
    Y.applyUpdate(other, Y.encodeStateAsUpdate(doc));
    const receiver = makeEditor(other);

    expect(receiver.getHTML()).toContain('data-anno');
    expect(receiver.getHTML()).not.toContain('data-unsupported-mark');
  });

  it('真正不认识的可重叠标记才走兜底，且原样送得回去', () => {
    /** 只有新版本认识的可重叠标记。 */
    const Comment = TiptapMark.create({
      name: 'comment',
      excludes: '',
      addAttributes: () => ({
        id: {
          default: null,
          parseHTML: (element: HTMLElement) => element.getAttribute('data-comment'),
          renderHTML: (attrs: Record<string, unknown>) => ({ 'data-comment': attrs.id }),
        },
      }),
      parseHTML: () => [{ tag: 'span[data-comment]' }],
      renderHTML: ({ HTMLAttributes }) => ['span', HTMLAttributes, 0],
    });

    const { fresh, freshDoc, stale, staleDoc } = pair(
      [Comment],
      '<p>look <span data-comment="c9">here</span> now</p>',
    );

    expect(stale.getHTML()).toContain('here');

    // 旧客户端在同一段里编辑，再送回去 —— 那个标记应该原样还在。
    stale.commands.focus();
    stale.commands.setTextSelection(2);
    stale.commands.insertContent('X');
    sendBack(freshDoc, staleDoc);

    expect(fresh.getHTML()).toContain('data-comment="c9"');
  });
});
