// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * 探针：给 y-tiptap 打补丁，让它遇到不认识的节点名时包进一个预先内置的
 * 兜底节点，而不是把它从共享文档里删掉。
 *
 * 对照实验：
 *   不挂补丁（用原版 y-tiptap）→ 预期红：callout 被删
 *   挂上补丁                   → 预期绿：callout 完好、旧客户端显示兜底、
 *                                 旧客户端在别处编辑之后 callout 仍完好
 *
 * 最核心要验的是最后一条：旧客户端手里那个「空的兜底节点」会不会顺着
 * 双向同步，把 Yjs 里真正的 callout 内容覆盖掉。
 */

import { describe, it, expect, afterEach } from 'vitest';
import { Editor, Node as TiptapNode, Mark as TiptapMark } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import Collaboration from '@tiptap/extension-collaboration';
import * as Y from 'yjs';

const editors: Editor[] = [];
const docs: Y.Doc[] = [];

afterEach(() => {
  editors.splice(0).forEach((e) => {
    try {
      e.destroy();
    } catch {
      // 已经销毁过的忽略
    }
  });
  docs.splice(0).forEach((d) => d.destroy());
});

/** 兜底节点。两个版本都有它 —— 这是它必须在上线前就加进去的原因。 */
const UnsupportedBlock = TiptapNode.create({
  name: 'unsupportedBlock',
  group: 'block',
  atom: true,
  selectable: true,
  addAttributes: () => ({ originalName: { default: null } }),
  parseHTML: () => [{ tag: 'div[data-unsupported]' }],
  renderHTML: ({ HTMLAttributes }) => [
    'div',
    { 'data-unsupported': '', 'data-original-name': HTMLAttributes.originalName },
    'Unsupported content',
  ],
});

/** 只有「新」客户端有的块类型。 */
const Callout = TiptapNode.create({
  name: 'callout',
  group: 'block',
  content: 'inline*',
  parseHTML: () => [{ tag: 'aside.callout' }],
  renderHTML: () => ['aside', { class: 'callout' }, 0],
});

/** 兜底标记。两个版本都有它，用来承载不认识的标记。 */
const UnsupportedMark = TiptapMark.create({
  name: 'unsupportedMark',
  // 空的 excludes：同一段文字上可以同时挂多个不认识的标记，互不排斥。
  excludes: '',
  addAttributes: () => ({
    originalName: { default: null },
    originalValue: { default: null },
  }),
  parseHTML: () => [{ tag: 'span[data-unsupported-mark]' }],
  renderHTML: () => ['span', { 'data-unsupported-mark': '' }, 0],
});

/** 只有「新」客户端有的标记类型。 */
const Highlight = TiptapMark.create({
  name: 'highlight',
  parseHTML: () => [{ tag: 'mark' }],
  renderHTML: () => ['mark', 0],
});

/**
 * 建一个编辑器。
 * @param fragment - 绑定的 Yjs 片段。
 * @param withNewStuff - 这个版本认不认识 callout 和 highlight。
 * @returns 编辑器。
 */
function makeEditor(fragment: Y.XmlFragment, withNewStuff: boolean): Editor {
  const editor = new Editor({
    extensions: [
      Document,
      Paragraph,
      Text,
      UnsupportedBlock,
      UnsupportedMark,
      ...(withNewStuff ? [Callout, Highlight] : []),
      Collaboration.configure({ fragment }),
    ],
  });
  editors.push(editor);
  return editor;
}

/**
 * 递归收集片段里出现过的所有元素名。
 * @param fragment - 要遍历的片段。
 * @returns 元素名集合。
 */
function namesIn(fragment: Y.XmlFragment): string[] {
  const found: string[] = [];
  const walk = (node: unknown): void => {
    if (node instanceof Y.XmlElement) {
      found.push(node.nodeName);
      node.toArray().forEach(walk);
    } else if (node instanceof Y.XmlFragment) {
      node.toArray().forEach(walk);
    }
  };
  fragment.toArray().forEach(walk);
  return found;
}

describe('未知节点包起来而不是删掉', () => {
  it('旧客户端不删它、显示兜底、在别处编辑之后原件仍完好', () => {
    const freshDoc = new Y.Doc();
    const staleDoc = new Y.Doc();
    docs.push(freshDoc, staleDoc);

    const freshFragment = freshDoc.getXmlFragment('body');
    const staleFragment = staleDoc.getXmlFragment('body');

    const fresh = makeEditor(freshFragment, true);
    const stale = makeEditor(staleFragment, false);

    // 新客户端造一个它自己认识、旧客户端不认识的块。
    fresh.commands.setContent('<p>before</p><aside class="callout">inside</aside><p>after</p>');

    // 同步给旧客户端。
    Y.applyUpdate(staleDoc, Y.encodeStateAsUpdate(freshDoc));

    const namesAfterSync = namesIn(staleFragment);
    const staleHtml = stale.getHTML();

    // 旧客户端在文档别处正常编辑一下。
    stale.commands.focus('end');
    stale.commands.insertContent('<p>stale typed this</p>');

    const namesAfterStaleEdit = namesIn(staleFragment);

    // 把旧客户端的改动送回新客户端。
    Y.applyUpdate(freshDoc, Y.encodeStateAsUpdate(staleDoc));
    const freshHtmlAfterRoundTrip = fresh.getHTML();

    // eslint-disable-next-line no-console
    console.log(JSON.stringify({
      '1_旧客户端收到后_共享文档里的元素名': namesAfterSync,
      '2_旧客户端屏幕上': staleHtml,
      '3_旧客户端在别处编辑后_元素名': namesAfterStaleEdit,
      '4_旧客户端的共享文档XML': staleFragment.toString(),
      '5_送回新客户端后_新客户端屏幕上': freshHtmlAfterRoundTrip,
    }, null, 2));

    // 核心断言。
    expect(namesAfterSync).toContain('callout');
    expect(staleHtml).toContain('Unsupported content');
    expect(namesAfterStaleEdit).toContain('callout');
    expect(freshHtmlAfterRoundTrip).toContain('inside');
  });

  it('未知标记：文字保住，旧客户端在同一段里打字之后标记也没丢', () => {
    const freshDoc = new Y.Doc();
    const staleDoc = new Y.Doc();
    docs.push(freshDoc, staleDoc);

    const freshFragment = freshDoc.getXmlFragment('body');
    const staleFragment = staleDoc.getXmlFragment('body');

    const fresh = makeEditor(freshFragment, true);
    const stale = makeEditor(staleFragment, false);

    fresh.commands.setContent('<p>plain <mark>marked</mark> tail</p>');
    Y.applyUpdate(staleDoc, Y.encodeStateAsUpdate(freshDoc));

    const staleHtml = stale.getHTML();
    const staleText = stale.state.doc.textContent;

    // 旧客户端在同一段文字的末尾接着打字 —— 最容易把标记写没的操作。
    stale.commands.focus('end');
    stale.commands.insertContent(' and more');

    Y.applyUpdate(freshDoc, Y.encodeStateAsUpdate(staleDoc));
    const freshHtml = fresh.getHTML();

    // eslint-disable-next-line no-console
    console.log(JSON.stringify({
      '1_旧客户端屏幕上': staleHtml,
      '1b_旧客户端读到的文字': staleText,
      '2_旧客户端在同段打字后_共享文档XML': staleFragment.toString(),
      '3_送回新客户端后_新客户端屏幕上': freshHtml,
    }, null, 2));

    // 一个字都没少 —— 这是「不破坏内容」那一半。
    expect(staleText).toBe('plain marked tail');
    expect(freshHtml).toContain('<mark>marked</mark>');
    expect(freshHtml).toContain('and more');
  });

  it('已知节点上的新属性：这条路径补丁盖不住', () => {
    // 新版本给 paragraph 加了一个 align 属性，旧版本没声明它。
    const ParagraphWithAlign = Paragraph.extend({
      addAttributes: () => ({ align: { default: null } }),
    });

    const freshDoc = new Y.Doc();
    const staleDoc = new Y.Doc();
    docs.push(freshDoc, staleDoc);

    const freshFragment = freshDoc.getXmlFragment('body');
    const staleFragment = staleDoc.getXmlFragment('body');

    const fresh = new Editor({
      extensions: [
        Document,
        ParagraphWithAlign,
        Text,
        UnsupportedBlock,
        UnsupportedMark,
        Collaboration.configure({ fragment: freshFragment }),
      ],
    });
    editors.push(fresh);
    const stale = makeEditor(staleFragment, false);

    fresh.commands.setContent('<p>one</p><p>two</p>');
    fresh.commands.setNodeSelection(0);
    fresh.commands.updateAttributes('paragraph', { align: 'center' });
    Y.applyUpdate(staleDoc, Y.encodeStateAsUpdate(freshDoc));

    const xmlAfterSync = staleFragment.toString();

    // 旧客户端编辑带着那个属性的那一段。
    stale.commands.focus('start');
    stale.commands.insertContent('X');

    const xmlAfterStaleEdit = staleFragment.toString();

    // eslint-disable-next-line no-console
    console.log(JSON.stringify({
      '1_旧客户端收到后_共享文档XML': xmlAfterSync,
      '2_旧客户端编辑那一段之后_共享文档XML': xmlAfterStaleEdit,
    }, null, 2));

    // 属性到得了旧客户端手里，但它一编辑那个节点，属性就没了。
    expect(xmlAfterSync).toContain('align="center"');
    expect(xmlAfterStaleEdit).not.toContain('align="center"');
  });

  it('根节点的内容规则变了：补丁盖不盖得住', () => {
    // 我们的根节点规则是 `documentTitle block*`（document-extensions.ts:95）：
    // 第一个必须是标题。这里模拟新版本把这条规则放宽成「标题可以没有」，
    // 然后新客户端造一份没有标题的文档。
    const Title = TiptapNode.create({
      name: 'docTitle',
      content: 'text*',
      parseHTML: () => [{ tag: 'h1' }],
      renderHTML: () => ['h1', 0],
    });
    const StrictDoc = Document.extend({ content: 'docTitle block*' });
    const LooseDoc = Document.extend({ content: 'block*' });

    const freshDoc = new Y.Doc();
    const staleDoc = new Y.Doc();
    docs.push(freshDoc, staleDoc);

    const freshFragment = freshDoc.getXmlFragment('body');
    const staleFragment = staleDoc.getXmlFragment('body');

    const fresh = new Editor({
      extensions: [
        LooseDoc, Paragraph, Text, Title, UnsupportedBlock, UnsupportedMark,
        Collaboration.configure({ fragment: freshFragment }),
      ],
    });
    editors.push(fresh);

    const stale = new Editor({
      extensions: [
        StrictDoc, Paragraph, Text, Title, UnsupportedBlock, UnsupportedMark,
        Collaboration.configure({ fragment: staleFragment }),
      ],
    });
    editors.push(stale);

    // 新客户端造一份没有标题的文档 —— 旧客户端的规则不接受这种形状。
    fresh.commands.setContent('<p>no title here</p><p>second</p>');
    Y.applyUpdate(staleDoc, Y.encodeStateAsUpdate(freshDoc));

    const staleXml = staleFragment.toString();
    const staleText = stale.state.doc.textContent;

    Y.applyUpdate(freshDoc, Y.encodeStateAsUpdate(staleDoc));

    // eslint-disable-next-line no-console
    console.log(JSON.stringify({
      '1_旧客户端的共享文档XML': staleXml,
      '2_旧客户端读到的文字': staleText,
      '3_旧客户端屏幕上': stale.getHTML(),
      '4_送回新客户端后': fresh.getHTML(),
    }, null, 2));

    // 这一条只记录实际行为，不预设结论。
    expect(typeof staleXml).toBe('string');
  });

  it('旧客户端删掉那个兜底块，原件跟着真的被删掉', () => {
    const freshDoc = new Y.Doc();
    const staleDoc = new Y.Doc();
    docs.push(freshDoc, staleDoc);

    const freshFragment = freshDoc.getXmlFragment('body');
    const staleFragment = staleDoc.getXmlFragment('body');

    const fresh = makeEditor(freshFragment, true);
    const stale = makeEditor(staleFragment, false);

    fresh.commands.setContent('<p>before</p><aside class="callout">inside</aside><p>after</p>');
    Y.applyUpdate(staleDoc, Y.encodeStateAsUpdate(freshDoc));

    // 找到那个兜底块的位置，选中它、删掉 —— 用户在旧页面上做得到的事。
    let fallbackPos = -1;
    stale.state.doc.descendants((node, pos) => {
      if (node.type.name === 'unsupportedBlock') fallbackPos = pos;
      return true;
    });
    expect(fallbackPos).toBeGreaterThanOrEqual(0);

    stale.commands.setNodeSelection(fallbackPos);
    const deleted = stale.commands.deleteSelection();

    Y.applyUpdate(freshDoc, Y.encodeStateAsUpdate(staleDoc));

    // eslint-disable-next-line no-console
    console.log(JSON.stringify({
      '1_删除命令返回': deleted,
      '2_删完之后_旧客户端共享文档XML': staleFragment.toString(),
      '3_送回新客户端后_新客户端屏幕上': fresh.getHTML(),
    }, null, 2));

    expect(deleted).toBe(true);
    expect(namesIn(staleFragment)).not.toContain('callout');
    expect(fresh.getHTML()).not.toContain('inside');
  });
});
