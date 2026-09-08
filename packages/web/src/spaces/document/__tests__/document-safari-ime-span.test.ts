// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * #969: an indented row grows an extra row while Chinese is being typed.
 *
 * WebKit's contenteditable removes an element that becomes empty during a
 * composition, together with the ancestors that empty with it, whenever that
 * element carries `position: relative` (ProseMirror issue #934, open since
 * 2019 and still open when the repository was archived; three reporters each
 * narrowed it to that one declaration). Safari empties the composition buffer
 * before it commits a candidate — a `beforeinput`/`input` pair carrying
 * `data: ""`, which Chrome never sends — so the removal happens mid-word, and
 * `prosemirror-view` reads the changed structure back into the document as a
 * new block.
 *
 * `@blocknote/core@0.54.0` declares that property on exactly one selector:
 *
 * ```css
 * .bn-block-group .bn-block-group > .bn-block-outer { position: relative }
 * ```
 *
 * It takes two nested block groups to match, which is why the row at the left
 * edge never grew one and an indented row did (user 2026-09-08).
 *
 * The fix is `prosemirror-safari-ime-span`, which keeps a span in the block
 * for as long as a composition is running so nothing there is ever empty.
 * What this file holds is that the span is REACHABLE — registered, and drawn
 * where the caret is. Whether WebKit then leaves the block alone is a
 * question only a real input method can answer.
 */

import { describe, it, expect, afterEach } from 'vitest';
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
 * Opens a mounted editor holding one indented list item.
 *
 * Indented because that is the shape the defect needs: BlockNote gives
 * `position: relative` only to a block nested two groups deep.
 * @returns The editor.
 */
function open(): ReturnType<typeof buildDocumentEditor> {
  const editor = buildDocumentEditor({
    fragment: documentBodyFragment(new Y.Doc()),
  });
  const root = document.createElement('div');
  root.className = 'doc-body-editor';
  document.body.appendChild(root);
  roots.push(root);
  editor.mount(root);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, [
    {
      type: 'numberedListItem',
      content: 'one',
      children: [
        {
          type: 'numberedListItem',
          content: 'two',
          children: [{ type: 'numberedListItem', content: 'three' }],
        },
      ],
    },
  ] as never);
  return editor;
}

/** Every span the plugin has drawn. */
function spans(editor: ReturnType<typeof buildDocumentEditor>): Element[] {
  return Array.from(
    editor.prosemirrorView.dom.querySelectorAll(
      '.ProseMirror-safari-ime-span',
    ),
  );
}

/**
 * Raises a DOM event on the editor, the way the browser would.
 * @param editor - The editor to raise it on.
 * @param name - Which composition event.
 */
function compose(
  editor: ReturnType<typeof buildDocumentEditor>,
  name: 'compositionstart' | 'compositionend',
): void {
  editor.prosemirrorView.dom.dispatchEvent(
    new CompositionEvent(name, { data: '', bubbles: true }),
  );
}

/**
 * Types one character into the deepest block, so the view redraws.
 *
 * Decorations are recomputed when the state changes, and a composition
 * starting raises no transaction of its own — so what puts the span on screen
 * is the first letter the input method writes, which is exactly what happens
 * before a candidate can be committed.
 * @param editor - The editor to type into.
 */
function typeALetter(editor: ReturnType<typeof buildDocumentEditor>): void {
  editor.transact((tr) => {
    tr.insertText('d', tr.selection.from);
  });
}

/** Puts the caret at the end of the deepest block. */
function caretInDeepest(
  editor: ReturnType<typeof buildDocumentEditor>,
): void {
  const blocks = editor.document as unknown as { id: string }[];
  const deepest = editor.getBlock(
    (
      (
        (blocks[0] as unknown as { children: { children: { id: string }[] }[] })
          .children[0] as { children: { id: string }[] }
      ).children[0] as { id: string }
    ).id,
  );
  editor.setTextCursorPosition(deepest as never, 'end');
}

describe('the span that keeps a composing block from emptying', () => {
  it('draws one at the caret while a composition runs', () => {
    const editor = open();
    caretInDeepest(editor);
    expect(spans(editor)).toHaveLength(0);

    compose(editor, 'compositionstart');
    typeALetter(editor);

    expect(spans(editor)).toHaveLength(1);
  });

  it('draws it inside the block being typed in', () => {
    const editor = open();
    caretInDeepest(editor);
    compose(editor, 'compositionstart');
    typeALetter(editor);

    const content = spans(editor)[0]!.closest('.bn-block-content');
    expect(content).not.toBeNull();
    expect(content!.textContent).toContain('three');
  });

  it('takes it away once the composition ends', () => {
    const editor = open();
    caretInDeepest(editor);
    compose(editor, 'compositionstart');
    typeALetter(editor);
    expect(spans(editor)).toHaveLength(1);

    compose(editor, 'compositionend');
    typeALetter(editor);

    expect(spans(editor)).toHaveLength(0);
  });

  it('draws none when nothing is being composed', () => {
    const editor = open();
    caretInDeepest(editor);
    typeALetter(editor);

    expect(spans(editor)).toHaveLength(0);
  });
});
