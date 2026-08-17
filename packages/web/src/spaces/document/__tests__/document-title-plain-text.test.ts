// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * What gets typed into the title stays text.
 *
 * The editor turns certain typed sequences into blocks — `# ` into a heading,
 * `> ` into a quote, `- ` into a list. The title holds text and nothing else,
 * so none of those blocks can go there. **How they fail to go there is not the
 * same for all of them, and that difference decides what these cases are
 * worth.**
 *
 * A rule built with `nodeInputRule` deletes the matched text and then inserts
 * its node. The insert is refused by the schema; the deletion already happened.
 * The typed characters are gone and nothing takes their place — measured when
 * this file was first written: three dashes at the start of the title left the
 * title EMPTY.
 *
 * A rule built with `textblockTypeInputRule` or `wrappingInputRule` changes or
 * wraps the block instead. Neither is legal on the title, so the command
 * declines and nothing happens at all — the typed characters stay put with no
 * help from anyone.
 *
 * **The only rule of the first kind this editor shipped was the divider, and
 * it has been removed (#111.)** Measured 2026-08-15 on this build, with the
 * guard's typing door switched off: `#`, `>`, `-`, `1.`, ` ``` `, `***`, `___`
 * and `---` all survived in the title, while `#`, `>` and `-` in a body
 * paragraph produced a heading, a quote and a list as they always did.
 *
 * So the cases below now pin a PRODUCT BEHAVIOUR — these sequences stay text in
 * the title — and no longer demonstrate the guard doing anything, because
 * today nothing would destroy them either way. What still holds the guard to
 * account is the white-box case at the bottom of this file. Whether the guard
 * is still needed at all is task #118, deliberately not decided here.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import type { Plugin } from '@tiptap/pm/state';
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

// THE SIX CASES THAT USED TO BE HERE ARE GONE, and deleting them is the honest
// move rather than a loss of coverage.
//
// They covered the three doors into the rules other than typing — Enter (which
// the input-rule plugin runs the rules for, as the text "\n"), an input method
// committing, and a programmatic insert asking for rules to apply — using
// `***`, `___` and `---`. All three of those were ONE pattern, the divider's
// (`^(?:---|—-|___\s|\*\*\*\s)$`), and the divider is gone (#111). Nothing
// fires for them now, so all six passed whether the guard existed or not.
//
// Substituting live sequences was tried and does not rescue them. Measured
// 2026-08-15 with `filterTransaction` switched off: `#`, `>`, `-`, `1.` and
// ` ``` ` each followed by Enter left the title holding exactly what was typed,
// every time. Those rules change or wrap a block, which the title refuses, so
// there is nothing for the other doors to destroy either.
//
// Six cases that cannot fail are worse than none: they read as protection.
// Whether the guard they were written for is still needed is task #118.

describe('the body still transforms what is typed into it', () => {
  it('a quote marker in a body paragraph still makes a quote', () => {
    // The guard is about the title, not about turning the editor's own rules
    // off. If this ever goes red the fix has reached too far.
    const editor = open();
    editor.commands.setContent(
      '<h1 class="doc-title"></h1><p>body</p><p></p>',
    );
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    type(editor, '> ');

    expect(editor.getHTML()).toContain('<blockquote');
  });
});

describe('what the guard judges by', () => {
  /**
   * The editor's input-rule plugins, found the way the guard finds them.
   * @param editor - The editor to look in.
   * @returns Those plugins.
   */
  function inputRulePlugins(editor: Editor): Plugin[] {
    return editor.state.plugins.filter(
      (p) => (p.spec as { isInputRules?: boolean }).isInputRules === true,
    );
  }

  it('refuses a rule that acted on the title', () => {
    const editor = open();
    editor.commands.insertContentAt(1, 'AB');
    editor.commands.setTextSelection(3);
    const plugin = inputRulePlugins(editor)[0];
    expect(plugin).toBeDefined();

    const tr = editor.state.tr;
    tr.delete(1, 3);
    tr.setMeta(plugin!, { from: 1, to: 3, text: '' });
    editor.view.dispatch(tr);

    expect(editor.state.doc.child(0).textContent).toBe('AB');
  });

  it('lets through a rule that acted on the body, caret in the title or not', () => {
    // The position the rule recorded is what decides it, not where the caret
    // happens to rest. Nothing sets `applyInputRules` in this editor today, so
    // this pins the criterion rather than a path a user can walk.
    const editor = open();
    editor.commands.insertContentAt(1, 'AB');
    editor.commands.setTextSelection(3);
    const bodyStart = editor.state.doc.child(0).nodeSize + 1;
    const plugin = inputRulePlugins(editor)[0];

    const tr = editor.state.tr;
    tr.insertText('X', bodyStart);
    tr.setMeta(plugin!, { from: bodyStart, to: bodyStart, text: 'X' });
    editor.view.dispatch(tr);

    expect(editor.state.doc.child(1).textContent).toBe('Xbody');
    expect(editor.state.doc.child(0).textContent).toBe('AB');
  });
});
