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
import { Selection, TextSelection } from '@tiptap/pm/state';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import {
  _resetDocumentEditorCacheForTests,
  adoptDocumentEditor,
  getDocumentEditor,
} from '@web/spaces/document/document-editor-cache';
import { createDocumentUndo } from '@web/spaces/document/document-undo-blocknote';
import { setColour } from '@web/spaces/document/document-colour-run';
import { MARK_TOOLS } from '@web/spaces/document/document-tools';
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
  return { editor, doc, undo, end: Selection.atEnd(view.state.doc).from };
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
function chord(editor: DocumentEditor, key: string, shift = false): boolean {
  const view = editor.prosemirrorView!;
  return (
    view.someProp('handleKeyDown', (fn) =>
      fn(view, new KeyboardEvent('keydown', { key, ctrlKey: true, shiftKey: shift })),
    ) === true
  );
}

/** The chords tiptap binds for the five styles, and the mark each carries. */
const CHORDS = [
  ['b', 'bold', false],
  ['i', 'italic', false],
  ['u', 'underline', false],
  ['s', 'strike', true],
  ['e', 'code', false],
] as const;

describe('a keyboard chord leaves the break bare', () => {
  it.each(CHORDS)('Mod-%s writes %s onto text alone', (key, mark, shift) => {
    const { editor, end } = openBrokenLine();
    select(editor, 3, end);

    expect(chord(editor, key, shift)).toBe(true);

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

describe('typing where a break interrupts a styled line', () => {
  /**
   * Types one character at a caret, the way ProseMirror does.
   * @param editor - The editor.
   * @param at - Where the caret goes first.
   */
  function typeAt(editor: DocumentEditor, at: number): void {
    const view = editor.prosemirrorView!;
    view.dispatch(
      view.state.tr.setSelection(TextSelection.create(view.state.doc, at, at)),
    );
    const next = editor.prosemirrorView!;
    next.dispatch(next.state.tr.insertText('X', at, at));
  }

  /**
   * Where the line's hard break sits.
   * @param editor - The editor.
   * @returns Its position.
   */
  function breakAt(editor: DocumentEditor): number {
    let at = -1;
    editor.prosemirrorState.doc.descendants((node, pos) => {
      if (node.type.name === 'hardBreak') {
        at = pos;
      }
      return true;
    });
    return at;
  }

  it.each(CHORDS)('continues %s past the break', (key, mark, shift) => {
    // A12: typing at the end of a styled region continues it. The break is
    // inside the region, and it carries nothing — so what the next character
    // takes has to come from the text on the other side of it.
    const { editor, end } = openBrokenLine();
    select(editor, 3, end);
    chord(editor, key, shift);

    typeAt(editor, breakAt(editor) + 1);

    expect(inlineShape(editor)).toEqual([
      `"abc"[${mark}]`,
      '<hardBreak>[]',
      `"Xdef"[${mark}]`,
    ]);
  });

  it('continues a colour row past the break, and into Yjs', () => {
    const { editor, doc, end } = openBrokenLine();
    select(editor, 3, end);
    setColour(editor, 'textColor', 'red');

    typeAt(editor, breakAt(editor) + 1);

    expect(inlineShape(editor)).toEqual([
      '"abc"[textColor]',
      '<hardBreak>[]',
      '"Xdef"[textColor]',
    ]);
    // What every peer reads: one coloured run on each side, no bare character.
    expect(documentBodyFragment(doc).toString()).not.toContain(
      '</hardbreak>X',
    );
  });

  it('leaves the character bare where the text either side is bare', () => {
    // The rule reads the document rather than remembering a press: an
    // unstyled line stays unstyled.
    const { editor } = openBrokenLine();

    typeAt(editor, breakAt(editor) + 1);

    expect(inlineShape(editor)).toEqual([
      '"abc"[]',
      '<hardBreak>[]',
      '"Xdef"[]',
    ]);
  });

  it('reads back past a run of bare nodes, not just the nearest one', () => {
    // Two breaks in a row is the empty line a reader makes by pressing
    // Shift+Enter twice. The style still comes from the text before them.
    const { editor } = openBrokenLine();
    const second = breakAt(editor) + 1;
    const view = editor.prosemirrorView!;
    view.dispatch(
      view.state.tr.setSelection(
        TextSelection.create(view.state.doc, second, second),
      ),
    );
    view.someProp('handleKeyDown', (fn) =>
      fn(view, new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true })),
    );
    select(editor, 3, Selection.atEnd(editor.prosemirrorState.doc).from);
    MARK_TOOLS.find((tool) => tool.id === 'bold')!.run(editor);

    typeAt(editor, breakAt(editor) + 1);

    expect(inlineShape(editor)).toEqual([
      '"abc"[bold]',
      '<hardBreak>[]',
      '<hardBreak>[]',
      '"Xdef"[bold]',
    ]);
  });

  it('takes what is behind the break, not what is ahead of it', () => {
    // Style only the first half of the line. The two sides now disagree, and
    // the answer is the one behind — which is what `marks` reads and what a
    // reader who just styled that half expects the next character to join.
    const { editor } = openBrokenLine();
    select(editor, 3, breakAt(editor));
    MARK_TOOLS.find((tool) => tool.id === 'bold')!.run(editor);

    typeAt(editor, breakAt(editor) + 1);

    expect(inlineShape(editor)).toEqual([
      '"abc"[bold]',
      '<hardBreak>[]',
      '"X"[bold]',
      '"def"[]',
    ]);
  });
});

describe('what the caret reads is what ProseMirror reads, one node further back', () => {
  /**
   * Types one character at a caret.
   * @param editor - The editor.
   * @param at - Where.
   */
  function typeAt(editor: DocumentEditor, at: number): void {
    const view = editor.prosemirrorView!;
    view.dispatch(
      view.state.tr.setSelection(TextSelection.create(view.state.doc, at, at)),
    );
    const next = editor.prosemirrorView!;
    next.dispatch(next.state.tr.insertText('X', at, at));
  }

  /**
   * Where the line's hard break sits.
   * @param editor - The editor.
   * @returns Its position.
   */
  function breakPos(editor: DocumentEditor): number {
    let at = -1;
    editor.prosemirrorState.doc.descendants((node, pos) => {
      if (node.type.name === 'hardBreak') {
        at = pos;
      }
      return true;
    });
    return at;
  }

  it('leaves a link where it ended, because link declares itself exclusive', () => {
    // `link` sets `inclusive: false` so typing cannot extend it, and
    // `ResolvedPos.marks()` honours that by dropping such a mark when the node
    // ahead does not carry it. Reaching one node further back changes which
    // node answers, not which rule applies.
    const { editor } = openBrokenLine();
    applyLink(editor, { from: 3, to: breakPos(editor) }, 'https://x.test/');

    typeAt(editor, breakPos(editor) + 1);

    expect(inlineShape(editor)).toEqual([
      '"abc"[link]',
      '<hardBreak>[]',
      '"Xdef"[]',
    ]);
  });

  it('carries a link across where the text ahead is part of the same link', () => {
    const { editor, end } = openBrokenLine();
    applyLink(editor, { from: 3, to: end }, 'https://x.test/');

    typeAt(editor, breakPos(editor) + 1);

    expect(inlineShape(editor)).toEqual([
      '"abc"[link]',
      '<hardBreak>[]',
      '"Xdef"[link]',
    ]);
  });

  /**
   * A line whose only break opens it, so nothing sits behind that caret.
   * @returns The editor.
   */
  function openLineThatStartsWithABreak(): DocumentEditor {
    const doc = new Y.Doc();
    const editor = buildDocumentEditor({
      fragment: documentBodyFragment(doc),
      extensions: [marksStayOnTextExtension()],
    });
    editor.mount(document.createElement('div'));
    mounted.push(editor);
    editor.replaceBlocks(editor.document, [
      { type: 'paragraph', content: 'abc' } as never,
    ]);
    const view = editor.prosemirrorView!;
    view.dispatch(
      view.state.tr.setSelection(TextSelection.create(view.state.doc, 3, 3)),
    );
    view.someProp('handleKeyDown', (fn) =>
      fn(view, new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true })),
    );
    return editor;
  }

  it('reads forward where the break opens the line', () => {
    // `ResolvedPos.marks()` swaps to the node ahead when nothing sits behind
    // the caret. A line that begins with a break has exactly that shape.
    const editor = openLineThatStartsWithABreak();
    select(editor, 4, Selection.atEnd(editor.prosemirrorState.doc).from);
    MARK_TOOLS.find((tool) => tool.id === 'bold')!.run(editor);

    typeAt(editor, breakPos(editor) + 1);

    expect(inlineShape(editor)).toEqual(['<hardBreak>[]', '"Xabc"[bold]']);
  });

  it('drops a link where the break opens the line, as the swap does', () => {
    // Swapping leaves no node on the other side, so `marks()` drops every
    // `inclusive: false` mark. Typing in front of a link does not join it —
    // the same answer the caret gets in front of a link with no break at all.
    const editor = openLineThatStartsWithABreak();
    applyLink(
      editor,
      { from: 4, to: Selection.atEnd(editor.prosemirrorState.doc).from },
      'https://x.test/',
    );

    typeAt(editor, breakPos(editor) + 1);

    expect(inlineShape(editor)).toEqual([
      '<hardBreak>[]',
      '"X"[]',
      '"abc"[link]',
    ]);
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
    select(editor, 3, Selection.atEnd(view.state.doc).from);

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
    select(editor, 3, Selection.atEnd(view.state.doc).from);
    chord(editor, 'b');

    expect(inlineShape(editor)).toEqual([
      '"hi "[bold]',
      '<unsupportedInline>[]',
      '" there"[bold]',
    ]);
  });
});
