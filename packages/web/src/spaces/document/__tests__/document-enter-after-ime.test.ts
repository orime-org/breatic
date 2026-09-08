// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The Enter that accepts a candidate does not also split the block.
 *
 * Reported by the reader (2026-09-08): typing Chinese into the second item of
 * a numbered list and pressing Enter to accept the candidate left the pinyin
 * in that item and put the characters in a new one below it.
 *
 * Chrome sends `compositionend` BEFORE the keydown of the key that ended the
 * composition, and that keydown carries `isComposing: false` — the flag says
 * the key has nothing to do with the input method. `prosemirror-view` reads
 * its own `view.composing`, which its `compositionend` handler clears on the
 * first line, and the one guard it has left against a late Enter is written
 * `safari && Date.now() - compositionEndedAt < 500` (`index.js:3554`).
 * `navigator.vendor` is "Google Inc." in Chrome, so on Chrome there is no
 * guard at all and the key reaches every Enter handler in the editor.
 *
 * Measured in a browser: with `compositionend` and the keydown dispatched in
 * one task, a third numbered item read "世界zaijian" — the pinyin left behind,
 * the candidate lost, the block split anyway.
 *
 * What closes it is what the browsers themselves suggest: hold the flag until
 * the end of the current task, so the keydown belonging to the same keystroke
 * still sees a composition. A later Enter is a later task and splits normally,
 * which the third case below holds.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as Y from 'yjs';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';

const mounted: ReturnType<typeof buildDocumentEditor>[] = [];

afterEach(() => {
  mounted.splice(0).forEach((editor) => {
    editor.unmount();
  });
});

/** A block as `editor.document` hands it back. */
interface ReadBlock {
  readonly id: string;
  readonly type: string;
}

/**
 * Opens an editor holding two numbered items, with the caret in the second.
 * @returns The editor.
 */
function open(): ReturnType<typeof buildDocumentEditor> {
  const editor = buildDocumentEditor({
    fragment: documentBodyFragment(new Y.Doc()),
  });
  const root = document.createElement('div');
  document.body.appendChild(root);
  editor.mount(root);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, [
    { type: 'numberedListItem', content: 'first' },
    { type: 'numberedListItem', content: 'second' },
  ] as never);
  const blocks = editor.document as unknown as ReadBlock[];
  editor.setTextCursorPosition(blocks[1]!.id, 'end');
  return editor;
}

/** How many blocks the document holds. */
function count(editor: ReturnType<typeof buildDocumentEditor>): number {
  return (editor.document as unknown as ReadBlock[]).length;
}

/**
 * Ends a composition on the editor's own element, the way the browser does.
 * @param editor - The editor to end it in.
 */
function endComposition(
  editor: ReturnType<typeof buildDocumentEditor>,
): void {
  editor.prosemirrorView!.dom.dispatchEvent(
    new CompositionEvent('compositionend', { data: '你好', bubbles: true }),
  );
}

/**
 * Presses Enter through the keymap.
 * @param editor - The editor to press it in.
 * @returns Whether a handler claimed the key.
 */
function pressEnter(editor: ReturnType<typeof buildDocumentEditor>): boolean {
  const view = editor.prosemirrorView!;
  const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true });
  return (
    view.someProp('handleKeyDown', (handler) => handler(view, event)) ?? false
  );
}

describe('the Enter that accepts a candidate', () => {
  it('does not split the block it was typed in', () => {
    const editor = open();

    endComposition(editor);
    expect(pressEnter(editor)).toBe(true);

    expect(count(editor)).toBe(2);
  });

  it('claims the key rather than leaving it to the browser', () => {
    // An unclaimed Enter inside a contenteditable is one the browser answers
    // by inserting a line break of its own.
    const editor = open();

    endComposition(editor);

    expect(pressEnter(editor)).toBe(true);
  });

  it('holds against the pair of keydowns one keystroke can report', () => {
    // Chrome reports the accepting key twice: once carrying 229 while the
    // input method still owns it, once carrying 13 after it lets go, and both
    // can land after `compositionend`. Measured in a browser, a guard spent on
    // the first left the second to split the block — a fourth row appeared
    // below a third that still read its pinyin (user 2026-09-08, third-level
    // list item).
    const editor = open();

    endComposition(editor);
    expect(pressEnter(editor)).toBe(true);
    expect(pressEnter(editor)).toBe(true);

    expect(count(editor)).toBe(2);
  });

  it('splits normally on the next press, which is a later task', async () => {
    const editor = open();

    endComposition(editor);
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });

    expect(pressEnter(editor)).toBe(true);
    expect(count(editor)).toBe(3);
  });

  it('splits normally when no composition ended first', () => {
    const editor = open();

    expect(pressEnter(editor)).toBe(true);
    expect(count(editor)).toBe(3);
  });
});
