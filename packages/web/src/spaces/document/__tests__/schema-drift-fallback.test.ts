// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

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

/**
 * 内容规则是 `paragraph block*`：**开头**只收段落，段落之后收任何块。
 *
 * 真实的对应物就是 StarterKit 的 `listItem`（@tiptap/extension-list 的
 * `content: "paragraph block*"`）。它是「父节点开头收不收」和「这个位置收不收」
 * 分岔的地方 —— 未知块在列表项里永远排在那个段落后面。
 */
const Item = TiptapNode.create({
  name: 'item',
  content: 'paragraph block*',
  parseHTML: () => [{ tag: 'li' }],
  renderHTML: () => ['li', 0],
});

/** 只收 `item`，两个兜底都放不进去。 */
const ItemList = TiptapNode.create({
  name: 'itemList',
  group: 'block',
  content: 'item+',
  parseHTML: () => [{ tag: 'ul' }],
  renderHTML: () => ['ul', 0],
});

/**
 * 内容规则是 `text*`：只收文字，两个兜底类型一个都收不了。
 *
 * 两个版本都认识它。真实的对应物是 document space 的 `codeBlock`。
 */
const Caption = TiptapNode.create({
  name: 'caption',
  group: 'block',
  content: 'text*',
  parseHTML: () => [{ tag: 'figcaption' }],
  renderHTML: () => ['figcaption', 0],
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
  Caption,
  Item,
  ItemList,
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

describe('父节点的内容规则开头不收、但后面的位置收', () => {
  it('列表项里排在段落后面的未知块，包成块级兜底，内容一个字节都不少', () => {
    // `item` 的内容规则是 `paragraph block*`：**开头**只收段落。判据从
    // `parentType.contentMatch` 出发、按前序兄弟逐个 matchType 走到未知块
    // 自己的位置再问 —— 这里走过那个段落之后，`block*` 那一段收块级兜底。
    // 只问表达式起点会答「不收」，真实的 listItem 里每一个新块类型都会被删掉。
    const staleDoc = new Y.Doc();
    docs.push(staleDoc);
    staleDoc.transact(() => {
      const para = new Y.XmlElement('paragraph');
      para.insert(0, [new Y.XmlText('要点')]);
      const callout = new Y.XmlElement('callout');
      const inner = new Y.XmlElement('paragraph');
      inner.insert(0, [new Y.XmlText('里面的字')]);
      callout.insert(0, [inner]);

      const item = new Y.XmlElement('item');
      item.insert(0, [para, callout]);
      const list = new Y.XmlElement('itemList');
      list.insert(0, [item]);
      staleDoc.getXmlFragment('body').insert(0, [list]);
    });

    makeEditor(staleDoc);

    const body = staleDoc.getXmlFragment('body').toString();
    expect(body).toContain('<callout>');
    expect(body).toContain('里面的字');
    expect(body).toContain('要点');
  });
});

describe('强制前缀的首位不收，判据答的是这个位置', () => {
  it('列表项首位的未知块只丢它自己，列表项和里面的文字都还在', () => {
    // `item` 的首位只收段落。旧判据问「表达式里有没有某个位置收块」，答收，
    // 于是把块级兜底塞进首位 —— item 自己构造失败，落进那个被原样留着的
    // catch，整个列表项连用户写的字一起从共享文档里消失。逐位置判据在首位
    // 答「不收」，这个未知块单独落进 catch：丢的只有它一个。
    const staleDoc = new Y.Doc();
    docs.push(staleDoc);
    staleDoc.transact(() => {
      const callout = new Y.XmlElement('callout');
      const inner = new Y.XmlElement('paragraph');
      inner.insert(0, [new Y.XmlText('里面的字')]);
      callout.insert(0, [inner]);
      const para = new Y.XmlElement('paragraph');
      para.insert(0, [new Y.XmlText('要点')]);

      const item = new Y.XmlElement('item');
      item.insert(0, [callout, para]);
      const list = new Y.XmlElement('itemList');
      list.insert(0, [item]);
      staleDoc.getXmlFragment('body').insert(0, [list]);
    });

    makeEditor(staleDoc);

    const body = staleDoc.getXmlFragment('body').toString();
    expect(body).toContain('<item>');
    expect(body).toContain('要点');
    expect(body).not.toContain('<callout>');
  });

  it('前面有一个也不认识的兄弟时，按它替换后的类型代入，两个都保住', () => {
    // 走到后一个未知块的位置，要经过前一个未知块 —— 它自己会被换成块级
    // 兜底，走位置时就按兜底类型代入。要是把不认识的兄弟当「走不过去」，
    // 后一个就拿不到兜底、被 catch 删掉。
    const staleDoc = new Y.Doc();
    docs.push(staleDoc);
    staleDoc.transact(() => {
      const para = new Y.XmlElement('paragraph');
      para.insert(0, [new Y.XmlText('要点')]);
      const calloutOne = new Y.XmlElement('callout');
      const innerOne = new Y.XmlElement('paragraph');
      innerOne.insert(0, [new Y.XmlText('第一块')]);
      calloutOne.insert(0, [innerOne]);
      const calloutTwo = new Y.XmlElement('callout');
      const innerTwo = new Y.XmlElement('paragraph');
      innerTwo.insert(0, [new Y.XmlText('第二块')]);
      calloutTwo.insert(0, [innerTwo]);

      const item = new Y.XmlElement('item');
      item.insert(0, [para, calloutOne, calloutTwo]);
      const list = new Y.XmlElement('itemList');
      list.insert(0, [item]);
      staleDoc.getXmlFragment('body').insert(0, [list]);
    });

    makeEditor(staleDoc);

    const body = staleDoc.getXmlFragment('body').toString();
    expect(body).toContain('第一块');
    expect(body).toContain('第二块');
    expect((body.match(/<callout>/g) ?? []).length).toBe(2);
  });
});

describe('父节点两种兜底都不收时', () => {
  it('只有那个不认识的元素消失，父元素和它的文字都还在', () => {
    // `text*` 的父节点两个兜底都收不了：行内兜底是个节点、不是文字，块级兜底
    // 更不行。document space 真实的 `codeBlock` 就是这个形状（`listItem` 的
    // `paragraph block*` 同理，首位必须是段落）。补丁挑兜底不能写成二选一 ——
    // 那样会往 caption 里塞一个它收不了的块，caption 自己构造失败，落进那个
    // 被原样留着的 catch，整段连文字一起从共享文档里消失。
    //
    // 这一份共享文档是手工用 Yjs API 造的，不经编辑器：本 build 的 caption 是
    // `text*`，ProseMirror 解析 HTML 时会把 mention 拆到 caption 外面去 ——
    // 它在保护自己的 schema，所以这个状态**本 build 的编辑器造不出来**。
    // 而它正是「另一个 build 写进来的字节」，那边的 caption 收 mention。
    const staleDoc = new Y.Doc();
    docs.push(staleDoc);
    staleDoc.transact(() => {
      const caption = new Y.XmlElement('caption');
      caption.insert(0, [
        new Y.XmlText('Q3 '),
        new Y.XmlElement('mention'),
        new Y.XmlText('剧本'),
      ]);
      staleDoc.getXmlFragment('body').insert(0, [caption]);
    });

    makeEditor(staleDoc);

    const staleBody = staleDoc.getXmlFragment('body').toString();
    expect(staleBody).toContain('<caption>');
    expect(staleBody).toContain('Q3 ');
    expect(staleBody).toContain('剧本');
    expect(staleBody).not.toContain('<mention>');
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
