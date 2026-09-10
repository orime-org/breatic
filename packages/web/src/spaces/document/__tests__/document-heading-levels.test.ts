// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * #904 验收 B2: the body carries three heading levels, not six.
 *
 * `h3` is already 17px against a 15px paragraph, and a fourth would have
 * nowhere left to sit; Notion and Feishu stop at three for the same reason.
 * The block-type menu offers three, and `index.css` has a size and a weight
 * for three.
 *
 * BlockNote ships six, and its `levels` option is what narrows them: the
 * markdown input rules and the `Mod-Alt-N` shortcuts are both built from that
 * one list, which is both routes a reader has. Left at the default, typing
 * `#### ` produced a level-four heading — a block the menu cannot name and the
 * stylesheet has no rule for, so it read on screen as an ordinary paragraph
 * while being stored as a heading.
 *
 * WHAT IS ALREADY STORED at levels four to six is a separate question (#920):
 * narrowing `levels` governs what can be made, not what a document already
 * holds, and a client that meets one has to decide how to draw it.
 *
 * The cases that enumerate the levels read them from the block-type menu,
 * which is where the product says how many there are. IF THE CAP WIDENS,
 * `index.css` NEEDS A RULE FOR THE NEW LEVEL FIRST — preflight resets `h1..h6`
 * to inherit, so a level with no rule of its own renders at the paragraph's
 * size and weight. The stylesheet case below reads the file off disk and says
 * so, and goes red on a level that has no rule.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, it, expect, afterEach } from 'vitest';
import { Selection } from '@tiptap/pm/state';
import type { Transaction } from '@tiptap/pm/state';
import * as Y from 'yjs';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { BLOCK_TYPE_ITEMS } from '@web/spaces/document/document-block-type';

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

/** The levels the block-type menu offers, in order. */
const LEVELS = BLOCK_TYPE_ITEMS.filter((item) =>
  item.id.startsWith('heading-'),
).map((item) => Number(item.id.slice('heading-'.length)));

/**
 * Opens an editor on one empty paragraph, caret inside it.
 * @returns The editor.
 */
function open(): ReturnType<typeof buildDocumentEditor> {
  const editor = buildDocumentEditor({
    fragment: documentBodyFragment(new Y.Doc()),
  });
  const root = document.createElement('div');
  document.body.appendChild(root);
  roots.push(root);
  editor.mount(root);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, [
    { type: 'paragraph', content: '' },
  ] as never);
  const view = editor.prosemirrorView!;
  view.dispatch(view.state.tr.setSelection(Selection.atStart(view.state.doc)));
  return editor;
}

/**
 * Types text a character at a time, the way input rules see it.
 * @param editor - The editor to type in.
 * @param text - What to type.
 */
function type(editor: ReturnType<typeof buildDocumentEditor>, text: string): void {
  for (const character of text) {
    const view = editor.prosemirrorView!;
    const { from, to } = view.state.selection;
    // The fifth argument is what an input rule falls back to when it decides
    // not to claim the character, and is also what happens here when none of
    // them does.
    const insert = (): Transaction =>
      view.state.tr.insertText(character, from, to);
    const claimed =
      view.someProp('handleTextInput', (handler) =>
        handler(view, from, to, character, insert),
      ) ?? false;
    if (!claimed) {
      view.dispatch(insert());
    }
  }
}

/**
 * Presses the heading shortcut for one level, through the keymap.
 * @param editor - The editor to press it in.
 * @param level - Which level's shortcut.
 * @returns Whether a handler claimed the key.
 */
function press(
  editor: ReturnType<typeof buildDocumentEditor>,
  level: number,
): boolean {
  const view = editor.prosemirrorView!;
  const event = new KeyboardEvent('keydown', {
    key: String(level),
    // jsdom reports a platform that is not a Mac, so `Mod` binds to Ctrl.
    ctrlKey: true,
    altKey: true,
    bubbles: true,
  });
  return (
    view.someProp('handleKeyDown', (handler) => handler(view, event)) ?? false
  );
}

/** The first block, as `editor.document` hands it back. */
function firstBlock(editor: ReturnType<typeof buildDocumentEditor>): {
  type: string;
  props: Record<string, unknown>;
} {
  return (editor.document as { type: string; props: Record<string, unknown> }[])[0]!;
}

describe('the levels the body offers', () => {
  it('has three of them', () => {
    expect(LEVELS).toEqual([1, 2, 3]);
  });

  LEVELS.forEach((level) => {
    it(`turns ${'#'.repeat(level)} into a level-${level} heading`, () => {
      const editor = open();

      type(editor, `${'#'.repeat(level)} title`);

      expect(firstBlock(editor).type).toBe('heading');
      expect(firstBlock(editor).props['level']).toBe(level);
    });
  });

  it('leaves one # past the last level as the characters typed', () => {
    const editor = open();
    const past = LEVELS.length + 1;

    type(editor, `${'#'.repeat(past)} title`);

    expect(firstBlock(editor).type).toBe('paragraph');
    expect(editor.prosemirrorState.doc.textContent).toBe(
      `${'#'.repeat(past)} title`,
    );
  });

  LEVELS.forEach((level) => {
    it(`makes a level-${level} heading on Mod-Alt-${level}`, () => {
      const editor = open();
      type(editor, 'title');

      expect(press(editor, level)).toBe(true);
      expect(firstBlock(editor).type).toBe('heading');
      expect(firstBlock(editor).props['level']).toBe(level);
    });
  });

  it('leaves the block alone on the shortcut one past the last level', () => {
    // `levels` builds the shortcuts from the same list as the input rules, so
    // the key for a level the body does not have is bound to nothing.
    const editor = open();
    type(editor, 'title');

    expect(press(editor, LEVELS.length + 1)).toBe(false);
    expect(firstBlock(editor).type).toBe('paragraph');
  });

  it('gives each level a size, a weight and a line height in index.css', () => {
    // Preflight resets `h1..h6` to inherit, so a level with no rule of its own
    // renders at the paragraph's size and weight — the cap and the stylesheet
    // have to widen together.
    //
    // All three are read off the BLOCK rather than off the heading element:
    // the number beside a numbered heading is a `::before` on the block, so a
    // size, weight or line height written on the element inside would reach
    // the title and not the number (user 2026-09-08).
    const css = readFileSync(
      resolve(import.meta.dirname, '../../../index.css'),
      'utf8',
    );
    LEVELS.forEach((level) => {
      const selector =
        level === 1
          ? '.doc-body-editor .ProseMirror .bn-block-content[data-content-type=\'heading\'] {'
          : `.doc-body-editor .ProseMirror .bn-block-content[data-content-type='heading'][data-level='${String(level)}'] {`;
      const at = css.indexOf(selector);
      expect(at, `level ${String(level)} has no block rule of its own`).toBeGreaterThan(-1);
      const rule = css.slice(at, css.indexOf('}', at));
      expect(rule, `level ${String(level)}`).toContain('font-size');
      expect(rule, `level ${String(level)}`).toContain('font-weight');
      expect(rule, `level ${String(level)}`).toContain('line-height');
    });
  });

  it('gives each level its own tag', () => {
    LEVELS.forEach((level) => {
      const editor = open();
      editor.replaceBlocks(editor.document, [
        { type: 'heading', props: { level }, content: 'title' },
      ] as never);

      expect(
        editor.prosemirrorView!.dom.querySelector(`h${level}`),
      ).not.toBeNull();
    });
  });
});
