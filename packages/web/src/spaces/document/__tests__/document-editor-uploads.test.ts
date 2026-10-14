// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A body built for a Space (inner#1127 A15, inner#1351 + inner#1390 §5.9):
 * a pasted file becomes a pending block in one undo step and uploads with
 * that project and Space and no node; a read-only body takes no paste (A8).
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';

import { encodeInitialSpaceContent } from '@breatic/shared';

import { serializeClipboard, type ClipboardPayload } from '@web/spaces/canvas/node-clipboard';

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

const {
  _resetDocumentEditorCacheForTests,
  adoptDocumentEditor,
  getDocumentEditor,
} = await import('@web/spaces/document/document-editor-cache');

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
 * Builds a body for a Space holding these blocks, mounted, caret at the end
 * of the block at `caretIn`.
 * @param blocks - The document.
 * @param caretIn - Which top-level block holds the caret.
 * @param editable - False for a viewer.
 * @returns Its handle.
 */
function openBody(blocks: unknown[], caretIn: number, editable = true): ReturnType<typeof getDocumentEditor> {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, encodeInitialSpaceContent('document'));
  const handle = getDocumentEditor(doc, `project-p1/document-s${seq++}`, {
    caretProvider: { awareness: new Awareness(doc) },
    readWho: () => ({ role: editable ? 'owner' : 'viewer', viewerId: 'u1' }),
    editable: true,
    uploadTarget: { projectId: 'p1', spaceId: 's1' },
  });
  const container = document.createElement('div');
  document.body.appendChild(container);
  containers.push(container);
  adoptDocumentEditor(handle, container);
  handle.editor.replaceBlocks(handle.editor.document, blocks as never);
  handle.undoManager.clear();
  const id = (handle.editor.document as { id: string }[])[caretIn]!.id;
  handle.editor.setTextCursorPosition(id, 'end');
  handle.editor.isEditable = editable;
  // A paste lands while the body holds the focus.
  handle.editor.prosemirrorView!.focus();
  return handle;
}

/**
 * Pastes clipboard data into the body.
 * @param handle - The body.
 * @param data - What the clipboard holds.
 * @param data.files - Its files.
 * @param data.text - Its plain text.
 * @param data.html - Its HTML.
 */
function paste(
  handle: ReturnType<typeof getDocumentEditor>,
  { files = [], text = '', html = '' }: { files?: File[]; text?: string; html?: string },
): void {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  const types = [...(files.length > 0 ? ['Files'] : []), ...(text !== '' ? ['text/plain'] : []), ...(html !== '' ? ['text/html'] : [])];
  Object.defineProperty(event, 'clipboardData', {
    value: {
      files,
      types,
      items: [],
      getData: (type: string): string => (type === 'text/plain' ? text : type === 'text/html' ? html : ''),
    },
  });
  handle.editor.prosemirrorView!.dom.dispatchEvent(event);
}

/**
 * The top-level blocks as short labels.
 * @param handle - The body.
 * @returns `type:text` for text blocks, `type[uploadId?|name]` for media.
 */
function shape(handle: ReturnType<typeof getDocumentEditor>): string[] {
  return (handle.editor.document as { type: string; props: Record<string, unknown>; content?: { text?: string }[] }[]).map((b) =>
    b.type === 'image' || b.type === 'video' || b.type === 'audio'
      ? `${b.type}[${b.props['uploadId'] === '' ? 'none' : 'id'}|${String(b.props['name'])}]`
      : `${b.type}:${Array.isArray(b.content) ? b.content.map((c) => c.text ?? '').join('') : ''}`,
  );
}

const PNG = (): File => new File([new Uint8Array(8)], 'shot.png', { type: 'image/png' });

describe('a file pasted into a body built for a Space', () => {
  it('becomes a pending block under the caret\'s line and uploads with the project and the Space, no node', async () => {
    upload.media.mockReturnValue(new Promise(() => undefined));
    const handle = openBody([{ type: 'paragraph', content: 'lead' }], 0);
    const file = PNG();

    paste(handle, { files: [file] });

    expect(shape(handle)).toEqual(['paragraph:lead', 'image[id|shot.png]']);
    await vi.waitFor(() => {
      expect(upload.media).toHaveBeenCalledTimes(1);
    });
    expect(upload.media.mock.calls[0]![0]).toBe(file);
    expect(upload.media.mock.calls[0]![1]).toEqual({ projectId: 'p1', spaceId: 's1' });
  });

  it('on an empty line lands above it, and the caret stays in the line', () => {
    upload.media.mockReturnValue(new Promise(() => undefined));
    const handle = openBody([{ type: 'paragraph', content: 'lead' }, { type: 'paragraph' }], 1);
    const line = (handle.editor.document as { id: string }[])[1]!.id;

    paste(handle, { files: [PNG()] });

    expect(shape(handle)).toEqual(['paragraph:lead', 'image[id|shot.png]', 'paragraph:']);
    expect((handle.editor.getTextCursorPosition().block as { id: string }).id).toBe(line);
  });

  it('is one undo step of its own', () => {
    upload.media.mockReturnValue(new Promise(() => undefined));
    const handle = openBody([{ type: 'paragraph', content: 'lead' }], 0);
    handle.editor.insertInlineContent(' typed');

    paste(handle, { files: [PNG()] });
    handle.undoManager.undo();

    expect(shape(handle)).toEqual(['paragraph:lead typed']);
  });
});

describe('a read-only body (A8)', () => {
  it.each([
    ['a file', { files: [PNG()] }],
    [
      'a canvas clipboard',
      {
        text: serializeClipboard({
          version: 2,
          picked: ['i'],
          nodes: [{ id: 'i', type: 'image', position: { x: 0, y: 0 }, data: { name: 'Hero', content: 'https://cdn.example/a.png' } }],
          edges: [],
        } as unknown as ClipboardPayload),
      },
    ],
    ['web HTML with an outside picture', { html: '<p>a</p><img src="https://imgs.example/x.jpg"><p>b</p>', text: 'a b' }],
  ])('takes no paste of %s', (_label, data) => {
    const handle = openBody([{ type: 'paragraph', content: 'lead' }], 0, false);

    paste(handle, data);

    expect(shape(handle)).toEqual(['paragraph:lead']);
    expect(upload.media).not.toHaveBeenCalled();
  });
});
