// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * inner#1423 A5: a block formula that is selected but whose popup is closed
 * keeps its hidden source out of reach (design 6.2, 8.2).
 *
 * The library refuses only single-character keys and Tab there
 * (`SourceBlockWithPreview.ts:174-180`). An input method, a paste and a drop
 * go around it; each is held off the source, while a drop that lands
 * anywhere else in the body still lands.
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
  drop,
  open,
  pasteFormats,
  positionOf,
  settled,
  unmountAll,
  type Editor,
} from '@web/spaces/document/__tests__/paste-harness';

afterEach(unmountAll);

/**
 * Opens a line above a block formula and selects the formula, popup closed.
 * @returns The editor.
 */
function openSelectedFormula(): Editor {
  const { editor } = open([
    { type: 'paragraph', content: 'above' },
    { type: 'mathBlock', content: 'x' },
  ]);
  const ids = editor.document as unknown as { id: string }[];
  editor.setTextCursorPosition(ids[1]!.id, 'end');
  return editor;
}

/**
 * The block formula's source.
 * @param editor - The editor.
 * @returns Its text, or null when there is no formula block.
 */
function formulaSource(editor: Editor): string | null {
  let text: string | null = null;
  editor.prosemirrorView!.state.doc.descendants((node) => {
    if (text === null && node.type.name === 'mathBlock') text = node.textContent;
    return text === null;
  });
  return text;
}

describe('a selected, closed block formula (A5)', () => {
  it('takes nothing from an input method, during or after the composition', async () => {
    const editor = openSelectedFormula();
    const view = editor.prosemirrorView!;

    view.dom.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    view.dispatch(view.state.tr.insertText('ni', view.state.selection.from));
    expect(formulaSource(editor)).toBe('x');

    view.dom.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '你' }));
    await settled();
    expect(formulaSource(editor)).toBe('x');
  });

  it('refuses a paste', async () => {
    const editor = openSelectedFormula();

    pasteFormats(editor, { 'text/plain': 'y' });
    await settled();

    expect(formulaSource(editor)).toBe('x');
  });

  it('refuses a drop that lands inside its source', async () => {
    const editor = openSelectedFormula();
    let inside = -1;
    editor.prosemirrorView!.state.doc.descendants((node, pos) => {
      if (inside < 0 && node.type.name === 'mathBlock') inside = pos + 1;
      return inside < 0;
    });

    drop(editor, inside, '<span>dropped</span>', 'dropped');
    await settled();

    expect(formulaSource(editor)).toBe('x');
  });

  it('still lets a drop elsewhere in the body land', async () => {
    const editor = openSelectedFormula();

    drop(editor, positionOf(editor, 'above', 5), '<span>dropped</span>', 'dropped');
    await settled();

    expect(formulaSource(editor)).toBe('x');
    expect(editor.prosemirrorView!.state.doc.textContent).toContain('abovedropped');
  });
});
