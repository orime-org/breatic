// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The document's one placeholder, and why it is drawn here rather than by the
 * placeholder extension every other editor uses.
 *
 * That extension decorates textblocks that EXIST in the document, and a
 * document with no blocks has nothing to decorate — so its placeholder could
 * never be drawn at all. Verified in the installed source:
 * `@tiptap/extensions` skips anything that is not a textblock.
 *
 * So the document marks its own empty state and the stylesheet draws the
 * text. What is asserted here is the marking — the class and the string that
 * goes with it. Whether the text is actually painted is a CSS question and is
 * checked in the browser.
 *
 * The generate prompt still uses the extension, and the stylesheet rule it
 * relies on keys off what the extension marks (`p.is-editor-empty`). The last
 * case below is what keeps this document out of its way: it asserts this
 * editor installs no extension of that name, so it marks no paragraph as empty
 * and there is nothing here that the prompt's rule can pick up.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import * as Y from 'yjs';
import { documentBodyFragment, encodeInitialSpaceContent, t } from '@breatic/shared';

import { buildDocumentExtensions } from '@web/spaces/document/document-extensions';
import { DOCUMENT_BODY_EMPTY_CLASS } from '@web/spaces/document/document-placeholders';

const editors: Editor[] = [];

afterEach(() => {
  editors.splice(0).forEach((e) => {
    e.destroy();
  });
});

/**
 * A seeded document with a live editor over it.
 * @param bodyHtml - HTML for the document's blocks, if any.
 * @returns The editor bound to it.
 */
function open(bodyHtml = ''): Editor {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, encodeInitialSpaceContent('document'));
  const editor = new Editor({
    extensions: buildDocumentExtensions({ fragment: documentBodyFragment(doc) }),
  });
  editors.push(editor);
  if (bodyHtml) {
    editor.commands.setContent(bodyHtml);
  }
  return editor;
}

/**
 * What the editor element currently carries for the empty state.
 * @param editor - The editor to read.
 * @returns The class flag and the string alongside it.
 */
function marking(editor: Editor): { marked: boolean; text: string | null } {
  const dom = editor.view.dom;
  return {
    marked: dom.classList.contains(DOCUMENT_BODY_EMPTY_CLASS),
    text: dom.getAttribute('data-body-placeholder'),
  };
}

describe('the empty-document placeholder', () => {
  it('is marked, with the localised string, while the document has no blocks', () => {
    const editor = open();
    expect(editor.state.doc.childCount).toBe(0);
    const { marked, text } = marking(editor);
    expect(marked).toBe(true);
    expect(text).toBe(t('spaces.document.placeholder'));
  });

  it('is not marked once the document holds a block', () => {
    const editor = open('<p>written</p>');
    expect(marking(editor).marked).toBe(false);
  });

  it('comes back when the last block is removed', () => {
    const editor = open('<p>written</p>');
    editor.commands.clearDocument();
    expect(editor.state.doc.childCount).toBe(0);
    expect(marking(editor).marked).toBe(true);
  });

  it('does not install the extension the generate prompt relies on', () => {
    const editor = open();
    const names = editor.extensionManager.extensions.map((e) => e.name);
    expect(names).not.toContain('placeholder');
  });
});

describe('一个只有空块的文档，看起来跟零块一样空——占位画在首个空块的行内（user 2026-08-18 拍定，按业界）', () => {
  // 点一下空文档建了段、没打字就切走：文档里躺着一个空段落，屏幕上什么
  // 都没有。判据是「没有任何可见内容」：空的段落和标题什么都不画（含只有
  // 硬换行的），空代码块有底色、空引用有边线、空列表有圆点，它们可见。
  // 位置照业界（tiptap 官方 Placeholder）：画在首个空块的行内——零块态的
  // 编辑器级提示经 CSS 对齐到同一行位置，两态在屏幕上同位。
  /** 首个块上的行内占位字符串（node decoration 挂的属性）。 */
  function blockHint(editor: Editor): string | null {
    return (
      editor.view.dom.firstElementChild?.getAttribute('data-block-placeholder') ??
      null
    );
  }

  it('一个空段落：行内占位在首块上，编辑器级标记不再出现', () => {
    const editor = open('<p></p>');
    expect(editor.state.doc.childCount).toBe(1);
    expect(blockHint(editor)).toBe(t('spaces.document.placeholder'));
    expect(marking(editor).marked).toBe(false);
  });

  it('几个空段落加一个空标题：只有首块带占位', () => {
    const editor = open('<p></p><h2></h2><p></p>');
    expect(blockHint(editor)).toBe(t('spaces.document.placeholder'));
    const second = editor.view.dom.children[1];
    expect(second?.getAttribute('data-block-placeholder')).toBeNull();
  });

  it('只有硬换行的段落也算看不见（user 2026-08-18 拍定：无可见内容）', () => {
    const editor = open('<p><br></p>');
    expect(blockHint(editor)).toBe(t('spaces.document.placeholder'));
  });

  it('有一个字就没有任何占位', () => {
    const editor = open('<p></p><p>x</p>');
    expect(blockHint(editor)).toBeNull();
    expect(marking(editor).marked).toBe(false);
  });

  it('空代码块是可见的，不算空态', () => {
    const editor = open('<pre><code></code></pre>');
    expect(blockHint(editor)).toBeNull();
  });

  it('兜底占位块是可见的，不算空态', () => {
    const doc = new Y.Doc();
    doc.transact(() => {
      doc.getXmlFragment('body').insert(0, [new Y.XmlElement('strangeBlock')]);
    });
    const editor = new Editor({
      extensions: buildDocumentExtensions({ fragment: doc.getXmlFragment('body') }),
    });
    editors.push(editor);
    expect(blockHint(editor)).toBeNull();
    expect(marking(editor).marked).toBe(false);
  });
});
