// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Where a pasted file lands (inner#1351 + inner#1390 design §5.1, §5.4.3, A5,
 * A6): a file is a pending block put at the selection by the same placement
 * rules as any other content holding media.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { NodeSelection } from '@tiptap/pm/state';

import { encodeInitialSpaceContent } from '@breatic/shared';

import { positionOf, select } from './paste-harness';

const upload = vi.hoisted(() => ({ media: vi.fn() }));
vi.mock('@web/data/upload/media-upload', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@web/data/upload/media-upload')>()),
  uploadMedia: upload.media,
}));
vi.mock('@web/data/api/assets', () => ({
  assetsApi: {
    fetchUploadConfig: vi.fn().mockResolvedValue({ maxUploadBytes: 1_000_000, assetUrlPrefix: 'https://cdn.example/' }),
    cachedUploadConfig: vi.fn().mockReturnValue(null),
  },
}));

const { _resetDocumentEditorCacheForTests, adoptDocumentEditor, getDocumentEditor } = await import(
  '@web/spaces/document/document-editor-cache'
);

type Handle = ReturnType<typeof getDocumentEditor>;
type Block = { id: string; type: string; props: Record<string, unknown>; content?: unknown; children?: Block[] };

const containers: HTMLElement[] = [];

afterEach(() => {
  _resetDocumentEditorCacheForTests();
  containers.splice(0).forEach((element) => {
    element.remove();
  });
  upload.media.mockReset();
});

let seq = 0;

/**
 * Builds a body for a Space holding these blocks, mounted and focused.
 * @param blocks - The document.
 * @returns Its handle.
 */
function openBody(blocks: unknown[]): Handle {
  upload.media.mockReturnValue(new Promise(() => undefined));
  const doc = new Y.Doc();
  Y.applyUpdate(doc, encodeInitialSpaceContent('document'));
  const handle = getDocumentEditor(doc, `project-p1/document-f${seq++}`, {
    caretProvider: { awareness: new Awareness(doc) },
    readWho: () => ({ role: 'owner', viewerId: 'u1' }),
    editable: true,
    uploadTarget: { projectId: 'p1', spaceId: 's1' },
  });
  const container = document.createElement('div');
  document.body.appendChild(container);
  containers.push(container);
  adoptDocumentEditor(handle, container);
  handle.editor.replaceBlocks(handle.editor.document, blocks as never);
  handle.undoManager.clear();
  handle.editor.prosemirrorView!.focus();
  return handle;
}

/**
 * Pastes one picture file.
 * @param handle - The body.
 */
function pasteFile(handle: Handle): void {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', {
    value: {
      files: [new File([new Uint8Array(8)], 'shot.png', { type: 'image/png' })],
      types: ['Files'],
      items: [],
      getData: (): string => '',
    },
  });
  handle.editor.prosemirrorView!.dom.dispatchEvent(event);
}

/**
 * Every block as a label, nested ones indented under their parent.
 * @param handle - The body.
 * @returns `type[q]:words` for text blocks, `image[q]` for media.
 */
function lines(handle: Handle): string[] {
  const label = (block: Block): string => {
    const quoted = block.props['quoted'] === true ? '[q]' : '';
    if (block.type === 'image') return `image${quoted}`;
    const words = Array.isArray(block.content) ? (block.content as { text?: string }[]).map((c) => c.text ?? '').join('') : '';
    return `${block.type}${quoted}:${words}`;
  };
  const walk = (blocks: Block[], depth: number): string[] =>
    blocks.flatMap((block) => [`${'  '.repeat(depth)}${label(block)}`, ...walk(block.children ?? [], depth + 1)]);
  return walk(handle.editor.document as Block[], 0);
}

/**
 * Where the caret is: the words of its line and its offset in them.
 * @param handle - The body.
 * @returns `words@offset`.
 */
function caret(handle: Handle): string {
  const { selection } = handle.editor.prosemirrorView!.state;
  return `${selection.empty ? '' : 'RANGE '}${selection.$head.parent.textContent}@${selection.$head.parentOffset}`;
}

describe('a pasted picture file, on a line of words', () => {
  it.each([
    ['in its middle splits it', 2, ['paragraph:ab', 'image', 'paragraph:cd'], 'cd@0'],
    ['at its start goes before it', 0, ['image', 'paragraph:abcd'], 'abcd@0'],
    ['at its end goes after it', 4, ['paragraph:abcd', 'image'], 'tail@0'],
  ])('%s, the caret after it', (_name, offset, blocks, where) => {
    const handle = openBody([
      { type: 'paragraph', content: 'lead' },
      { type: 'paragraph', content: 'abcd' },
      { type: 'paragraph', content: 'tail' },
    ]);
    select(handle.editor, positionOf(handle.editor, 'abcd', offset));
    pasteFile(handle);
    expect({ lines: lines(handle), caret: caret(handle) }).toEqual({
      lines: ['paragraph:lead', ...blocks, 'paragraph:tail'],
      caret: where,
    });
  });

  it('last in the body opens a line after it for the caret', () => {
    const handle = openBody([{ type: 'paragraph', content: 'abcd' }]);
    select(handle.editor, positionOf(handle.editor, 'abcd', 4));
    pasteFile(handle);
    expect({ lines: lines(handle), caret: caret(handle) }).toEqual({ lines: ['paragraph:abcd', 'image', 'paragraph:'], caret: '@0' });
  });

  it('over a few selected words replaces them', () => {
    const handle = openBody([{ type: 'paragraph', content: 'abcd' }]);
    select(handle.editor, positionOf(handle.editor, 'abcd', 1), positionOf(handle.editor, 'abcd', 3));
    pasteFile(handle);
    expect(lines(handle)).toEqual(['paragraph:a', 'image', 'paragraph:d']);
  });

  it('over a whole selected line replaces it, leaving no empty line', () => {
    const handle = openBody([
      { type: 'paragraph', content: 'lead' },
      { type: 'paragraph', content: 'abcd' },
      { type: 'paragraph', content: 'tail' },
    ]);
    select(handle.editor, positionOf(handle.editor, 'abcd', 0), positionOf(handle.editor, 'abcd', 4));
    pasteFile(handle);
    expect(lines(handle)).toEqual(['paragraph:lead', 'image', 'paragraph:tail']);
  });
});

describe('a pasted picture file, a picture selected', () => {
  it('replaces that picture in place', () => {
    const handle = openBody([
      { type: 'paragraph', content: 'lead' },
      { type: 'image', props: { url: 'https://cdn.example/old.png' } },
      { type: 'paragraph', content: 'tail' },
    ]);
    const view = handle.editor.prosemirrorView!;
    let at = -1;
    view.state.doc.descendants((node, pos) => {
      if (at < 0 && node.type.name === 'image') at = pos;
      return at < 0;
    });
    view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, at)));
    view.focus();
    pasteFile(handle);
    expect(lines(handle)).toEqual(['paragraph:lead', 'image', 'paragraph:tail']);
    expect((handle.editor.document as Block[])[1]!.props['uploadId']).not.toBe('');
  });
});

describe('a pasted picture file, on a line with children', () => {
  it('in its middle hands the children to the back half', () => {
    const handle = openBody([{ type: 'bulletListItem', content: 'abcd', children: [{ type: 'paragraph', content: 'kid' }] }]);
    select(handle.editor, positionOf(handle.editor, 'abcd', 2));
    pasteFile(handle);
    expect(lines(handle)).toEqual(['bulletListItem:ab', 'image', 'bulletListItem:cd', '  paragraph:kid']);
  });

  it('at its end leaves the children under it and goes after them', () => {
    const handle = openBody([
      { type: 'bulletListItem', content: 'abcd', children: [{ type: 'paragraph', content: 'kid' }] },
      { type: 'paragraph', content: 'tail' },
    ]);
    select(handle.editor, positionOf(handle.editor, 'abcd', 4));
    pasteFile(handle);
    expect(lines(handle)).toEqual(['bulletListItem:abcd', '  paragraph:kid', 'image', 'paragraph:tail']);
  });
});

describe('a pasted picture file, in a quoted line', () => {
  it('splitting it is quoted with it', () => {
    const handle = openBody([{ type: 'paragraph', content: 'abcd', props: { quoted: true } }]);
    select(handle.editor, positionOf(handle.editor, 'abcd', 2));
    pasteFile(handle);
    expect(lines(handle)).toEqual(['paragraph[q]:ab', 'image[q]', 'paragraph[q]:cd']);
  });
});

describe('a pasted picture file, as an undo step', () => {
  it('one undo takes it out and puts the caret back where it was', () => {
    const handle = openBody([{ type: 'paragraph', content: 'abcd' }]);
    select(handle.editor, positionOf(handle.editor, 'abcd', 2));
    pasteFile(handle);
    handle.undoManager.undo();
    expect({ lines: lines(handle), caret: caret(handle) }).toEqual({ lines: ['paragraph:abcd'], caret: 'abcd@2' });
  });
});
