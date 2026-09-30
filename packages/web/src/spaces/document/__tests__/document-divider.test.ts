// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * #124: placing a divider, and a divider inside the reader's selection.
 *
 * A1 — `---` typed at the head of a line puts a divider above that line and
 * leaves the line where it is, caret at its start. A2 — the handle menu's
 * Divider row puts one under the pressed row with an empty line beneath it.
 * A3 · A6 — a no-text block inside the reader's selection carries the class
 * `index.css` paints the selection band with. A12 — the shared vocabulary
 * lists the divider.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as Y from 'yjs';
import { AllSelection, NodeSelection, TextSelection } from '@tiptap/pm/state';

import { DOCUMENT_SCHEMA, documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { insertDividerForMenu } from '@web/spaces/document/document-divider';
import { IN_SELECTION_CLASS } from '@web/spaces/document/document-selection-paint';

type Editor = ReturnType<typeof buildDocumentEditor>;

const mounted: Editor[] = [];

afterEach(() => {
  mounted.splice(0).forEach((editor) => {
    editor.unmount();
  });
});

/**
 * Opens an editor holding the given blocks.
 * @param blocks - What the document starts with.
 * @returns The editor.
 */
function open(blocks: unknown[]): Editor {
  const editor = buildDocumentEditor({
    fragment: documentBodyFragment(new Y.Doc()),
  });
  const root = document.createElement('div');
  document.body.appendChild(root);
  editor.mount(root);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, blocks as never);
  return editor;
}

/** A block as this file reads it. */
interface Seen {
  id: string;
  type: string;
  props: Record<string, unknown>;
  content?: { text?: string }[];
  children?: Seen[];
}

/**
 * The document as `type:text` entries, children nested.
 * @param blocks - Blocks to describe.
 * @returns One entry per block.
 */
function shape(blocks: readonly unknown[]): unknown[] {
  return (blocks as Seen[]).map((block) => {
    const text = (block.content ?? []).map((c) => c.text ?? '').join('');
    const kids = block.children ?? [];
    const entry = `${block.type}:${text}`;
    return kids.length > 0 ? [entry, shape(kids)] : entry;
  });
}

/**
 * Types the given text one character at a time, through the input rules.
 * @param editor - The editor to type in.
 * @param text - What to type.
 */
function type(editor: Editor, text: string): void {
  const view = editor.prosemirrorView!;
  for (const character of text) {
    const { from, to } = view.state.selection;
    const claimed =
      view.someProp('handleTextInput', (handler) =>
        handler(view, from, to, character, () => view.state.tr),
      ) ?? false;
    if (!claimed) {
      view.dispatch(view.state.tr.insertText(character, from, to));
    }
  }
}

/**
 * Where the caret is, as the block it stands in and the offset into it.
 * @param editor - The editor to read.
 * @returns The caret, or null when the selection is not a caret.
 */
function caret(editor: Editor): { text: string; offset: number } | null {
  const selection = editor.prosemirrorView!.state.selection;
  if (!(selection instanceof TextSelection) || !selection.empty) return null;
  return {
    text: selection.$head.parent.textContent,
    offset: selection.$head.parentOffset,
  };
}

/**
 * Puts the caret at the start of the block holding this text.
 * @param editor - The editor.
 * @param text - The block's text.
 */
function caretAtStartOf(editor: Editor, text: string): void {
  const block = (editor.document as Seen[]).find(
    (b) => (b.content ?? []).map((c) => c.text ?? '').join('') === text,
  )!;
  editor.setTextCursorPosition(block.id, 'start');
}

describe('--- at the head of a line (A1)', () => {
  it('puts a divider above an empty line and leaves the caret in that line', () => {
    const editor = open([
      { type: 'paragraph', content: 'Above' },
      { type: 'paragraph', content: '' },
      { type: 'paragraph', content: 'Below' },
    ]);
    editor.setTextCursorPosition((editor.document as Seen[])[1]!.id, 'start');

    type(editor, '---');

    expect(shape(editor.document)).toEqual([
      'paragraph:Above',
      'divider:',
      'paragraph:',
      'paragraph:Below',
    ]);
    expect(caret(editor)).toEqual({ text: '', offset: 0 });
  });

  it('keeps the words after the caret on the line below the divider', () => {
    const editor = open([
      { type: 'paragraph', content: 'Above' },
      { type: 'paragraph', content: 'three words' },
      { type: 'paragraph', content: 'Below' },
    ]);
    caretAtStartOf(editor, 'three words');

    type(editor, '---');

    expect(shape(editor.document)).toEqual([
      'paragraph:Above',
      'divider:',
      'paragraph:three words',
      'paragraph:Below',
    ]);
    expect(caret(editor)).toEqual({ text: 'three words', offset: 0 });
  });

  it('leaves the line its own type', () => {
    const editor = open([
      { type: 'heading', props: { level: 2 }, content: 'Title' },
    ]);
    caretAtStartOf(editor, 'Title');

    type(editor, '---');

    expect(shape(editor.document)).toEqual(['divider:', 'heading:Title']);
    expect((editor.document as Seen[])[1]!.props['level']).toBe(2);
  });

  it('gives the divider the quote the line is in, and keeps the line in it', () => {
    const editor = open([
      { type: 'paragraph', props: { quoted: true }, content: 'quoted words' },
    ]);
    caretAtStartOf(editor, 'quoted words');

    type(editor, '---');

    const [divider, line] = editor.document as Seen[];
    expect(divider!.type).toBe('divider');
    expect(divider!.props['quoted']).toBe(true);
    expect(line!.props['quoted']).toBe(true);
  });

  it('works on the last line of the document', () => {
    const editor = open([{ type: 'paragraph', content: '' }]);
    editor.setTextCursorPosition((editor.document as Seen[])[0]!.id, 'start');

    type(editor, '---');

    expect(shape(editor.document)).toEqual(['divider:', 'paragraph:']);
    expect(caret(editor)).toEqual({ text: '', offset: 0 });
  });

  it('does nothing inside a code block', () => {
    const editor = open([{ type: 'codeBlock', content: '' }]);
    editor.setTextCursorPosition((editor.document as Seen[])[0]!.id, 'start');

    type(editor, '---');

    expect(shape(editor.document)).toEqual(['codeBlock:---']);
  });

  it('does not fire when the dashes are not at the head of the line', () => {
    const editor = open([{ type: 'paragraph', content: 'a' }]);
    editor.setTextCursorPosition((editor.document as Seen[])[0]!.id, 'end');

    type(editor, '---');

    expect(shape(editor.document)).toEqual(['paragraph:a---']);
  });
});

describe('the handle menu Divider row (A2)', () => {
  it('puts a divider under the pressed row and an empty line under it, caret there', () => {
    const editor = open([
      { type: 'paragraph', content: 'pressed' },
      { type: 'paragraph', content: 'after' },
    ]);

    insertDividerForMenu(editor, (editor.document as Seen[])[0] as never);

    expect(shape(editor.document)).toEqual([
      'paragraph:pressed',
      'divider:',
      'paragraph:',
      'paragraph:after',
    ]);
    expect(caret(editor)).toEqual({ text: '', offset: 0 });
  });

  it('keeps both inside the quote the pressed row is in', () => {
    const editor = open([
      { type: 'paragraph', props: { quoted: true }, content: 'pressed' },
    ]);

    insertDividerForMenu(editor, (editor.document as Seen[])[0] as never);

    const [, divider, line] = editor.document as Seen[];
    expect(divider!.props['quoted']).toBe(true);
    expect(line!.props['quoted']).toBe(true);
  });

  it('goes before the pressed row children, like every other insert-below row', () => {
    const editor = open([
      {
        type: 'bulletListItem',
        content: 'parent',
        children: [{ type: 'bulletListItem', content: 'child' }],
      },
    ]);

    insertDividerForMenu(editor, (editor.document as Seen[])[0] as never);

    expect(shape(editor.document)).toEqual([
      [
        'bulletListItem:parent',
        ['divider:', 'paragraph:', 'bulletListItem:child'],
      ],
    ]);
  });
});

describe('a no-text block inside the reader selection (A3 · A6)', () => {
  /**
   * Whether each block's own element carries the band's class.
   * @param editor - The editor.
   * @param selector - How that block's element is found.
   * @returns One entry per block found, in order.
   */
  function painted(editor: Editor, selector: string): boolean[] {
    const dom = editor.prosemirrorView!.dom;
    return [...dom.querySelectorAll(selector)].map((el) =>
      el.classList.contains(IN_SELECTION_CLASS),
    );
  }

  /** How a divider's element is found. */
  const DIVIDER_EL = '[data-content-type="divider"]';

  /** How a fallback block's element is found (`document-unsupported-blocknote.ts`). */
  const FALLBACK_EL = '[data-unsupported-block]';

  /**
   * A three-block document with the divider in the middle, focused.
   * @returns The editor.
   */
  function sandwich(): Editor {
    const editor = open([
      { type: 'paragraph', content: 'Above' },
      { type: 'divider' },
      { type: 'paragraph', content: 'Below' },
    ]);
    editor.prosemirrorView!.focus();
    return editor;
  }

  /**
   * Where the divider node starts.
   * @param editor - The editor.
   * @returns Its position.
   */
  function dividerPos(editor: Editor): number {
    let at = -1;
    editor.prosemirrorView!.state.doc.descendants((node, pos) => {
      if (node.type.name === 'divider') at = pos;
      return at < 0;
    });
    return at;
  }

  it('is painted when it is node-selected', () => {
    const editor = sandwich();
    const view = editor.prosemirrorView!;
    view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, dividerPos(editor))));

    expect(painted(editor, DIVIDER_EL)).toEqual([true]);
  });

  it('is painted when a text selection runs across it', () => {
    const editor = sandwich();
    const view = editor.prosemirrorView!;
    const pos = dividerPos(editor);
    view.dispatch(
      view.state.tr.setSelection(TextSelection.create(view.state.doc, 4, pos + 8)),
    );

    expect(painted(editor, DIVIDER_EL)).toEqual([true]);
  });

  it('is painted under select-all', () => {
    const editor = sandwich();
    const view = editor.prosemirrorView!;
    view.dispatch(view.state.tr.setSelection(new AllSelection(view.state.doc)));

    expect(painted(editor, DIVIDER_EL)).toEqual([true]);
  });

  it('is not painted for a caret', () => {
    const editor = sandwich();
    const view = editor.prosemirrorView!;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 4)));

    expect(painted(editor, DIVIDER_EL)).toEqual([false]);
  });

  it('is not painted while the editor does not hold the focus', () => {
    const editor = sandwich();
    const view = editor.prosemirrorView!;
    view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, dividerPos(editor))));
    (view.dom as HTMLElement).blur();
    view.dispatch(view.state.tr);

    expect(painted(editor, DIVIDER_EL)).toEqual([false]);
  });

  /**
   * Puts the browser's own selection over a range of the body, the way a
   * drag does, and lets the editor read it back.
   * @param editor - The editor.
   * @param from - The text the range starts in.
   * @param to - The text the range ends in.
   */
  function dragAcross(editor: Editor, from: string, to: string): void {
    const dom = editor.prosemirrorView!.dom;
    const textOf = (words: string): Text => {
      const walker = document.createTreeWalker(dom, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
        if (n.textContent === words) return n as Text;
      }
      throw new Error(`no text reads ${words}`);
    };
    const range = document.createRange();
    range.setStart(textOf(from), 0);
    range.setEnd(textOf(to), to.length);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  }

  it('is painted under a drag in a read-only body, which never holds the focus', async () => {
    const editor = sandwich();
    editor.isEditable = false;
    (editor.prosemirrorView!.dom as HTMLElement).blur();

    dragAcross(editor, 'Above', 'Below');

    await expect.poll(() => painted(editor, DIVIDER_EL)).toEqual([true]);
  });

  it('is not painted once the browser selection leaves a read-only body', async () => {
    const editor = sandwich();
    editor.isEditable = false;
    (editor.prosemirrorView!.dom as HTMLElement).blur();
    dragAcross(editor, 'Above', 'Below');
    await expect.poll(() => painted(editor, DIVIDER_EL)).toEqual([true]);

    const outside = document.createElement('p');
    outside.textContent = 'elsewhere';
    document.body.appendChild(outside);
    const range = document.createRange();
    range.selectNodeContents(outside);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));

    await expect.poll(() => painted(editor, DIVIDER_EL)).toEqual([false]);
  });

  it('paints a fallback block inside a range, and not when it alone is node-selected', () => {
    const editor = open([
      { type: 'paragraph', content: 'Above' },
      { type: 'unsupportedBlock', props: { originalName: 'future' } },
      { type: 'paragraph', content: 'Below' },
    ]);
    const view = editor.prosemirrorView!;
    view.focus();
    view.dispatch(view.state.tr.setSelection(new AllSelection(view.state.doc)));
    expect(painted(editor, FALLBACK_EL)).toEqual([true]);

    let at = -1;
    view.state.doc.descendants((node, pos) => {
      if (node.type.name === 'unsupportedBlock') at = pos;
      return at < 0;
    });
    view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, at)));
    expect(painted(editor, FALLBACK_EL)).toEqual([false]);
  });
});

describe('the shared vocabulary (A12)', () => {
  it('lists the divider with the quote prop every block carries', () => {
    expect(DOCUMENT_SCHEMA.nodes['divider']).toEqual(['quoted']);
  });
});
