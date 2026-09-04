// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * #904 验收 A10: ending a bold line and pressing Enter leaves you still bold.
 *
 * Pressing Enter is a request for a new line, not a request to drop the
 * formatting the writer just chose — every editor a reader arrives from keeps
 * it, and a writer laying out several emphasised lines would otherwise reach
 * for `Mod-b` on each one, finding out only after typing that it was needed.
 *
 * `tr.split` clears the stored marks, and none of the three paths that reach
 * it puts them back: BlockNote's own Enter for prose, and `splitCarryingQuote`
 * for a quoted block and for a list item. BlockNote knows the step — its
 * hard-break path (`KeyboardShortcutsExtension.ts:844`) takes the marks off
 * the head and calls `ensureMarks` — the split path just does not take it.
 *
 * Which marks carry is ProseMirror's own answer rather than a list of ours:
 * `$from.marks()` at the end of a run holds the marks whose `inclusive` says
 * typing there continues them. A link is `inclusive: false`, so it is absent
 * from that set and a new block does not silently continue someone's URL.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { TextSelection } from '@tiptap/pm/state';
import * as Y from 'yjs';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';

const mounted: ReturnType<typeof buildDocumentEditor>[] = [];
const roots: HTMLElement[] = [];

afterEach(() => {
  mounted.splice(0).forEach((editor) => {
    editor.unmount();
  });
  roots.splice(0).forEach((root) => {
    root.remove();
  });
});

/**
 * Opens an editor holding one block with the given content.
 * @param block - The block to put in the document.
 * @returns The editor.
 */
function open(
  block: Readonly<Record<string, unknown>>,
): ReturnType<typeof buildDocumentEditor> {
  const editor = buildDocumentEditor({
    fragment: documentBodyFragment(new Y.Doc()),
  });
  const root = document.createElement('div');
  document.body.appendChild(root);
  roots.push(root);
  editor.mount(root);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, [block] as never);
  return editor;
}

/**
 * Puts the caret at the end of the document's text, presses Enter, and types.
 * @param editor - The editor to write in.
 * @returns The marks on the character that was typed.
 */
function typeAfterEnter(
  editor: ReturnType<typeof buildDocumentEditor>,
): string[] {
  const view = editor.prosemirrorView!;
  let end = -1;
  view.state.doc.descendants((node, pos) => {
    if (node.isText) end = pos + node.nodeSize;
    return true;
  });
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, end)));

  const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true });
  view.someProp('handleKeyDown', (handler) => handler(view, event));

  const live = editor.prosemirrorView!;
  live.dispatch(live.state.tr.insertText('z'));

  const found: string[] = [];
  editor.prosemirrorState.doc.descendants((node) => {
    if (node.isText && node.text === 'z') {
      found.push(...node.marks.map((mark) => mark.type.name));
    }
    return true;
  });
  return found;
}

/** A run of bold text, as `replaceBlocks` takes it. */
const BOLD = [{ type: 'text', text: 'lead', styles: { bold: true } }];

describe('the formatting a writer chose, across Enter', () => {
  it('carries out of a paragraph', () => {
    const editor = open({ type: 'paragraph', content: BOLD });

    expect(typeAfterEnter(editor)).toEqual(['bold']);
  });

  it('carries out of a quoted block, which splits through our own handler', () => {
    const editor = open({
      type: 'paragraph',
      content: BOLD,
      props: { quoted: true },
    });

    expect(typeAfterEnter(editor)).toEqual(['bold']);
  });

  it('carries out of a list item, which splits through the list handler', () => {
    const editor = open({ type: 'bulletListItem', content: BOLD });

    expect(typeAfterEnter(editor)).toEqual(['bold']);
  });

  it('carries two marks at once', () => {
    const editor = open({
      type: 'paragraph',
      content: [
        { type: 'text', text: 'lead', styles: { bold: true, italic: true } },
      ],
    });

    expect(typeAfterEnter(editor).sort()).toEqual(['bold', 'italic']);
  });

  it('leaves a link behind, which ends where the writer stopped typing it', () => {
    // `link` is the one mark declared `inclusive: false`: typing at its end
    // is already outside it, so a new block continuing it would extend a URL
    // the writer never meant to extend.
    const editor = open({
      type: 'paragraph',
      content: [{ type: 'link', href: 'https://example.com', content: 'site' }],
    });

    expect(typeAfterEnter(editor)).toEqual([]);
  });
});
