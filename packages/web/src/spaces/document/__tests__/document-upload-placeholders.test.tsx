// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * inner#1127 A4, A6: what a placeholder shows while its file uploads and
 * after it fails.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import * as React from 'react';
import * as Y from 'yjs';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { DocumentUploadPlaceholders } from '@web/spaces/document/DocumentUploadPlaceholders';
import {
  addUploadBatch,
  documentUploadsExtension,
  patchUploadSlot,
} from '@web/spaces/document/document-upload-slots';
import type { DocumentUploader } from '@web/spaces/document/document-uploads';

type Editor = ReturnType<typeof buildDocumentEditor>;

const mounted: Editor[] = [];

afterEach(() => {
  mounted.splice(0).forEach((editor) => {
    editor.unmount();
  });
});

/**
 * Opens an editor with one upload in flight, and the placeholders drawn.
 * @param readOnly - Whether the body is read-only.
 * @returns The editor, the slot and the uploader stub.
 */
function open(readOnly = false): {
  editor: Editor;
  slot: string;
  uploader: { retry: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> };
} {
  const editor = buildDocumentEditor({
    fragment: documentBodyFragment(new Y.Doc()),
    extensions: [documentUploadsExtension()],
  });
  const root = document.createElement('div');
  document.body.appendChild(root);
  editor.mount(root);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, [{ type: 'paragraph', content: 'A' }] as never);
  const id = (editor.document[0] as { id: string }).id;
  const uploader = { start: vi.fn(), retry: vi.fn(), remove: vi.fn() };
  render(
    <DocumentUploadPlaceholders
      editor={editor as never}
      uploader={uploader as unknown as DocumentUploader}
      readOnly={readOnly}
    />,
  );
  let slot = '';
  act(() => {
    [slot] = addUploadBatch(editor.prosemirrorView!, { before: id, after: null }, ['take2.mp4']);
  });
  return { editor, slot, uploader };
}

describe('a placeholder while its file uploads (A4)', () => {
  it('names the file and says it is uploading, inside the body', () => {
    const { editor } = open();

    const shown = screen.getByTestId('doc-upload-placeholder');
    expect(shown.textContent).toContain('take2.mp4');
    expect(shown.textContent).toContain('Uploading');
    expect(editor.prosemirrorView!.dom.contains(shown)).toBe(true);
  });

  it('shows the share that has landed once one has', () => {
    const { editor, slot } = open();

    act(() => {
      patchUploadSlot(editor.prosemirrorView!, slot, { progress: 0.4 });
    });

    expect(screen.getByTestId('doc-upload-placeholder').textContent).toContain('40%');
  });

  it('shows no share once every part has landed, which is all a one-part file ever reports', () => {
    const { editor, slot } = open();

    act(() => {
      patchUploadSlot(editor.prosemirrorView!, slot, { progress: 1 });
    });

    const shown = screen.getByTestId('doc-upload-placeholder');
    expect(shown.textContent).toContain('Uploading');
    expect(shown.textContent).not.toContain('%');
  });
});

describe('a placeholder whose file failed (A6)', () => {
  it('says why, and offers a retry where it can end differently', () => {
    const { editor, slot, uploader } = open();
    act(() => {
      patchUploadSlot(editor.prosemirrorView!, slot, {
        phase: 'failed',
        failure: { messageKey: 'canvas.upload.failed', params: {}, retryable: true },
      });
    });

    const shown = screen.getByTestId('doc-upload-placeholder');
    expect(shown.getAttribute('data-phase')).toBe('failed');
    expect(shown.textContent).toContain('take2.mp4');
    fireEvent.click(screen.getByTestId('doc-upload-retry'));
    expect(uploader.retry).toHaveBeenCalledWith(editor.prosemirrorView, slot);
    fireEvent.click(screen.getByTestId('doc-upload-remove'));
    expect(uploader.remove).toHaveBeenCalledWith(editor.prosemirrorView, slot);
  });

  it('names the file once when the sentence already names it', () => {
    const { editor, slot } = open();
    act(() => {
      patchUploadSlot(editor.prosemirrorView!, slot, {
        phase: 'failed',
        failure: {
          messageKey: 'canvas.upload.unsupportedType',
          params: { filename: 'take2.mp4', kind: 'video', formats: 'MP4' },
          retryable: false,
        },
      });
    });

    const said = screen.getByTestId('doc-upload-placeholder').textContent ?? '';
    expect(said.split('take2.mp4')).toHaveLength(2);
  });

  it('offers only removal where re-sending meets the same answer', () => {
    const { editor, slot } = open();
    act(() => {
      patchUploadSlot(editor.prosemirrorView!, slot, {
        phase: 'failed',
        failure: { messageKey: 'canvas.upload.storageFull', params: {}, retryable: false },
      });
    });

    expect(screen.queryByTestId('doc-upload-retry')).toBeNull();
    expect(screen.getByTestId('doc-upload-remove')).toBeTruthy();
  });

  it('offers no retry in a read-only body, and removal still', () => {
    const { editor, slot } = open(true);
    act(() => {
      patchUploadSlot(editor.prosemirrorView!, slot, {
        phase: 'failed',
        failure: { messageKey: 'spaces.document.media.readOnly', params: {}, retryable: true },
      });
    });

    expect(screen.queryByTestId('doc-upload-retry')).toBeNull();
    expect(screen.getByTestId('doc-upload-remove')).toBeTruthy();
  });
});

describe('a placeholder whose neighbours change (A4, A6)', () => {
  it('stays on screen, retry and all, after the block before it on its level is deleted', () => {
    const editor = buildDocumentEditor({
      fragment: documentBodyFragment(new Y.Doc()),
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
    const [a, b] = (editor.document as { id: string }[]).map((block) => block.id);
    const uploader = { start: vi.fn(), retry: vi.fn(), remove: vi.fn() };
    render(
      <DocumentUploadPlaceholders
        editor={editor as never}
        uploader={uploader as unknown as DocumentUploader}
        readOnly={false}
      />,
    );
    let slot = '';
    act(() => {
      [slot] = addUploadBatch(editor.prosemirrorView!, { before: a!, after: b! }, ['clip.mp4']);
    });
    act(() => {
      patchUploadSlot(editor.prosemirrorView!, slot, {
        phase: 'failed',
        failure: { messageKey: 'canvas.upload.failed', params: {}, retryable: true },
      });
    });

    act(() => {
      editor.removeBlocks([a!]);
    });

    const shown = screen.getByTestId('doc-upload-placeholder');
    expect(editor.prosemirrorView!.dom.contains(shown)).toBe(true);
    expect(screen.getByTestId('doc-upload-retry')).toBeTruthy();
  });
});
