// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A style lives on text, whichever control put it there.
 *
 * The rule is the document's, not any one control's: a node the reader cannot
 * see a style on carries none. `hardBreak` is a line wrap, bold or not;
 * `unsupportedInline` stands in for vocabulary this build cannot draw. Yjs
 * agrees and more strongly — `y-prosemirror` maps a non-text inline node by
 * its attributes alone — so a mark on one lives in the writing client and
 * nowhere else.
 *
 * The bubble bar's own write walks text runs (`styleTheRuns`). Everything
 * else that can mark text reaches `tr.addMark` directly and covers every
 * inline node in the range: the five chords tiptap binds (`Mod-b`, `Mod-i`,
 * `Mod-u`, `Mod-Shift-s`, `Mod-e`), `applyLink`, and whatever a later slice
 * adds. `marksStayOnTextExtension` holds the rule for all of them at once,
 * which is what these cases pin.
 *
 * The cost of not holding it is not the invisible mark. It is what the mark
 * does next: it survives undo, the bar cannot reach it (every tool greys over
 * a lone break), and the reader's next character inherits it — into Yjs, where
 * every peer sees a bold letter on a line the writer just un-bolded.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { TextSelection } from '@tiptap/pm/state';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import {
  _resetDocumentEditorCacheForTests,
  adoptDocumentEditor,
  getDocumentEditor,
} from '@web/spaces/document/document-editor-cache';
import { createDocumentUndo } from '@web/spaces/document/document-undo-blocknote';
import { applyLink } from '@web/spaces/document/document-link';
import { marksStayOnTextExtension } from '@web/spaces/document/document-marks-on-text';

type DocumentEditor = ReturnType<typeof buildDocumentEditor>;

const mounted: DocumentEditor[] = [];

afterEach(() => {
  mounted.splice(0).forEach((editor) => {
    editor.unmount();
  });
});

/** An editor and the document behind it. */
interface Open {
  readonly editor: DocumentEditor;
  readonly doc: Y.Doc;
  readonly undo: ReturnType<typeof createDocumentUndo>;
  /** The last position of the paragraph's inline content. */
  readonly end: number;
}

/**
 * A mounted document holding `abc`, a hard break, then `def`.
 * @returns The editor, its doc and the end of the line.
 */
function openBrokenLine(): Open {
  const doc = new Y.Doc();
  const undo = createDocumentUndo(doc);
  const editor = buildDocumentEditor({
    fragment: documentBodyFragment(doc),
    extensions: [undo.extension, marksStayOnTextExtension()],
  });
  const root = document.createElement('div');
  document.body.appendChild(root);
  editor.mount(root);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, [
    { type: 'paragraph', content: 'abcdef' } as never,
  ]);
  const view = editor.prosemirrorView!;
  view.dispatch(
    view.state.tr.setSelection(TextSelection.create(view.state.doc, 6, 6)),
  );
  view.someProp('handleKeyDown', (fn) =>
    fn(view, new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true })),
  );
  return { editor, doc, undo, end: view.state.doc.content.size - 2 };
}

/**
 * Every inline node with the marks it carries.
 * @param editor - The editor.
 * @returns One line per node, in order.
 */
function inlineShape(editor: DocumentEditor): string[] {
  const out: string[] = [];
  editor.prosemirrorState.doc.descendants((node) => {
    if (!node.isInline) {
      return true;
    }
    const marks = node.marks.map((mark) => mark.type.name).join(',');
    out.push(
      node.isText ? `"${node.text}"[${marks}]` : `<${node.type.name}>[${marks}]`,
    );
    return true;
  });
  return out;
}

/**
 * Selects a range.
 * @param editor - The editor.
 * @param from - Where it starts.
 * @param to - Where it ends.
 */
function select(editor: DocumentEditor, from: number, to: number): void {
  const view = editor.prosemirrorView!;
  view.dispatch(
    view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)),
  );
}

/**
 * Fires a chord the way a browser delivers one.
 * @param editor - The editor.
 * @param key - The key pressed with the modifier.
 * @returns Whether a binding handled it.
 */
function chord(editor: DocumentEditor, key: string): boolean {
  const view = editor.prosemirrorView!;
  return (
    view.someProp('handleKeyDown', (fn) =>
      fn(view, new KeyboardEvent('keydown', { key, ctrlKey: true })),
    ) === true
  );
}

/** The chords tiptap binds for the five styles, and the mark each carries. */
const CHORDS = [
  ['b', 'bold'],
  ['i', 'italic'],
  ['u', 'underline'],
  ['e', 'code'],
] as const;

describe('a keyboard chord leaves the break bare', () => {
  it.each(CHORDS)('Mod-%s writes %s onto text alone', (key, mark) => {
    const { editor, end } = openBrokenLine();
    select(editor, 3, end);

    expect(chord(editor, key)).toBe(true);

    expect(inlineShape(editor)).toEqual([
      `"abc"[${mark}]`,
      '<hardBreak>[]',
      `"def"[${mark}]`,
    ]);
  });

  it('leaves nothing behind for the next character to inherit', () => {
    // The whole cost of the rule, in the sequence that shows it: bold the line
    // from the keyboard, change your mind and undo, then type after the break.
    // Undo takes back what Yjs holds, and Yjs never held the break's mark — so
    // a mark left there outlives the press that made it.
    const { editor, doc, undo, end } = openBrokenLine();
    undo.manager.stopCapturing();
    select(editor, 3, end);
    chord(editor, 'b');
    undo.manager.undo();

    const view = editor.prosemirrorView!;
    let breakAt = -1;
    view.state.doc.descendants((node, pos) => {
      if (node.type.name === 'hardBreak') {
        breakAt = pos;
      }
      return true;
    });
    const at = breakAt + 1;
    view.dispatch(
      view.state.tr
        .setSelection(TextSelection.create(view.state.doc, at, at))
        .insertText('X', at, at),
    );

    expect(inlineShape(editor)).toEqual(['"abc"[]', '<hardBreak>[]', '"Xdef"[]']);
    expect(documentBodyFragment(doc).toString()).not.toContain('<bold>');
  });
});

describe('the editor a reader actually gets', () => {
  afterEach(() => {
    _resetDocumentEditorCacheForTests();
  });

  it('holds the rule, which is what registering the extension buys', () => {
    // The cases above build their own editor and pass the extension in, so
    // they say what the rule does and not that anyone gets it. This one goes
    // through the assembly a document Space mounts.
    const doc = new Y.Doc();
    const handle = getDocumentEditor(doc, 'project-p/document-marks-on-text', {
      caretProvider: { awareness: new Awareness(doc) },
    } as never);
    const root = document.createElement('div');
    document.body.appendChild(root);
    adoptDocumentEditor(handle, root);
    const editor = handle.editor as unknown as DocumentEditor;
    editor.replaceBlocks(editor.document, [
      { type: 'paragraph', content: 'abcdef' } as never,
    ]);

    const view = editor.prosemirrorView!;
    view.dispatch(
      view.state.tr.setSelection(TextSelection.create(view.state.doc, 6, 6)),
    );
    view.someProp('handleKeyDown', (fn) =>
      fn(view, new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true })),
    );
    select(editor, 3, view.state.doc.content.size - 2);

    expect(chord(editor, 'b')).toBe(true);

    expect(inlineShape(editor)).toEqual([
      '"abc"[bold]',
      '<hardBreak>[]',
      '"def"[bold]',
    ]);
  });
});

describe('every other writer obeys the same rule', () => {
  it('keeps a link off the break, so a peer reads one link and not two', () => {
    const { editor, doc, end } = openBrokenLine();

    applyLink(editor, { from: 3, to: end }, 'https://x.test/');

    expect(inlineShape(editor)).toEqual([
      '"abc"[link]',
      '<hardBreak>[]',
      '"def"[link]',
    ]);
    // What the peer loads is what the writer sees: two anchors either way.
    expect(documentBodyFragment(doc).toString()).not.toContain(
      '<link href="https://x.test/"><hardbreak>',
    );
  });

  it('keeps a mark off the stand-in for vocabulary this build cannot draw', () => {
    // Built as a remote update, the way a peer on a newer build writes one.
    const remote = new Y.Doc();
    const fragment = documentBodyFragment(remote);
    const paragraph = new Y.XmlElement('paragraph');
    paragraph.setAttribute('backgroundColor', 'default');
    paragraph.setAttribute('textColor', 'default');
    paragraph.setAttribute('textAlignment', 'left');
    const head = new Y.XmlText();
    head.insert(0, 'hi ');
    const tail = new Y.XmlText();
    tail.insert(0, ' there');
    paragraph.insert(0, [
      head,
      new Y.XmlElement('futureMention'),
      tail,
    ] as never);
    const container = new Y.XmlElement('blockContainer');
    container.setAttribute('id', 'a');
    container.insert(0, [paragraph]);
    const group = new Y.XmlElement('blockGroup');
    group.insert(0, [container]);
    fragment.insert(0, [group]);

    const local = new Y.Doc();
    Y.applyUpdate(local, Y.encodeStateAsUpdate(remote));
    const editor = buildDocumentEditor({
      fragment: documentBodyFragment(local),
      extensions: [marksStayOnTextExtension()],
    });
    editor.mount(document.createElement('div'));
    mounted.push(editor);

    const view = editor.prosemirrorView!;
    select(editor, 3, view.state.doc.content.size - 2);
    chord(editor, 'b');

    expect(inlineShape(editor)).toEqual([
      '"hi "[bold]',
      '<unsupportedInline>[]',
      '" there"[bold]',
    ]);
  });
});
