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

import { serializeClipboard, type ClipboardNode, type ClipboardPayload } from '@web/spaces/canvas/node-clipboard';

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
 * The pieces as a canvas clipboard, top to bottom.
 * @param pieces - The pieces.
 * @returns Its plain text.
 */
function canvasClipboard(pieces: readonly Piece[]): string {
  const nodes = pieces.map(
    (p, index): ClipboardNode =>
      p === 'P'
        ? ({ id: `n${index}`, type: 'image', position: { x: 0, y: index * 300 }, height: 100, data: { content: NEW } })
        : ({
          id: `n${index}`,
          type: 'text',
          position: { x: 0, y: index * 300 },
          height: 100,
          data: { body: { $y: 'xml', children: [{ el: 'paragraph', attrs: {}, children: [{ text: [{ insert: p }] }] }] } },
        }),
  );
  return serializeClipboard({ version: 2, picked: nodes.map((n) => n.id), nodes, edges: [] } as ClipboardPayload);
}

/** How each source delivers a paste. */
const SOURCES: Record<string, (editor: Editor, pieces: readonly Piece[]) => void> = {
  web: (editor, pieces) => pasteFormats(editor, { 'text/html': webHTML(pieces), 'text/plain': pieces.filter((p) => p !== 'P').join('\n') }),
  own: (editor, pieces) => {
    const html = editor.blocksToFullHTML(ownBlocks(pieces) as never);
    pasteFormats(editor, { 'blocknote/html': html, 'text/html': html, 'text/plain': 'copied' });
  },
  canvas: (editor, pieces) => pasteFormats(editor, { 'text/plain': canvasClipboard(pieces) }),
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
 */
function dropFormats(editor: Editor, at: number, formats: Readonly<Record<string, string>>): void {
  const view = editor.prosemirrorView;
  view.posAtCoords = (): { pos: number; inside: number } => ({ pos: at, inside: -1 });
  const event = new Event('drop', { bubbles: true, cancelable: true });
  Object.assign(event, { clientX: 1, clientY: 1 });
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
