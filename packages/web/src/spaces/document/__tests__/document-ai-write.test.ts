// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Writing an AI result into the body (inner#1860 A6, design §5.3 "写入"):
 * insert puts the parsed result as new blocks under the insert block, outside
 * media left out the way a landed proposal leaves them out; replace swaps the
 * original range through BlockNote's `pasteMarkdown`. Each is one ordinary
 * edit, an undo step of its own apart from typing just before or after it,
 * and neither writes without write access.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { TextSelection } from '@tiptap/pm/state';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';

import { blockPlainText } from '@web/spaces/document/document-blocks-read';
import { aiEdgeBlocks, aiEdgeBlocksBeside } from '@web/spaces/document/document-ai-launch';
import { aiRangeIn, DOCUMENT_AI_RANGE } from '@web/spaces/document/document-ai-range';
import { insertAiResult, replaceAiResult } from '@web/spaces/document/document-ai-write';
import {
  _resetDocumentEditorCacheForTests,
  adoptDocumentEditor,
  getDocumentEditor,
  type DocumentEditorHandle,
} from '@web/spaces/document/document-editor-cache';
import type { ProposalAdmission } from '@web/spaces/document/document-proposal-landing';

/** Our own asset host, so media there is ours and survives a write. */
const OURS = 'https://assets.example/';

vi.mock('@web/spaces/document/document-external-media', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ourMediaPrefix: () => OURS,
  ourMediaPrefixReady: async () => OURS,
}));

afterEach(() => {
  _resetDocumentEditorCacheForTests();
  document.body.innerHTML = '';
});

const WRITABLE = (): ProposalAdmission => ({ available: true, writeAccess: 'granted' });

/**
 * A mounted document holding some Markdown, as a Space opens it.
 * @param markdown - What it holds.
 * @returns The handle.
 */
async function open(markdown: string): Promise<DocumentEditorHandle> {
  const doc = new Y.Doc();
  const handle = getDocumentEditor(doc, `project-p/document-${String(Math.random())}`, {
    caretProvider: { awareness: new Awareness(doc) },
    readWho: () => ({ role: 'editor', viewerId: 'reader-1' }),
    editable: true,
  });
  const root = document.createElement('div');
  document.body.appendChild(root);
  adoptDocumentEditor(handle, root);
  const { editor } = handle;
  editor.replaceBlocks(editor.document, await editor.tryParseMarkdownToBlocks(markdown));
  handle.undoManager.clear();
  return handle;
}

/**
 * The top-level blocks' words.
 * @param handle - The document.
 * @returns One entry per block.
 */
function texts(handle: DocumentEditorHandle): string[] {
  const out: string[] = [];
  handle.editor.prosemirrorState.doc.firstChild?.forEach((node) => out.push(blockPlainText(node)));
  return out;
}

/**
 * The top-level block ids.
 * @param handle - The document.
 * @returns The ids.
 */
function ids(handle: DocumentEditorHandle): string[] {
  return (handle.editor.document as Array<{ id: string }>).map((block) => block.id);
}

/**
 * Where some words sit.
 * @param handle - The document.
 * @param words - Words inside one text node.
 * @returns Their range.
 * @throws {Error} When no text node holds them.
 */
function rangeOf(handle: DocumentEditorHandle, words: string): { from: number; to: number } {
  let found: { from: number; to: number } | null = null;
  handle.editor.prosemirrorState.doc.descendants((node, pos) => {
    if (found !== null) return false;
    const index = node.isText ? (node.text ?? '').indexOf(words) : -1;
    if (index >= 0) found = { from: pos + index, to: pos + index + words.length };
    return found === null;
  });
  if (found === null) throw new Error(`no text holds ${JSON.stringify(words)}`);
  return found;
}

/**
 * The block container holding some words.
 * @param handle - The document.
 * @param words - The words.
 * @returns Its id.
 */
function blockHolding(handle: DocumentEditorHandle, words: string): string {
  const $pos = handle.editor.prosemirrorState.doc.resolve(rangeOf(handle, words).from);
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    if ($pos.node(depth).type.name === 'blockContainer') return String($pos.node(depth).attrs.id);
  }
  throw new Error(`no block holds ${JSON.stringify(words)}`);
}

/**
 * Types at a position, the way a keystroke lands, as its own undo step.
 * @param handle - The document.
 * @param pos - Where.
 * @param words - What.
 */
function type(handle: DocumentEditorHandle, pos: number, words: string): void {
  const view = handle.editor.prosemirrorView!;
  view.dispatch(view.state.tr.insertText(words, pos));
}

describe('insert', () => {
  it('puts the result as new blocks under the insert block', async () => {
    const handle = await open('Before.\n\nTarget paragraph.\n\nAfter.');

    const result = await insertAiResult(handle, ids(handle)[1]!, 'New one.\n\n**New** two.', WRITABLE);

    expect(result).toMatchObject({ outcome: 'written' });
    expect(texts(handle)).toEqual(['Before.', 'Target paragraph.', 'New one.', 'New two.', 'After.']);
  });

  it('inside a table cell, puts it under the block in the cell', async () => {
    const handle = await open('Intro.\n\n| Shot | Action |\n| --- | --- |\n| Close | She turns |');
    const before = texts(handle).length;

    await insertAiResult(handle, blockHolding(handle, 'She turns'), 'Added line.', WRITABLE);

    expect(texts(handle)).toHaveLength(before);
    const table = handle.editor.prosemirrorState.doc.firstChild!.child(1);
    const cells: string[] = [];
    table.descendants((node) => {
      if (node.type.name === 'docTableCell' || node.type.name === 'docTableHeader') {
        cells.push(blockPlainText(node));
        return false;
      }
      return true;
    });
    expect(cells).toEqual(['Shot', 'Action', 'Close', 'She turns\nAdded line.']);
  });

  it('leaves outside media out and says how many', async () => {
    const handle = await open('One.');

    const result = await insertAiResult(handle, ids(handle)[0]!, 'Two.\n\n![shot](https://elsewhere.example/a.png)', WRITABLE);

    expect(result).toMatchObject({ outcome: 'written', leftOut: 1 });
    expect(texts(handle)).toEqual(['One.', 'Two.']);
    expect((handle.editor.document as Array<{ type: string }>).some((b) => b.type === 'image')).toBe(false);
  });

  it('writes nothing for a result of only outside media', async () => {
    const handle = await open('One.');

    expect(await insertAiResult(handle, ids(handle)[0]!, '![x](https://elsewhere.example/a.png)', WRITABLE)).toEqual({ outcome: 'mediaOnly', leftOut: 1 });
    expect(texts(handle)).toEqual(['One.']);
  });

  it('is one undo step, apart from the typing just before and just after', async () => {
    const handle = await open('Typed here.\n\nTarget.');
    type(handle, rangeOf(handle, 'Typed here.').to, ' More');

    await insertAiResult(handle, ids(handle)[1]!, 'Inserted.', WRITABLE);
    type(handle, rangeOf(handle, 'Target.').to, ' Later');
    expect(texts(handle)).toEqual(['Typed here. More', 'Target. Later', 'Inserted.']);

    handle.undoManager.undo();
    expect(texts(handle)).toEqual(['Typed here. More', 'Target.', 'Inserted.']);

    handle.undoManager.undo();
    expect(texts(handle)).toEqual(['Typed here. More', 'Target.']);
  });

  it('writes nothing on a read-only connection', async () => {
    const handle = await open('One.');

    expect(await insertAiResult(handle, ids(handle)[0]!, 'Two.', () => ({ available: true, writeAccess: 'denied' }))).toEqual({ outcome: 'readOnly' });
    expect(texts(handle)).toEqual(['One.']);
  });

  it('writes nothing while the connection has not said whether it may write', async () => {
    const handle = await open('One.');

    const result = await insertAiResult(handle, ids(handle)[0]!, 'Two.', () => ({ available: true, writeAccess: 'unknown' }));

    expect(result.outcome).not.toBe('written');
    expect(texts(handle)).toEqual(['One.']);
  });

  it('writes nothing once the insert block is gone', async () => {
    const handle = await open('One.\n\nTwo.');
    const target = ids(handle)[1]!;
    handle.editor.removeBlocks([target]);

    expect(await insertAiResult(handle, target, 'Three.', WRITABLE)).toEqual({ outcome: 'targetGone' });
    expect(texts(handle)).toEqual(['One.']);
  });
});

describe('replace', () => {
  it('swaps exactly the original range', async () => {
    const handle = await open('The quick brown fox.');

    const result = await replaceAiResult(handle, rangeOf(handle, 'quick brown'), 'slow red', WRITABLE);

    expect(result).toMatchObject({ outcome: 'written' });
    expect(texts(handle)).toEqual(['The slow red fox.']);
  });

  it('swaps the range the AI dialog tracked, after the body moved under it', async () => {
    const handle = await open('The quick brown fox.');
    const view = handle.editor.prosemirrorView!;
    view.dispatch(view.state.tr.setMeta(DOCUMENT_AI_RANGE, [rangeOf(handle, 'quick brown')]));
    type(handle, rangeOf(handle, 'The').from, 'Look: ');
    const tracked = aiRangeIn(handle.editor.prosemirrorState);
    if (tracked === null || tracked.kind !== 'present') throw new Error('the range should still be there');

    await replaceAiResult(handle, { from: tracked.segments[0]!.from, to: tracked.segments.at(-1)!.to }, 'slow red', WRITABLE);

    expect(texts(handle)).toEqual(['Look: The slow red fox.']);
  });

  it('is one undo step, apart from the typing just before and just after', async () => {
    const handle = await open('The quick brown fox.');
    type(handle, rangeOf(handle, 'fox.').to, ' Jumps.');

    await replaceAiResult(handle, rangeOf(handle, 'quick brown'), 'slow red', WRITABLE);
    type(handle, rangeOf(handle, 'Jumps.').to, ' Again.');
    expect(texts(handle)).toEqual(['The slow red fox. Jumps. Again.']);

    handle.undoManager.undo();
    expect(texts(handle)).toEqual(['The slow red fox. Jumps.']);

    handle.undoManager.undo();
    expect(texts(handle)).toEqual(['The quick brown fox. Jumps.']);
  });

  it('writes nothing on a read-only connection', async () => {
    const handle = await open('The quick brown fox.');

    expect(await replaceAiResult(handle, rangeOf(handle, 'quick'), 'slow', () => ({ available: true, writeAccess: 'denied' }))).toEqual({ outcome: 'readOnly' });
    expect(texts(handle)).toEqual(['The quick brown fox.']);
  });

  it('reports a failure as a rejection, where the caller hears it', async () => {
    const handle = await open('The quick brown fox.');
    const range = rangeOf(handle, 'quick');
    const unmounted = { ...handle, editor: Object.create(handle.editor, { prosemirrorView: { value: null } }) as typeof handle.editor };

    let thrown: unknown = null;
    let promise: Promise<unknown> | null = null;
    try {
      promise = replaceAiResult(unmounted, range, 'slow', WRITABLE);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeNull();
    await expect(promise).rejects.toThrow();
  });
});

/**
 * The top-level blocks as a reader sees them: an image by its address, any
 * other block by its words.
 * @param handle - The document.
 * @returns One entry per block.
 */
function shown(handle: DocumentEditorHandle): string[] {
  return (handle.editor.document as Array<{ type: string; props: Record<string, unknown> }>).map((block, index) => (
    block.type === 'image' ? `image ${String(block.props['url'])}` : texts(handle)[index]!
  ));
}

/**
 * Selects from one position to another, opens the AI range on it the way the
 * dialog does, and reads back what a replace would cover.
 * @param handle - The document.
 * @param from - Where the selection starts.
 * @param to - Where it ends.
 * @returns Reads the original range and the blocks a replace takes away with it.
 */
function openOn(handle: DocumentEditorHandle, from: number, to: number): { span: () => { range: { from: number; to: number }; edges: string[] } } {
  const view = handle.editor.prosemirrorView!;
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)));
  const edges = aiEdgeBlocks(view.state);
  view.dispatch(view.state.tr.setMeta(DOCUMENT_AI_RANGE, view.state.selection.ranges.map((r) => ({ from: r.$from.pos, to: r.$to.pos }))));
  return {
    span: () => {
      const range = aiRangeIn(view.state);
      if (range === null || range.kind !== 'present') throw new Error('the range should still be there');
      const letters = { from: range.segments[0]!.from, to: range.segments.at(-1)!.to };
      return { range: letters, edges: aiEdgeBlocksBeside(view.state.doc, letters, edges) };
    },
  };
}

describe('replace over a selection whose edge is a block without words', () => {
  const IMAGE = `![pic](${OURS}a.png)`;

  it('swaps the image the selection ends on, leaving one', async () => {
    const handle = await open(`Hello world\n\n${IMAGE}\n\nAfter`);
    const { span } = openOn(handle, rangeOf(handle, 'Hello').from, rangeOf(handle, 'After').from);

    const { range, edges } = span();
    await replaceAiResult(handle, range, `Hello, world.\n\n${IMAGE}`, WRITABLE, edges);

    expect(shown(handle)).toEqual(['Hello, world.', `image ${OURS}a.png`, 'After']);
  });

  it('swaps the image the selection starts on, leaving one', async () => {
    const handle = await open(`Before\n\n${IMAGE}\n\nHello world`);
    const { span } = openOn(handle, rangeOf(handle, 'Before').to, rangeOf(handle, 'world').to);

    const { range, edges } = span();
    await replaceAiResult(handle, range, `${IMAGE}\n\nHello, world.`, WRITABLE, edges);

    expect(shown(handle)).toEqual(['Before', `image ${OURS}a.png`, 'Hello, world.']);
  });

  it('stops at words the reader wrote between the selected words and the image', async () => {
    const handle = await open(`Hello world\n\n${IMAGE}\n\nAfter`);
    const { span } = openOn(handle, rangeOf(handle, 'Hello').from, rangeOf(handle, 'After').from);
    handle.editor.insertBlocks([{ type: 'paragraph', content: 'New' }] as never, ids(handle)[0]!, 'after');

    const { range, edges } = span();
    await replaceAiResult(handle, range, 'Hello, world.', WRITABLE, edges);

    expect(shown(handle)).toEqual(['Hello, world.', 'New', `image ${OURS}a.png`, 'After']);
  });
});
