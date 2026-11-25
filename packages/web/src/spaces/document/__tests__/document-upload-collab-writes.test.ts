// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * What collab writes onto a pending block, against a real editor and its undo
 * manager (#1574): the block the editor made takes the write, the write is in
 * nobody's undo step, and a block undone back after its result arrived comes
 * back as it was.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';

import type * as MediaUpload from '@web/data/upload/media-upload';

import {
  applyDocumentUpload,
  documentBodyFragment,
  encodeInitialSpaceContent,
  type DocumentUploadEvent,
} from '@breatic/shared';

import { settled } from './paste-harness';

const upload = vi.hoisted(() => ({ media: vi.fn() }));
vi.mock('@web/data/upload/media-upload', async (importOriginal) => ({
  ...(await importOriginal<typeof MediaUpload>()),
  handOffSpaceMedia: upload.media,
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

type Handle = ReturnType<typeof getDocumentEditor>;

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
 * A mounted body for a Space holding one line, with a picture pasted into it.
 * @returns The body and its document.
 */
async function bodyWithPastedPicture(): Promise<{ handle: Handle; doc: Y.Doc }> {
  upload.media.mockReturnValue(new Promise(() => undefined));
  const doc = new Y.Doc();
  Y.applyUpdate(doc, encodeInitialSpaceContent('document'));
  const handle = getDocumentEditor(doc, `project-p1/document-w${seq++}`, {
    caretProvider: { awareness: new Awareness(doc) },
    readWho: () => ({ role: 'owner', viewerId: 'u1' }),
    editable: true,
    uploadTarget: { projectId: 'p1', spaceId: 's1' },
  });
  const container = document.createElement('div');
  document.body.appendChild(container);
  containers.push(container);
  adoptDocumentEditor(handle, container);
  handle.editor.replaceBlocks(handle.editor.document, [{ type: 'paragraph', content: 'lead' }] as never);
  handle.undoManager.clear();
  handle.editor.setTextCursorPosition((handle.editor.document as { id: string }[])[0].id, 'end');
  handle.editor.prosemirrorView.focus();
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', {
    value: {
      files: [new File([new Uint8Array(8)], 'shot.png', { type: 'image/png' })],
      types: ['Files'],
      items: [],
      getData: (): string => '',
    },
  });
  handle.editor.prosemirrorView.dom.dispatchEvent(event);
  await settled();
  handle.undoManager.stopCapturing();
  return { handle, doc };
}

/**
 * The attributes of the one image element in a document's body.
 * @param doc - The document.
 * @returns Its attributes, or null when the body holds no image.
 */
function image(doc: Y.Doc): Record<string, unknown> | null {
  let found: Record<string, unknown> | null = null;
  const walk = (parent: Y.XmlFragment | Y.XmlElement): void => {
    for (const child of parent.toArray()) {
      if (!(child instanceof Y.XmlElement)) continue;
      if (child.nodeName === 'image') found = child.getAttributes();
      walk(child);
    }
  };
  walk(documentBodyFragment(doc));
  return found;
}

/** The block an upload's events are addressed to. */
interface Target {
  home: string;
  uploadId: string;
}

/**
 * The address of the one pending image in a body.
 * @param doc - The document.
 * @returns Its home and upload id.
 */
function targetOf(doc: Y.Doc): Target {
  const attrs = image(doc)!;
  return { home: String(attrs.uploadHome), uploadId: String(attrs.uploadId) };
}

/**
 * Applies an event the way collab does: on another copy of the document,
 * reaching this one as a remote update.
 * @param doc - The page's document.
 * @param event - What the backend announced.
 * @param target - Which block it is for; the body's pending image by default.
 * @returns How many blocks collab wrote.
 */
function fromCollab(
  doc: Y.Doc,
  event: Omit<DocumentUploadEvent, 'type' | 'docName' | 'uploadId'>,
  target: Target = targetOf(doc),
): number {
  const server = new Y.Doc();
  Y.applyUpdate(server, Y.encodeStateAsUpdate(doc));
  const before = Y.encodeStateVector(doc);
  const wrote = applyDocumentUpload(documentBodyFragment(server), {
    type: 'document-upload',
    docName: target.home,
    uploadId: target.uploadId,
    ...event,
  });
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(server, before), 'collab');
  return wrote;
}

const RESULT = { url: 'https://cdn.example/a.png', mediaWidth: 640, mediaHeight: 480 };

describe('collab writing onto a pending block the editor made', () => {
  it('marks it as processing', async () => {
    const { doc } = await bodyWithPastedPicture();

    expect(fromCollab(doc, { state: 'processing' })).toBe(1);
    expect(image(doc)).toMatchObject({ uploadState: 'processing' });
  });

  it('lands the result outside every undo step: a local undo afterwards leaves the address', async () => {
    const { handle, doc } = await bodyWithPastedPicture();
    fromCollab(doc, { state: 'processing' });
    fromCollab(doc, { state: 'completed', result: RESULT });
    expect(image(doc)).toMatchObject({ url: RESULT.url, uploadId: '' });

    handle.undoManager.undo();

    // The one local step was the paste; the picture goes with it and the
    // address is never rewound to empty on a block that stays.
    expect(image(doc)).toBeNull();
    handle.undoManager.redo();
    expect(image(doc)).toMatchObject({ url: RESULT.url, uploadId: '' });
  });

  it('a block deleted before its result and undone back after it returns as processing', async () => {
    const { handle, doc } = await bodyWithPastedPicture();
    fromCollab(doc, { state: 'processing' });
    const target = targetOf(doc);
    const id = (handle.editor.document as { id: string; type: string }[]).find((block) => block.type === 'image')!.id;
    handle.editor.removeBlocks([id]);
    handle.undoManager.stopCapturing();
    expect(image(doc)).toBeNull();

    // The result arrives while the block is gone, so it lands nowhere.
    expect(fromCollab(doc, { state: 'completed', result: RESULT }, target)).toBe(0);
    handle.undoManager.undo();

    expect(image(doc)).toMatchObject({ url: '', uploadState: 'processing' });
  });
});
