// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * #904 验收 C10 and the rendering half of C5: the numbers reach the screen
 * without reaching the document.
 *
 * BlockNote draws an ordered item's number from `data-index`, an attribute its
 * own indexing plugin writes, through `content: var(--index) "."`. That path
 * cannot carry either of the two shapes this Space needs: a numbered HEADING
 * is a `heading` block, which neither of those selectors matches, and a level
 * path would come out as `1.1.` because the dot is welded on in the CSS.
 *
 * So the number travels as an attribute of our own, `data-doc-number`, put
 * there by a decoration and drawn by one rule in `index.css`. A decoration is
 * not part of the document: it is recomputed from the document on every change
 * and never written back, which is what keeps opening a document from filling
 * a collaborator's undo stack or touching a single byte of the shared bytes.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as Y from 'yjs';
import { TextSelection } from '@tiptap/pm/state';
import type { EditorState } from '@tiptap/pm/state';
import { yUndoPluginKey } from 'y-prosemirror';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { documentNumberingExtension } from '@web/spaces/document/document-numbering-decoration';

const mounted: ReturnType<typeof buildDocumentEditor>[] = [];

afterEach(() => {
  mounted.splice(0).forEach((editor) => {
    editor.unmount();
  });
});

/** A block as `replaceBlocks` takes it. */
type BlockSpec = Readonly<Record<string, unknown>>;

/**
 * Opens an editor over a fresh document holding the given blocks.
 * @param blocks - What to put in the document.
 * @returns The editor, its Yjs doc, and the element it rendered into.
 */
function open(blocks: readonly BlockSpec[]): {
  editor: ReturnType<typeof buildDocumentEditor>;
  doc: Y.Doc;
  root: HTMLElement;
} {
  const doc = new Y.Doc();
  const editor = buildDocumentEditor({
    fragment: documentBodyFragment(doc),
    extensions: [documentNumberingExtension()],
  });
  const root = document.createElement('div');
  document.body.appendChild(root);
  editor.mount(root);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, blocks as never);
  return { editor, doc, root };
}

/**
 * How many entries the shared undo stack holds.
 * @param state - The editor state to read.
 * @returns The stack depth.
 * @throws {Error} When the undo plugin is not in this state, which would make
 *   the assertion built on it vacuous.
 */
function undoStackDepth(state: EditorState): number {
  const plugin = yUndoPluginKey.getState(state) as
    | { undoManager?: { undoStack?: readonly unknown[] } }
    | undefined;
  const stack = plugin?.undoManager?.undoStack;
  if (stack === undefined) {
    throw new Error('no y-undo plugin in this state');
  }
  return stack.length;
}

/** The numbers currently painted, in document order. */
function paintedNumbers(root: HTMLElement): string[] {
  return [...root.querySelectorAll('[data-doc-number]')].map(
    (el) => el.getAttribute('data-doc-number') ?? '',
  );
}

describe('the number reaches the screen', () => {
  it('carries an ordered list’s numbers, dot and all', () => {
    const { root } = open([
      { type: 'numberedListItem', content: 'one' },
      { type: 'numberedListItem', content: 'two' },
      { type: 'numberedListItem', content: 'three' },
    ]);
    expect(paintedNumbers(root)).toEqual(['1.', '2.', '3.']);
  });

  it('carries a numbered heading’s level path, which no built-in rule can draw', () => {
    const { root } = open([
      { type: 'heading', props: { level: 1, numbered: true }, content: 'one' },
      { type: 'heading', props: { level: 2, numbered: true }, content: 'two' },
    ]);
    expect(paintedNumbers(root)).toEqual(['1', '1.1']);
  });

  it('leaves prose and bullets unmarked', () => {
    const { root } = open([
      { type: 'paragraph', content: 'prose' },
      { type: 'bulletListItem', content: 'bullet' },
    ]);
    expect(paintedNumbers(root)).toEqual([]);
  });

  it('puts the attribute on the block’s own content element', () => {
    const { root } = open([{ type: 'numberedListItem', content: 'one' }]);
    const marked = root.querySelector('[data-doc-number]');
    expect(marked?.classList.contains('bn-block-content')).toBe(true);
  });

  it('numbers a document that already had content when it was opened', () => {
    // What a reader actually opens: a document that already has content in it,
    // rather than one filled by this same client after mounting.
    const source = new Y.Doc();
    const writer = buildDocumentEditor({
      fragment: documentBodyFragment(source),
      extensions: [documentNumberingExtension()],
    });
    writer.mount(document.createElement('div'));
    mounted.push(writer);
    writer.replaceBlocks(writer.document, [
      { type: 'numberedListItem', content: 'one' },
      { type: 'numberedListItem', content: 'two' },
    ] as never);

    const arrived = new Y.Doc();
    Y.applyUpdate(arrived, Y.encodeStateAsUpdate(source));
    const reader = buildDocumentEditor({
      fragment: documentBodyFragment(arrived),
      extensions: [documentNumberingExtension()],
    });
    const root = document.createElement('div');
    document.body.appendChild(root);
    reader.mount(root);
    mounted.push(reader);

    expect(paintedNumbers(root)).toEqual(['1.', '2.']);
  });

  it('follows the document as it changes', () => {
    const { editor, root } = open([
      { type: 'numberedListItem', content: 'one' },
      { type: 'numberedListItem', content: 'two' },
    ]);
    editor.insertBlocks(
      [{ type: 'numberedListItem', content: 'zero' }] as never,
      editor.document[0]!,
      'before',
    );
    expect(paintedNumbers(root)).toEqual(['1.', '2.', '3.']);
  });
});

describe('C10 — the number never reaches the document', () => {
  it('writes nothing when the caret merely moves', () => {
    const { editor, doc } = open([
      { type: 'numberedListItem', content: 'one' },
      { type: 'numberedListItem', content: 'two' },
      { type: 'numberedListItem', content: 'three' },
    ]);
    const fragment = documentBodyFragment(doc);
    const before = fragment.toString();
    const view = editor.prosemirrorView!;
    const undoDepth = (): number => undoStackDepth(view.state);

    const depthBefore = undoDepth();
    const docBefore = view.state.doc;
    let dispatched = 0;
    const original = view.dispatch.bind(view);
    view.dispatch = (tr): void => {
      dispatched += 1;
      original(tr);
    };

    // One caret move, to the end of the second block.
    const target = TextSelection.near(view.state.doc.resolve(1));
    view.dispatch(view.state.tr.setSelection(target));

    expect(fragment.toString()).toBe(before);
    expect(undoDepth()).toBe(depthBefore);
    // Identity, not equality: a plugin appending a transaction of its own is
    // merged into the same apply and never reaches the counter below, so the
    // document object itself is what says whether anything touched it.
    expect(view.state.doc).toBe(docBefore);
    // Only the one this test sent reached the view.
    expect(dispatched).toBe(1);
  });

  it('keeps the numbers out of the stored props', () => {
    const { editor, doc } = open([
      { type: 'numberedListItem', content: 'one' },
      { type: 'numberedListItem', content: 'two' },
    ]);
    const stored = documentBodyFragment(doc).toString();
    expect(stored).not.toContain('doc-number');
    // The attribute spelling and the prop spelling are different strings, so
    // the line above would miss a number written under the second one.
    expect(stored).not.toContain('docNumber');
    editor.document.forEach((block) => {
      const { props } = block as { props: Readonly<Record<string, unknown>> };
      expect(Object.keys(props)).not.toContain('docNumber');
    });
  });
});
