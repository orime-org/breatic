// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * inner#1423 A11, design 6.6 "有损判定与纯文本": a block's plain text, which
 * proposals are located by and their cards compare, carries formulas as
 * `$$source$$` inline and `$$` lines around a block's source.
 *
 * `leafText` does nothing for a node with content (`prosemirror-model`
 * 1.25.12 reads it on leaves only), so `textBetween` alone would give the
 * bare source.
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { blockPlainText } from '@web/spaces/document/document-blocks-read';
import { markdownBlocks } from '@web/spaces/document/document-markdown';

type Editor = ReturnType<typeof buildDocumentEditor>;

const mounted: Editor[] = [];

afterEach(() => {
  for (const editor of mounted.splice(0)) editor.unmount();
  document.body.innerHTML = '';
});

/**
 * Each top block's plain text, for a body of the given blocks.
 * @param blocks - The blocks.
 * @returns One string per block.
 */
function plainTexts(blocks: unknown[]): string[] {
  const editor = buildDocumentEditor({ fragment: documentBodyFragment(new Y.Doc()) });
  const host = document.createElement('div');
  document.body.appendChild(host);
  editor.mount(host);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, blocks as never);
  const out: string[] = [];
  editor.prosemirrorState.doc.firstChild?.forEach((node) => out.push(blockPlainText(node)));
  return out;
}

describe('a block\'s plain text with formulas', () => {
  it('writes an inline formula as $$source$$', () => {
    expect(
      plainTexts([
        { type: 'paragraph', content: [{ type: 'text', text: 'Mass ', styles: {} }, { type: 'math', props: { source: 'E = mc^2' } }, { type: 'text', text: ' here', styles: {} }] },
      ]),
    ).toEqual(['Mass $$E = mc^2$$ here']);
  });

  it('writes a formula block with $$ on lines of their own', () => {
    expect(plainTexts([{ type: 'mathBlock', props: { source: '\\frac{a}{b}' } }])).toEqual(['$$\n\\frac{a}{b}\n$$']);
  });

  it('gives a proposal\'s Markdown the same text as the body', async () => {
    const got = await markdownBlocks('Mass $$E = mc^2$$ here\n\n$$\n\\frac{a}{b}\n$$');

    expect(got.map((b) => b.text)).toEqual(['Mass $$E = mc^2$$ here', '$$\n\\frac{a}{b}\n$$']);
  });
});
