// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * What gets typed into the title stays text.
 *
 * The editor turns certain typed sequences into blocks — three dashes into a
 * divider, `# ` into a heading, `> ` into a quote, `- ` into a list. The title
 * holds text and nothing else, so none of those blocks can go there, and the
 * rule's replacement is simply dropped by the schema. What is NOT dropped is
 * the deletion the rule performed first: the characters the user typed are
 * gone and nothing takes their place. Measured before this was written — three
 * dashes at the start of the title left the title empty.
 *
 * Nothing about that is specific to dashes. Every one of these rules replaces
 * the matched text with a block, so every one of them destroys what was typed.
 * The cases below are one per rule the editor ships, which is what makes this a
 * statement about the title rather than about dashes.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import * as Y from 'yjs';
import { documentBodyFragment, encodeInitialSpaceContent } from '@breatic/shared';

import { buildDocumentExtensions } from '@web/spaces/document/document-extensions';

const editors: Editor[] = [];

afterEach(() => {
  editors.splice(0).forEach((e) => {
    e.destroy();
  });
});

/**
 * An empty-titled document with one body paragraph.
 * @returns The editor.
 */
function open(): Editor {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, encodeInitialSpaceContent('document', ''));
  const editor = new Editor({
    extensions: buildDocumentExtensions({ fragment: documentBodyFragment(doc) }),
  });
  editors.push(editor);
  editor.commands.setContent('<h1 class="doc-title"></h1><p>body</p>');
  return editor;
}

/**
 * Type text one character at a time, the way the editor receives it.
 *
 * Through `handleTextInput`, which is the path the transforming rules listen
 * on — `insertContent` bypasses them and would report success either way.
 * @param editor - The editor to type into.
 * @param text - What to type.
 */
function type(editor: Editor, text: string): void {
  for (const ch of text) {
    const { from, to } = editor.state.selection;
    const handled = editor.view.someProp('handleTextInput', (f) =>
      f(editor.view, from, to, ch, () => editor.state.tr.insertText(ch, from, to)),
    );
    if (!handled) editor.commands.insertContent(ch);
  }
}

describe('typing a block-making sequence into the title', () => {
  const SEQUENCES: readonly { name: string; typed: string }[] = [
    { name: 'a divider', typed: '---' },
    { name: 'a heading', typed: '# ' },
    { name: 'a quote', typed: '> ' },
    { name: 'a bullet list', typed: '- ' },
    { name: 'an ordered list', typed: '1. ' },
    { name: 'a code block', typed: '```' },
  ];

  SEQUENCES.forEach(({ name, typed }) => {
    it(`keeps the characters that would have made ${name}`, () => {
      const editor = open();
      editor.commands.setTextSelection(1);
      type(editor, typed);

      expect(editor.state.doc.child(0).type.name).toBe('title');
      expect(editor.state.doc.child(0).textContent).toBe(typed);
      // And the body is exactly as it was — no block appeared anywhere.
      expect(editor.state.doc.childCount).toBe(2);
      expect(editor.state.doc.child(1).type.name).toBe('paragraph');
      expect(editor.state.doc.child(1).textContent).toBe('body');
    });
  });

  it('leaves ordinary typing in the title alone', () => {
    const editor = open();
    editor.commands.setTextSelection(1);
    type(editor, 'Storyboard v3');

    expect(editor.state.doc.child(0).textContent).toBe('Storyboard v3');
  });

  it('replaces a selection, as typing over one does', () => {
    const editor = open();
    editor.commands.insertContentAt(1, 'OLD');
    editor.commands.setTextSelection({ from: 1, to: 1 + 3 });
    type(editor, 'X');

    expect(editor.state.doc.child(0).textContent).toBe('X');
  });
});

describe('the rules have more than one way in, and none of them works', () => {
  // Typing is one door. TipTap's input-rule plugin opens three more: Enter
  // (which it runs the rules for, as the text "\n"), an input method
  // committing, and a programmatic insert asking for rules to apply. Measured
  // with only the typing door guarded: `***` then Enter left the title EMPTY.
  const DESTRUCTIVE: readonly string[] = ['***', '___', '---'];

  DESTRUCTIVE.forEach((typed) => {
    it(`keeps ${typed} in the title when Enter follows it`, () => {
      const editor = open();
      editor.commands.setTextSelection(1);
      type(editor, typed);
      editor.view.someProp('handleKeyDown', (f) =>
        f(editor.view, new KeyboardEvent('keydown', { key: 'Enter' })),
      );

      expect(editor.state.doc.child(0).textContent).toBe(typed);
      // And the Enter did its own job rather than being eaten: the caret left
      // the title for a new, empty body block.
      expect(editor.state.doc.child(1).type.name).toBe('paragraph');
      expect(editor.state.doc.child(1).textContent).toBe('');
      expect(editor.state.selection.$from.parent.type.name).toBe('paragraph');
    });

    it(`keeps ${typed} in the title when an input method commits after it`, async () => {
      const editor = open();
      editor.commands.setTextSelection(1);
      // An input method's text arrives already committed, then the event
      // fires — it does not come through `handleTextInput` at all.
      editor.commands.insertContent(`${typed} `);
      editor.view.someProp('handleDOMEvents', (handlers) => {
        handlers['compositionend']?.(
          editor.view,
          new CompositionEvent('compositionend'),
        );
        return false;
      });
      // The plugin schedules the run rather than performing it inline.
      await new Promise((resolve) => setTimeout(resolve, 5));

      expect(editor.state.doc.child(0).textContent).toBe(`${typed} `);
    });
  });
});

describe('the body still transforms what is typed into it', () => {
  it('three dashes in a body paragraph still make a divider', () => {
    // The guard is about the title, not about turning the editor's own rules
    // off. If this ever goes red the fix has reached too far.
    const editor = open();
    editor.commands.setContent(
      '<h1 class="doc-title"></h1><p>body</p><p></p>',
    );
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    type(editor, '---');

    expect(editor.getHTML()).toContain('<hr');
  });
});
