// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Every combination the placement takes (inner#1351 design §5.4.6): the
 * target line × the content's shape × where it was copied from, pasted or
 * dropped, each selection made the way a reader makes it, each result held
 * against the rules of §5.4.3.
 */

import { tableBlock } from './table-fixtures';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { TextSelection } from '@tiptap/pm/state';

import { canvasClipboardOf } from './canvas-clipboard-fixture';
import { open as openBody, pasteFormats, unmountAll, type Editor } from './paste-harness';
import { CONTENTS, EXPECTED, NEW, TARGETS, expected, setText, shape, where, type Piece } from './paste-matrix';
import { positionOf } from './paste-harness';

afterEach(unmountAll);

/**
 * The pieces as web HTML.
 * @param pieces - The pieces.
 * @returns The HTML.
 */
function webHTML(pieces: readonly Piece[]): string {
  return pieces.map((p) => (p === 'P' ? `<img src="${NEW}">` : p === 'T' ? '<table><tr><td>cell</td></tr></table>' : `<p>${p}</p>`)).join('');
}

/**
 * The pieces as body blocks.
 * @param pieces - The pieces.
 * @returns The blocks.
 */
function ownBlocks(pieces: readonly Piece[]): unknown[] {
  return pieces.map((p) =>
    p === 'P'
      ? { type: 'image', props: { url: NEW } }
      : p === 'T'
        ? tableBlock({ rows: [{ cells: ['cell'] }] })
        : { type: 'paragraph', content: p },
  );
}

/**
 * The pieces as the reader's copy from another body: a selection from the
 * first piece's start to the last piece's end, written out the way the
 * body's copy writes it.
 * @param pieces - The pieces.
 * @returns The clipboard's HTML and plain text.
 */
function ownSelectionCopy(pieces: readonly Piece[]): { html: string; text: string } {
  const { editor } = openBody(ownBlocks(pieces));
  const view = editor.prosemirrorView;
  const { doc } = view.state;
  // A text piece is copied from inside its paragraph, a medium or a table whole.
  const from = pieces[0] === 'P' || pieces[0] === 'T' ? 1 : 3;
  const to = doc.content.size - (pieces[pieces.length - 1] === 'P' || pieces[pieces.length - 1] === 'T' ? 1 : 3);
  const { dom, text } = view.serializeForClipboard(doc.slice(from, to));
  return { html: dom.innerHTML, text };
}

/** How each source delivers a paste. */
const SOURCES: Record<string, (editor: Editor, pieces: readonly Piece[]) => void> = {
  web: (editor, pieces) => pasteFormats(editor, { 'text/html': webHTML(pieces), 'text/plain': pieces.filter((p) => p !== 'P').join('\n') }),
  own: (editor, pieces) => {
    const html = editor.blocksToFullHTML(ownBlocks(pieces) as never);
    pasteFormats(editor, { 'blocknote/html': html, 'text/html': html, 'text/plain': 'copied' });
  },
  ownSelection: (editor, pieces) => {
    const { html, text } = ownSelectionCopy(pieces);
    pasteFormats(editor, { 'blocknote/html': html, 'text/html': html, 'text/plain': text });
  },
  canvas: (editor, pieces) => pasteFormats(editor, { 'text/plain': canvasClipboardOf(pieces, NEW) }),
};

describe.each(Object.keys(SOURCES))('content pasted from %s', (source) => {
  const cells = Object.entries(EXPECTED).flatMap(([target, byContent]) =>
    Object.keys(byContent)
      .filter((content) => !(source === 'canvas' && content === 'TP'))
      .map((content): [string, string, [string, string]] => [target, content, expected(target, content, source === 'canvas')]),
  );
  it.each(cells)('%s, %s', (target, content, [body, selection]) => {
    const { editor } = openBody(TARGETS[target]!.blocks, { onCanvasPaste: { start: vi.fn(), notPasted: vi.fn() } });
    TARGETS[target]!.select(editor);
    SOURCES[source]!(editor, CONTENTS[content]!);
    expect({ body: shape(editor), selection: where(editor) }).toEqual({ body, selection });
  });
});

/**
 * Drops content of these formats at a document position, the way a drop
 * from another page or another body delivers it.
 * @param editor - The editor.
 * @param at - Where the pointer is.
 * @param formats - Each format the drag carries.
 * @param copyKey - Whether the platform's copy key is held at the drop.
 */
function dropFormats(editor: Editor, at: number, formats: Readonly<Record<string, string>>, copyKey = false): void {
  const view = editor.prosemirrorView;
  const box = { x: 0, y: 0, left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100, toJSON: () => ({}) } as DOMRect;
  for (const element of [view.dom, view.dom.firstElementChild as HTMLElement]) element.getBoundingClientRect = (): DOMRect => box;
  view.posAtCoords = (): { pos: number; inside: number } => ({ pos: at, inside: -1 });
  const event = new Event('drop', { bubbles: true, cancelable: true });
  Object.assign(event, { clientX: 1, clientY: 1, altKey: copyKey, ctrlKey: copyKey });
  Object.defineProperty(event, 'dataTransfer', {
    value: { types: Object.keys(formats), files: [], items: [], getData: (type: string): string => formats[type] ?? '' },
  });
  view.dom.dispatchEvent(event);
}

/** How each source delivers a drop. */
const DROPS: Record<string, (editor: Editor, at: number, pieces: readonly Piece[]) => void> = {
  web: (editor, at, pieces) => dropFormats(editor, at, { 'text/html': webHTML(pieces), 'text/plain': pieces.filter((p) => p !== 'P').join('\n') }),
  own: (editor, at, pieces) => {
    const html = editor.blocksToFullHTML(ownBlocks(pieces) as never);
    dropFormats(editor, at, { 'blocknote/html': html, 'text/html': html, 'text/plain': 'copied' });
  },
  ownSelection: (editor, at, pieces) => {
    const { html, text } = ownSelectionCopy(pieces);
    dropFormats(editor, at, { 'blocknote/html': html, 'text/html': html, 'text/plain': text });
  },
};

describe.each(Object.keys(DROPS))('content dropped from %s lands as it pastes at the drop point', (source) => {
  const cells = Object.entries(TARGETS)
    .filter(([, target]) => target.dropAt !== undefined)
    .flatMap(([target]) => Object.keys(EXPECTED[target]!).map((content): [string, string] => [target, content]));
  it.each(cells)('%s, %s', (target, content) => {
    const { editor } = openBody(TARGETS[target]!.blocks);
    setText(editor, positionOf(editor, 'lead', 0));
    DROPS[source]!(editor, TARGETS[target]!.dropAt!(editor), CONTENTS[content]!);
    expect(shape(editor)).toBe(expected(target, content, false)[0]);
  });
});

describe('content dragged inside the body with the copy key lands as it pastes at the drop point', () => {
  const cells = Object.entries(TARGETS)
    .filter(([, target]) => target.dropAt !== undefined)
    .flatMap(([target]) => Object.keys(EXPECTED[target]!).map((content): [string, string] => [target, content]));
  it.each(cells)('%s, %s', (target, content) => {
    const pieces = CONTENTS[content]!;
    const { editor: alone } = openBody(ownBlocks(pieces));
    const source = shape(alone);
    const { editor } = openBody([...ownBlocks(pieces), ...TARGETS[target]!.blocks]);
    const view = editor.prosemirrorView;
    const { doc } = view.state;
    let end = 0;
    for (let index = 0; index < pieces.length; index += 1) end += doc.firstChild!.child(index).nodeSize;
    const from = pieces[0] === 'P' || pieces[0] === 'T' ? 1 : 3;
    const to = 1 + end - (pieces[pieces.length - 1] === 'P' || pieces[pieces.length - 1] === 'T' ? 0 : 2);
    view.dispatch(view.state.tr.setSelection(TextSelection.between(doc.resolve(from), doc.resolve(to))));
    (view as unknown as { dragging: unknown }).dragging = { slice: view.serializeForClipboard(doc.slice(from, to)).slice, move: false };
    // Where the drop points in the target alone, moved past the dragged blocks above it.
    const { editor: targetAlone } = openBody(TARGETS[target]!.blocks);
    dropFormats(editor, TARGETS[target]!.dropAt!(targetAlone) + end, { 'text/html': '<p>x</p>' }, true);
    expect(shape(editor)).toBe(`${source}|${expected(target, content, false)[0]}`);
  });
});
