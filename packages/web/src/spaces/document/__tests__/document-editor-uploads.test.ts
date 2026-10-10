// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * inner#1127 A15: a body built for a Space uploads what is pasted into it
 * with that project and Space, and no node — the ticket then opens no task
 * row on any canvas.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';

import { encodeInitialSpaceContent } from '@breatic/shared';

const upload = vi.hoisted(() => ({ media: vi.fn() }));
vi.mock('@web/data/upload/media-upload', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@web/data/upload/media-upload')>()),
  uploadMedia: upload.media,
}));
// The pixel size is read off the file with an object URL, which jsdom lacks.
vi.mock('@web/spaces/document/document-media-size', () => ({
  measureMediaFile: () => Promise.resolve(undefined),
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

/**
 * Builds a body for a Space, mounted and focused.
 * @returns Its handle.
 */
function openBody(): ReturnType<typeof getDocumentEditor> {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, encodeInitialSpaceContent('document'));
  const handle = getDocumentEditor(doc, 'project-p1/document-s1', {
    caretProvider: { awareness: new Awareness(doc) },
    readWho: () => ({ role: 'owner', viewerId: 'u1' }),
    editable: true,
    uploadTarget: { projectId: 'p1', spaceId: 's1' },
  });
  const container = document.createElement('div');
  document.body.appendChild(container);
  containers.push(container);
  adoptDocumentEditor(handle, container);
  // A paste lands while the body holds the focus.
  handle.editor.prosemirrorView!.focus();
  return handle;
}

/**
 * Pastes one file into the body.
 * @param handle - The body.
 * @param file - The file.
 */
function paste(handle: ReturnType<typeof getDocumentEditor>, file: File): void {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', {
    value: {
      files: [file],
      types: ['Files'],
      items: [],
      getData: () => '',
    },
  });
  handle.editor.prosemirrorView!.dom.dispatchEvent(event);
}

describe('a body built for a Space (A15)', () => {
  it('uploads a pasted file with the project and the Space, and no node', async () => {
    upload.media.mockReturnValue(new Promise(() => undefined));
    const handle = openBody();

    const file = new File([new Uint8Array(8)], 'shot.png', { type: 'image/png' });
    paste(handle, file);

    await vi.waitFor(() => {
      expect(upload.media).toHaveBeenCalledTimes(1);
    });
    expect(upload.media.mock.calls[0]![0]).toBe(file);
    expect(upload.media.mock.calls[0]![1]).toEqual({ projectId: 'p1', spaceId: 's1' });
  });

  it('hands a paste on an empty line to the uploader as aimed at that line', () => {
    const handle = openBody();
    const start = vi.spyOn(handle.uploader!, 'start').mockResolvedValue(undefined);

    paste(handle, new File([new Uint8Array(8)], 'shot.png', { type: 'image/png' }));

    expect(start).toHaveBeenCalledOnce();
    expect(start.mock.calls[0]![3]).toBe(true);
  });
});
