// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A note in the prompt box (inner#977): on an orange ground and named as a
 * note, on a line of its own at the top, deletable, never something the
 * reader can type or paste into being, and drawn as selected the way a
 * selected mention is.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import { Paragraph } from '@tiptap/extension-paragraph';
import { Placeholder } from '@tiptap/extension-placeholder';
import { Text } from '@tiptap/extension-text';
import { NodeSelection } from '@tiptap/pm/state';

import { t } from '@breatic/shared';

import {
  NOTE_SELECTED_CLASS,
  PROMPT_NOTE_NODE,
  PromptDocument,
  PromptNote,
} from '@web/features/prompt-note/prompt-note';

let editor: Editor | null = null;

afterEach(() => {
  editor?.destroy();
  editor = null;
});

/**
 * An editor holding a note above a line of words.
 * @param words - What the line under the note says.
 * @returns The editor.
 */
function withNote(words: string): Editor {
  editor = new Editor({
    element: document.createElement('div'),
    extensions: [
      PromptDocument,
      Paragraph,
      Text,
      PromptNote,
      Placeholder.configure({ placeholder: 'Describe it' }),
    ],
    content: {
      type: 'doc',
      content: [
        { type: PROMPT_NOTE_NODE, attrs: { label: 'Pick the first frame in the panel' } },
        { type: 'paragraph', content: words === '' ? [] : [{ type: 'text', text: words }] },
      ],
    },
  });
  return editor;
}

/**
 * The node types at the top of the document.
 * @param e - The editor.
 * @returns One name per top-level node.
 */
function blocks(e: Editor): string[] {
  const names: string[] = [];
  e.state.doc.forEach((node) => names.push(node.type.name));
  return names;
}

/**
 * The note's element on screen.
 * @param e - The editor.
 * @returns The element.
 */
function noteElement(e: Editor): HTMLElement {
  const found = e.view.dom.querySelector<HTMLElement>('[data-prompt-note]');
  if (!found) throw new Error('no note on screen');
  return found;
}

describe('a note the reader did not get from us', () => {
  it('cannot be typed', () => {
    const e = withNote('She walks.');
    e.commands.insertContentAt(e.state.doc.content.size - 1, '(💡 make it rain)');
    expect(blocks(e)).toEqual([PROMPT_NOTE_NODE, 'paragraph']);
  });

  it('cannot be pasted in from markup that looks like one', () => {
    const e = withNote('She walks.');
    e.commands.insertContentAt(
      e.state.doc.content.size - 1,
      '<div class="prompt-note" data-prompt-note="">fake</div>',
    );
    expect(blocks(e).filter((name) => name === PROMPT_NOTE_NODE)).toHaveLength(1);
  });
});

describe('deleting a note', () => {
  it('takes one Backspace from the start of the line below, which keeps its words', () => {
    const e = withNote('She walks.');
    e.commands.setTextSelection(e.state.doc.child(0).nodeSize + 1);
    e.commands.keyboardShortcut('Backspace');
    expect(blocks(e)).toEqual(['paragraph']);
    expect(e.state.doc.textContent).toBe('She walks.');
  });

  it('takes one Backspace or Delete once it is picked', () => {
    const e = withNote('She walks.');
    e.commands.setNodeSelection(0);
    expect(e.state.selection).toBeInstanceOf(NodeSelection);
    e.commands.keyboardShortcut('Delete');
    expect(blocks(e)).toEqual(['paragraph']);
  });

  it('never leaves the box holding the note alone, with nowhere to write', () => {
    const e = withNote('');
    e.commands.setTextSelection(e.state.doc.child(0).nodeSize + 1);
    e.commands.keyboardShortcut('Backspace');
    e.commands.keyboardShortcut('Delete');
    expect(blocks(e).at(-1)).toBe('paragraph');
  });
});

describe('how a note reads', () => {
  it('says it is a note before its words, and keeps its words as they were', () => {
    const e = withNote('She walks.');
    const prefix = t('canvas.generatePanel.notePrefix');
    expect(prefix).not.toBe('canvas.generatePanel.notePrefix');
    expect(noteElement(e).querySelector('[data-prompt-note-prefix]')?.textContent).toBe(prefix);
    expect(noteElement(e).textContent).toBe(`${prefix}Pick the first frame in the panel`);
    expect(e.state.doc.child(0).attrs.label).toBe('Pick the first frame in the panel');
  });

  it('is drawn in the body text colour on the warning ground, which reads at 4.5:1', () => {
    const css = readFileSync(resolve(import.meta.dirname, '../../../index.css'), 'utf-8');
    const rule = /\.prompt-note \{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(rule).toMatch(/color: var\(--color-foreground\)/);
    expect(rule).toMatch(/background-color: var\(--color-status-warning-bg\)/);
  });
});

describe('a selected note', () => {
  it('is drawn as selected when it is picked on its own', () => {
    const e = withNote('She walks.');
    e.commands.setNodeSelection(0);
    expect(noteElement(e).classList.contains(NOTE_SELECTED_CLASS)).toBe(true);
  });

  it('is drawn as selected when a selection covers it', () => {
    const e = withNote('She walks.');
    e.commands.selectAll();
    expect(noteElement(e).classList.contains(NOTE_SELECTED_CLASS)).toBe(true);
  });

  it('is styled, focused, as a selected mention is', () => {
    const css = readFileSync(resolve(import.meta.dirname, '../../../index.css'), 'utf-8');
    expect(css).toMatch(new RegExp(`\\.ProseMirror-focused \\.prompt-note\\.${NOTE_SELECTED_CLASS}`));
  });
});

describe('the line under a note', () => {
  it('shows the placeholder while it is empty and the caret is on it', () => {
    const e = withNote('');
    e.commands.setTextSelection(e.state.doc.child(0).nodeSize + 1);
    const line = e.view.dom.querySelector('p');
    expect(line?.classList.contains('is-empty')).toBe(true);
    expect(line?.getAttribute('data-placeholder')).toBe('Describe it');
    const css = readFileSync(resolve(import.meta.dirname, '../../../index.css'), 'utf-8');
    expect(css).toMatch(/\.prompt-note \+ p\.is-empty:last-child::before/);
  });
});
