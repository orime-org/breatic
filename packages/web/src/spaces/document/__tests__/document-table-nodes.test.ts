// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * inner#1619 T1: a table cell holds blocks, the way the body does.
 *
 * The table is four layout blocks (`docTable > docTableRow > docTableCell |
 * docTableHeader > blocks`). These pin the document model: what a cell may
 * hold, that it survives the block API and Yjs unchanged, and that the editor
 * draws it as a real `<table>`.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { waitFor } from '@testing-library/react';
import * as Y from 'yjs';
import { addRowAfter, CellSelection, mergeCells, TableMap } from '@tiptap/pm/tables';
import { TextSelection } from '@tiptap/pm/state';
import type { Node as PMNode } from '@tiptap/pm/model';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';

type Editor = ReturnType<typeof buildDocumentEditor>;

const mounted: Editor[] = [];

afterEach(() => {
  for (const editor of mounted.splice(0)) {
    editor.unmount();
  }
  document.body.innerHTML = '';
});

/**
 * A mounted editor over the given Yjs document.
 * @param doc - The Yjs document.
 * @returns The editor.
 */
function open(doc: Y.Doc = new Y.Doc()): Editor {
  const editor = buildDocumentEditor({ fragment: documentBodyFragment(doc) });
  const host = document.createElement('div');
  document.body.appendChild(host);
  editor.mount(host);
  mounted.push(editor);
  return editor;
}

/** One block of every kind a cell may hold, in block JSON. */
const EVERY_KIND = [
  { type: 'paragraph', content: 'words' },
  { type: 'heading', props: { level: 2 }, content: 'title' },
  { type: 'bulletListItem', content: 'bullet' },
  { type: 'numberedListItem', content: 'number' },
  { type: 'checkListItem', props: { checked: true }, content: 'todo' },
  { type: 'paragraph', props: { quoted: true }, content: 'quote' },
  { type: 'codeBlock', props: { language: 'ts' }, content: 'const a = 1;' },
  { type: 'divider' },
  { type: 'image', props: { url: 'https://example.com/a.png' } },
  { type: 'video', props: { url: 'https://example.com/a.mp4' } },
  { type: 'audio', props: { url: 'https://example.com/a.mp3' } },
];

/**
 * A table in block JSON.
 * @param cells - Each row's cells, each cell its blocks.
 * @returns The table block.
 */
function table(cells: readonly (readonly unknown[])[][]): unknown {
  return {
    type: 'docTable',
    children: cells.map((row) => ({
      type: 'docTableRow',
      children: row.map((blocks) => ({ type: 'docTableCell', children: blocks })),
    })),
  };
}

/** What a block JSON keeps of a block, for comparing two documents. */
interface Shape {
  type: string;
  props?: Record<string, unknown>;
  text?: string;
  children: Shape[];
}

/**
 * Strips ids and default-valued noise off a document, keeping type, the props
 * a test set, text and children.
 * @param blocks - The editor's blocks.
 * @returns Their shape.
 */
function shapeOf(blocks: readonly unknown[]): Shape[] {
  return blocks.map((raw) => {
    const block = raw as {
      type: string;
      props?: Record<string, unknown>;
      content?: unknown;
      children?: unknown[];
    };
    const text = Array.isArray(block.content)
      ? (block.content as { text?: string }[]).map((part) => part.text ?? '').join('')
      : undefined;
    return {
      type: block.type,
      props: block.props,
      ...(text === undefined ? {} : { text }),
      children: shapeOf(block.children ?? []),
    };
  });
}

/**
 * The first node of a type and where it starts.
 * @param editor - The editor.
 * @param name - The node type name.
 * @returns The node and its position.
 */
function first(editor: Editor, name: string): { node: PMNode; pos: number } {
  let found: { node: PMNode; pos: number } | null = null;
  editor.prosemirrorState.doc.descendants((node, pos) => {
    if (found === null && node.type.name === name) {
      found = { node, pos };
    }
    return found === null;
  });
  if (found === null) {
    throw new Error(`no ${name} in the document`);
  }
  return found;
}

describe('a table cell holds blocks', () => {
  it('keeps every kind of block a cell may hold through the block API', () => {
    const editor = open();
    editor.replaceBlocks(editor.document, [table([[EVERY_KIND, [{ type: 'paragraph' }]]])] as never);

    const cell = (editor.document[0] as { children: { children: { children: unknown[] }[] }[] })
      .children[0].children[0];
    expect(shapeOf(cell.children).map((block) => block.type)).toEqual(
      EVERY_KIND.map((block) => block.type),
    );
    expect(() => editor.prosemirrorState.doc.check()).not.toThrow();
  });

  it('reaches a second editor over Yjs unchanged', () => {
    const left = new Y.Doc();
    const right = new Y.Doc();
    left.on('update', (update: Uint8Array) => Y.applyUpdate(right, update));
    const writer = open(left);
    writer.replaceBlocks(writer.document, [
      table([
        [EVERY_KIND, [{ type: 'heading', props: { level: 1 }, content: 'h' }]],
        [[{ type: 'bulletListItem', content: 'a', children: [{ type: 'bulletListItem', content: 'b' }] }], [{ type: 'paragraph' }]],
      ]),
    ] as never);

    const reader = open(right);
    expect(shapeOf(reader.document)).toEqual(shapeOf(writer.document));
  });

  it('refuses a table inside a cell', () => {
    const editor = open();
    const cellType = editor.pmSchema.nodes['docTableCell'];
    const headerType = editor.pmSchema.nodes['docTableHeader'];
    const tableType = editor.pmSchema.nodes['docTable'];
    expect(cellType.contentMatch.matchType(tableType)).toBeNull();
    expect(headerType.contentMatch.matchType(tableType)).toBeNull();
  });

  it('gives a new cell one empty paragraph', () => {
    const editor = open();
    editor.replaceBlocks(editor.document, [table([[[{ type: 'paragraph', content: 'a' }]]])] as never);
    const view = editor.prosemirrorView;
    const paragraph = first(editor, 'paragraph');
    view.dispatch(
      view.state.tr.setSelection(TextSelection.create(view.state.doc, paragraph.pos + 1)),
    );

    expect(addRowAfter(view.state, view.dispatch)).toBe(true);

    const { node } = first(editor, 'docTable');
    expect(TableMap.get(node).height).toBe(2);
    const added = node.child(1).child(0);
    expect(added.type.name).toBe('docTableCell');
    expect(added.childCount).toBe(1);
    expect(added.child(0).type.name).toBe('blockContainer');
    expect(added.child(0).child(0).type.name).toBe('paragraph');
    expect(added.child(0).child(0).content.size).toBe(0);
  });

  it('is drawn as a table whose cells hold the blocks', async () => {
    const editor = open();
    editor.replaceBlocks(editor.document, [
      table([[[{ type: 'heading', props: { level: 2 }, content: 'title' }], [{ type: 'paragraph', content: 'p' }]]]),
    ] as never);

    const element = document.querySelector('table');
    expect(element).not.toBeNull();
    const cells = element!.querySelectorAll(':scope > tbody > tr > td');
    expect(cells).toHaveLength(2);
    expect(cells[0].querySelector('[data-content-type="heading"]')?.textContent).toBe('title');
    await waitFor(() => {
      expect(element!.closest('[data-radix-scroll-area-viewport]')).not.toBeNull();
    });
    expect(editor.prosemirrorState.doc.check()).toBeUndefined();
  });

  it('draws `quoted` on the table and repaints it when it changes', () => {
    const editor = open();
    editor.replaceBlocks(editor.document, [
      { ...(table([[[{ type: 'paragraph', content: 'a' }]]]) as object), props: { quoted: true } },
    ] as never);
    const frame = document.querySelector<HTMLElement>('[data-node-type="docTable"]');
    expect(frame?.getAttribute('data-quoted')).toBe('true');

    const view = editor.prosemirrorView;
    view.dispatch(view.state.tr.setNodeAttribute(first(editor, 'docTable').pos, 'quoted', false));
    expect(document.querySelector('[data-node-type="docTable"]')).toBe(frame);
    expect(frame?.getAttribute('data-quoted')).toBeNull();
  });

  it('keeps its width when every cell is merged into one (upstream #1993)', () => {
    const editor = open();
    const words = (text: string): unknown[] => [{ type: 'paragraph', content: text }];
    editor.replaceBlocks(editor.document, [
      table([0, 1, 2].map((r) => [0, 1, 2].map((c) => words(`r${r}c${c}`)))),
    ] as never);
    const view = editor.prosemirrorView;
    const { node, pos } = first(editor, 'docTable');
    const map = TableMap.get(node);
    const start = pos + 1;
    view.dispatch(
      view.state.tr.setSelection(
        CellSelection.create(view.state.doc, start + map.map[0]!, start + map.map[map.map.length - 1]!),
      ),
    );

    expect(mergeCells(view.state, view.dispatch)).toBe(true);

    expect(TableMap.get(first(editor, 'docTable').node).width).toBe(3);
    expect(() => editor.prosemirrorState.doc.check()).not.toThrow();
  });

  it('reads an HTML table into cells that hold blocks, with spans and widths', () => {
    const editor = open();
    const blocks = editor.tryParseHTMLToBlocks(
      '<table><tbody><tr><td colspan="2" colwidth="100,80"><h2>T</h2><ul><li>x</li></ul></td></tr>' +
        '<tr><th>h</th><td>plain</td></tr></tbody></table>',
    ) as unknown as Shape[];

    expect(blocks.map((block) => block.type)).toEqual(['docTable']);
    const [first, second] = (blocks[0] as unknown as { children: { children: Shape[] }[] }).children;
    expect(first!.children[0]!.props).toMatchObject({ colspan: 2, colwidth: [100, 80] });
    expect(first!.children[0]!.children.map((block) => block.type)).toEqual(['heading', 'bulletListItem']);
    expect(second!.children.map((cell) => cell.type)).toEqual(['docTableHeader', 'docTableCell']);
  });

  it('keeps the column widths through the HTML the editor writes', () => {
    const editor = open();
    editor.replaceBlocks(editor.document, [table([[[{ type: 'paragraph', content: 'a' }]]])] as never);
    const view = editor.prosemirrorView;
    const cell = first(editor, 'docTableCell');
    view.dispatch(view.state.tr.setNodeAttribute(cell.pos, 'colwidth', [140]));

    const again = editor.tryParseHTMLToBlocks(editor.blocksToFullHTML(editor.document as never)) as unknown as {
      children: { children: { props: Record<string, unknown> }[] }[];
    }[];

    expect(again[0]!.children[0]!.children[0]!.props['colwidth']).toEqual([140]);
  });

  it('reads no width back for a column that had none', () => {
    const editor = open();
    editor.replaceBlocks(editor.document, [table([[[{ type: 'paragraph', content: 'a' }]]])] as never);

    const again = editor.tryParseHTMLToBlocks(editor.blocksToHTMLLossy(editor.document as never)) as unknown as {
      children: { children: { props: Record<string, unknown> }[] }[];
    }[];

    expect(again[0]!.children[0]!.children[0]!.props['colwidth']).toBeNull();
  });

  it('draws the table where the reader can edit its cells, in the wrapper the table rules style', async () => {
    const editor = open();
    editor.replaceBlocks(editor.document, [table([[[{ type: 'paragraph', content: 'a' }]]])] as never);

    const element = document.querySelector('[data-node-type="docTable"] table')!;
    await waitFor(() => {
      expect(element.parentElement?.classList.contains('tableWrapper')).toBe(true);
    });
    expect(element.closest('[contenteditable="false"]')).toBeNull();
  });

  it('writes a stored column width on the cell, and no width where none is stored', () => {
    const editor = open();
    editor.replaceBlocks(editor.document, [
      table([[[{ type: 'paragraph', content: 'a' }], [{ type: 'paragraph', content: 'b' }]]]),
    ] as never);
    const view = editor.prosemirrorView;
    const cell = first(editor, 'docTableCell');
    view.dispatch(view.state.tr.setNodeAttribute(cell.pos, 'colwidth', [140]));

    const [sized, unsized] = [...document.querySelectorAll<HTMLElement>('[data-node-type="docTable"] td')];
    expect(sized!.getAttribute('colwidth')).toBe('140');
    expect(unsized!.hasAttribute('colwidth')).toBe(false);
    expect(unsized!.hasAttribute('data-colwidth')).toBe(false);
  });
});

