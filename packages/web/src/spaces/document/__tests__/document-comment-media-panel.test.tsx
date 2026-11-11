// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Comments on media read through the whole document page (inner#1316 §5.4):
 * a viewer pressing the comment icon on a picture opens the panel at its
 * comment, and reading a comment on a picture inside a wide table brings
 * the picture's cell into view, as reading a comment on words there does.
 */

import { act, fireEvent, renderHook, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';

import { DocumentEditor } from '@web/spaces/document/DocumentEditor';
import { asCommentBody } from '@web/spaces/document/document-comment-extension';
import { commentOn } from '@web/spaces/document/document-comment-post';
import { selectThreads } from '@web/spaces/document/document-comment-selection';
import { _resetDocumentEditorCacheForTests, type DocumentEditorHandle } from '@web/spaces/document/document-editor-cache';
import { useDocumentEditor } from '@web/spaces/document/use-document-editor';
import { tableBlock } from '@web/spaces/document/__tests__/table-fixtures';
import { renderWithTooltips as render } from '@web/test-utils/render-with-tooltips';

const reveal = vi.hoisted(() => vi.fn());
vi.mock('@web/spaces/document/document-table-reveal', () => ({ revealInTable: reveal }));
vi.mock('@web/lib/toast', () => ({ toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn(), info: vi.fn() } }));

const PICTURE = { id: 'pic', type: 'image', props: { url: 'https://cdn.test/a.png', name: 'a.png' } };

describe('media comments on the document page', () => {
  const NAME = 'project-p/document-comment-media-panel';
  let doc: Y.Doc;
  let awareness: Awareness;
  let handle: DocumentEditorHandle;

  beforeEach(async () => {
    doc = new Y.Doc();
    awareness = new Awareness(doc);
    const { result } = renderHook(() =>
      useDocumentEditor({ doc, name: NAME, caretProvider: { awareness }, readWho: () => ({ role: 'editor', viewerId: 'u1' }) }),
    );
    await waitFor(() => expect(result.current).not.toBeNull());
    handle = result.current!;
  });

  afterEach(() => {
    reveal.mockClear();
    _resetDocumentEditorCacheForTests();
    awareness.destroy();
    doc.destroy();
  });

  /**
   * Mounts the page and writes the body, then a comment on the picture.
   * @param blocks - The body.
   * @param role - Who is looking.
   * @returns The comment's thread id.
   */
  async function showWithComment(blocks: unknown[], role: 'editor' | 'viewer'): Promise<string> {
    render(<DocumentEditor handle={handle} myRole={role} readOnly={role === 'viewer'} />);
    act(() => {
      handle.editor.replaceBlocks(handle.editor.document, blocks as never);
    });
    let id = '';
    await act(async () => {
      const posted = await commentOn(handle.editor, asCommentBody('warmer light'), { mediaBlockId: 'pic' });
      id = (posted as { id: string }).id;
    });
    return id;
  }

  it('opens the panel at the comment when a viewer presses the icon on the picture', async () => {
    await showWithComment([PICTURE], 'viewer');
    const picture = handle.editor.prosemirrorView!.dom.querySelector<HTMLElement>('.bn-block-outer[data-id="pic"]')!;

    fireEvent.click(within(picture).getByTestId('doc-media-comment-badge'));

    await waitFor(() => expect(screen.getByTestId('doc-comment-card')).toBeTruthy());
    expect(screen.getByTestId('doc-comment-card').textContent).toContain('warmer light');
  });

  // Writing a table whose cell holds a picture under the mounted page takes
  // about ten seconds in jsdom, close to the 15 s default; this case gets a
  // minute until that render is fast.
  it('brings a picture in a table cell into view when its comment is read', async () => {
    const id = await showWithComment([tableBlock({ rows: [{ cells: ['words', { blocks: [PICTURE] }] }] })], 'editor');

    act(() => {
      selectThreads(handle.editor as never, [id]);
    });

    await waitFor(() => expect(reveal).toHaveBeenCalled());
    const target = reveal.mock.calls.at(-1)![0] as HTMLElement;
    expect(target.getAttribute('data-id')).toBe('pic');
  }, 60_000);
});
