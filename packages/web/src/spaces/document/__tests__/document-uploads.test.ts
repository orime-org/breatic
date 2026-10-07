// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * inner#1127 A4–A6, A11, A12, A15: one file's way from being picked to being
 * a block, cell by cell of the design's §3.4 transition table.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import * as Y from 'yjs';

import { documentBodyFragment, encodeInitialSpaceContent } from '@breatic/shared';

import { UploadFailedError, type StoredUpload } from '@web/data/upload/media-upload';
import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import {
  createDocumentUploader,
  type DocumentUploaderDeps,
} from '@web/spaces/document/document-uploads';
import {
  documentUploadsExtension,
  uploadSlots,
} from '@web/spaces/document/document-upload-slots';

type Editor = ReturnType<typeof buildDocumentEditor>;

const mounted: Editor[] = [];

afterEach(() => {
  mounted.splice(0).forEach((editor) => {
    editor.unmount();
  });
});

/** A block as this file reads it. */
interface Seen {
  id: string;
  type: string;
  props: Record<string, unknown>;
  content?: { text?: string }[];
}

/**
 * Opens an editor holding A and B.
 * @returns The editor.
 */
function open(): Editor {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, encodeInitialSpaceContent('document'));
  const editor = buildDocumentEditor({
    fragment: documentBodyFragment(doc),
    extensions: [documentUploadsExtension()],
  });
  const root = document.createElement('div');
  document.body.appendChild(root);
  editor.mount(root);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, [
    { type: 'paragraph', content: 'A' },
    { type: 'paragraph', content: 'B' },
  ] as never);
  return editor;
}

/** An upload the test settles by hand. */
interface Pending {
  file: File;
  progress: (fraction: number) => void;
  resolve: (stored: StoredUpload) => void;
  reject: (err: unknown) => void;
}

/**
 * Deps whose uploads wait for the test.
 * @param maxBytes - The upload cap.
 * @returns The deps, and the uploads they started.
 */
function deps(maxBytes = 1000): { deps: DocumentUploaderDeps; pending: Pending[] } {
  const pending: Pending[] = [];
  return {
    pending,
    deps: {
      maxUploadBytes: () => Promise.resolve(maxBytes),
      upload: (file, onProgress) =>
        new Promise<StoredUpload>((resolve, reject) => {
          pending.push({ file, progress: onProgress, resolve, reject });
        }),
      register: vi.fn(),
      unregister: vi.fn(),
      refuse: vi.fn(),
      undo: { stopCapturing: vi.fn() },
    },
  };
}

/**
 * A file of this type and size.
 * @param name - Its name.
 * @param type - Its type.
 * @param size - How many bytes.
 * @returns The file.
 */
function file(name: string, type: string, size = 10): File {
  return new File([new Uint8Array(size)], name, { type });
}

/**
 * The editor's blocks.
 * @param editor - The editor.
 * @returns The top-level blocks.
 */
function blocks(editor: Editor): Seen[] {
  return editor.document as Seen[];
}

/**
 * Lets the uploader's awaits run.
 * @returns When they have.
 */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Starts one batch between A and B.
 * @param editor - The editor.
 * @param uploader - The uploader.
 * @param files - The files.
 * @param quoted - Whether the gap is inside a quote.
 */
async function start(
  editor: Editor,
  uploader: ReturnType<typeof createDocumentUploader>,
  files: File[],
  quoted = false,
): Promise<void> {
  const [a, b] = blocks(editor);
  await uploader.start(editor.prosemirrorView!, files, { before: a!.id, after: b!.id }, quoted);
  await settle();
}

describe('admission (A5)', () => {
  it.each([
    ['an empty file', file('e.png', 'image/png', 0), 'canvas.upload.empty'],
    ['a file over the cap', file('big.png', 'image/png', 2000), 'canvas.upload.tooLarge'],
    ['a format we do not take', file('loop.gif', 'image/gif'), 'canvas.upload.unsupportedType'],
    ['a file that is not media', file('notes.txt', 'text/plain'), 'canvas.upload.unsupportedType'],
  ])('refuses %s with a toast and draws no placeholder', async (_label, picked, key) => {
    const editor = open();
    const { deps: d, pending } = deps();
    const uploader = createDocumentUploader(d);

    await start(editor, uploader, [picked]);

    expect(d.refuse).toHaveBeenCalledWith(key, expect.objectContaining({ filename: picked.name }));
    expect(uploadSlots(editor.prosemirrorView!.state)).toEqual([]);
    expect(pending).toEqual([]);
  });

  it('starts the files it admits and refuses only the others', async () => {
    const editor = open();
    const { deps: d, pending } = deps();
    const uploader = createDocumentUploader(d);

    await start(editor, uploader, [file('a.png', 'image/png'), file('e.png', 'image/png', 0)]);

    expect(pending.map((p) => p.file.name)).toEqual(['a.png']);
    expect(uploadSlots(editor.prosemirrorView!.state).map((s) => s.name)).toEqual(['a.png']);
  });
});

describe('uploading (A4, A12)', () => {
  it('registers the upload as in flight until it settles', async () => {
    const editor = open();
    const { deps: d, pending } = deps();
    const uploader = createDocumentUploader(d);

    await start(editor, uploader, [file('a.png', 'image/png')]);
    const [slot] = uploadSlots(editor.prosemirrorView!.state);
    expect(d.register).toHaveBeenCalledWith(slot!.id);
    expect(d.unregister).not.toHaveBeenCalled();

    pending[0]!.resolve({ fileUrl: 'https://cdn.example/a.png', assetId: 'x' });
    await settle();
    expect(d.unregister).toHaveBeenCalledWith(slot!.id);
  });

  it('shows the share that has landed', async () => {
    const editor = open();
    const { deps: d, pending } = deps();
    const uploader = createDocumentUploader(d);

    await start(editor, uploader, [file('clip.mp4', 'video/mp4')]);
    pending[0]!.progress(0.4);

    expect(uploadSlots(editor.prosemirrorView!.state)[0]!.progress).toBe(0.4);
  });
});

describe('an upload that succeeds (A13, A15)', () => {
  it.each([
    ['photo.png', 'image/png', 'image'],
    ['clip.mp4', 'video/mp4', 'video'],
    ['song.mp3', 'audio/mpeg', 'audio'],
  ])('turns %s into a %s block carrying the registered address', async (name, type, expected) => {
    const editor = open();
    const { deps: d, pending } = deps();
    const uploader = createDocumentUploader(d);

    await start(editor, uploader, [file(name, type)], true);
    pending[0]!.resolve({ fileUrl: `https://cdn.example/${name}`, assetId: 'x' });
    await settle();

    const media = blocks(editor)[1]!;
    expect(media.type).toBe(expected);
    expect(media.props).toMatchObject({
      url: `https://cdn.example/${name}`,
      name,
      quoted: true,
    });
    expect(uploadSlots(editor.prosemirrorView!.state)).toEqual([]);
  });

  it('fails as a plain upload failure when the answer carries no address', async () => {
    const editor = open();
    const { deps: d, pending } = deps();
    const uploader = createDocumentUploader(d);

    await start(editor, uploader, [file('a.png', 'image/png')]);
    pending[0]!.resolve({ fileUrl: undefined, assetId: undefined });
    await settle();

    expect(blocks(editor)).toHaveLength(2);
    expect(uploadSlots(editor.prosemirrorView!.state)[0]).toMatchObject({
      phase: 'failed',
      failure: { messageKey: 'canvas.upload.failed', retryable: true },
    });
  });

  it('fails as read-only when the body stopped being editable meanwhile', async () => {
    const editor = open();
    const { deps: d, pending } = deps();
    const uploader = createDocumentUploader(d);

    await start(editor, uploader, [file('a.png', 'image/png')]);
    editor.isEditable = false;
    pending[0]!.resolve({ fileUrl: 'https://cdn.example/a.png', assetId: 'x' });
    await settle();

    expect(blocks(editor)).toHaveLength(2);
    expect(uploadSlots(editor.prosemirrorView!.state)[0]).toMatchObject({
      phase: 'failed',
      failure: { messageKey: 'spaces.document.media.readOnly', retryable: true },
    });
  });
});

describe('an upload that fails (A6)', () => {
  it.each([
    ['upload', 'canvas.upload.failed', true],
    ['transfer', 'canvas.upload.failed', false],
    ['storage', 'canvas.upload.storageFull', false],
    ['hash', 'canvas.upload.hashUnavailable', false],
    ['unsupportedType', 'canvas.upload.unsupportedType', false],
  ] as const)('on %s says %s, retryable %s', async (reason, key, retryable) => {
    const editor = open();
    const { deps: d, pending } = deps();
    const uploader = createDocumentUploader(d);

    await start(editor, uploader, [file('a.png', 'image/png')]);
    const [slot] = uploadSlots(editor.prosemirrorView!.state);
    pending[0]!.reject(new UploadFailedError(reason));
    await settle();

    expect(uploadSlots(editor.prosemirrorView!.state)[0]).toMatchObject({
      phase: 'failed',
      failure: { messageKey: key, retryable },
    });
    expect(d.unregister).toHaveBeenCalledWith(slot!.id);
  });

  it('sends the same file again on retry, and lands it where it was', async () => {
    const editor = open();
    const { deps: d, pending } = deps();
    const uploader = createDocumentUploader(d);
    const picked = file('a.png', 'image/png');

    await start(editor, uploader, [picked]);
    const [slot] = uploadSlots(editor.prosemirrorView!.state);
    pending[0]!.reject(new UploadFailedError('upload'));
    await settle();

    uploader.retry(editor.prosemirrorView!, slot!.id);
    expect(uploadSlots(editor.prosemirrorView!.state)[0]).toMatchObject({
      phase: 'uploading',
      failure: null,
    });
    expect(pending[1]!.file).toBe(picked);
    expect(d.register).toHaveBeenCalledTimes(2);

    pending[1]!.resolve({ fileUrl: 'https://cdn.example/a.png', assetId: 'x' });
    await settle();
    expect(blocks(editor).map((b) => b.type)).toEqual(['paragraph', 'image', 'paragraph']);
  });

  it('offers no retry where re-sending meets the same answer', async () => {
    const editor = open();
    const { deps: d, pending } = deps();
    const uploader = createDocumentUploader(d);

    await start(editor, uploader, [file('a.png', 'image/png')]);
    const [slot] = uploadSlots(editor.prosemirrorView!.state);
    pending[0]!.reject(new UploadFailedError('storage'));
    await settle();

    uploader.retry(editor.prosemirrorView!, slot!.id);

    expect(pending).toHaveLength(1);
    expect(uploadSlots(editor.prosemirrorView!.state)[0]!.phase).toBe('failed');
  });

  it('takes a failed placeholder away on remove', async () => {
    const editor = open();
    const { deps: d, pending } = deps();
    const uploader = createDocumentUploader(d);

    await start(editor, uploader, [file('a.png', 'image/png')]);
    const [slot] = uploadSlots(editor.prosemirrorView!.state);
    pending[0]!.reject(new UploadFailedError('storage'));
    await settle();

    uploader.remove(editor.prosemirrorView!, slot!.id);

    expect(uploadSlots(editor.prosemirrorView!.state)).toEqual([]);
    expect(blocks(editor)).toHaveLength(2);
  });
});
