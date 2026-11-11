// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Where a user comments on a picture, a video or an audio block, or hands it
 * to the Agent, and how the body shows that a media block has comments
 * (inner#1316 §5.1, §5.4).
 *
 * The media toolbar gains Add to Agent and Comment after Download, for
 * editors, and Add to Agent only inside a project; neither is on a table open
 * full screen. The block handle's two rows work on an uploaded media block
 * and are greyed on a pending frame, which says why when pressed. A media
 * block with open comments carries an icon with their count, for viewers too,
 * except in a table open full screen; pressing it reads all of them.
 */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

import { documentBodyFragment } from '@breatic/shared';

import type { TrayItem } from '@web/stores/chat-attachments';

const attachToChat = vi.hoisted(() =>
  vi.fn(async (_projectId: string, _items: readonly TrayItem[]): Promise<void> => undefined),
);
vi.mock('@web/stores/attach-to-chat', () => ({ attachToChat }));
const toast = vi.hoisted(() => ({ warning: vi.fn(), info: vi.fn(), error: vi.fn(), success: vi.fn() }));
vi.mock('@web/lib/toast', () => ({ toast }));

const { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } = await import('@web/components/ui/dropdown-menu');
const { TooltipProvider } = await import('@web/components/ui/tooltip');
const { buildDocumentEditor } = await import('@web/spaces/document/build-document-editor');
const { DocumentBlockMenu } = await import('@web/spaces/document/DocumentBlockMenu');
const { DocumentMediaViews } = await import('@web/spaces/document/DocumentMediaViews');
const { asCommentBody, commentsOn } = await import('@web/spaces/document/document-comment-extension');
const { draftIn } = await import('@web/spaces/document/document-comment-draft-range');
const { commentOn } = await import('@web/spaces/document/document-comment-post');
const { selectedThreadsIn } = await import('@web/spaces/document/document-comment-selection');
const { DocumentProjectProvider } = await import('@web/spaces/document/document-project-context');
const { setTableFullscreen } = await import('@web/spaces/document/document-table-fullscreen');
const { tableBlock } = await import('@web/spaces/document/__tests__/table-fixtures');

type Editor = ReturnType<typeof buildDocumentEditor>;

const mounted: Editor[] = [];

afterEach(() => {
  cleanup();
  attachToChat.mockClear();
  toast.warning.mockClear();
  mounted.splice(0).forEach((editor) => {
    editor.unmount();
  });
});

const PICTURE = { id: 'pic', type: 'image', props: { url: 'https://cdn.test/a.png', name: 'a.png' } };
const SOUND = { id: 'snd', type: 'audio', props: { url: 'https://cdn.test/s.mp3', name: 'sea.mp3' } };
const PENDING = { id: 'pending', type: 'image', props: { uploadId: 'up-1', url: '', name: 'b.png' } };

/**
 * Mounts an editor with comments wired and the media views drawn.
 * @param blocks - The body.
 * @param options - How the page is.
 * @param options.readOnly - Whether the user only views.
 * @param options.projectId - The project, or null outside one.
 * @returns The editor.
 */
function open(blocks: unknown[], { readOnly = false, projectId = 'project-1' }: { readOnly?: boolean; projectId?: string | null } = {}): Editor {
  const doc = new Y.Doc();
  const editor = buildDocumentEditor({
    fragment: documentBodyFragment(doc),
    // Whoever posts is an editor; a viewer's page is the read-only view below.
    comments: { doc, readWho: () => ({ role: 'editor', viewerId: 'u1' }) },
  });
  const root = document.createElement('div');
  document.body.appendChild(root);
  act(() => {
    editor.mount(root);
  });
  mounted.push(editor);
  const views = (
    <TooltipProvider>
      <DocumentMediaViews editor={editor} readOnly={readOnly} />
    </TooltipProvider>
  );
  render(projectId === null ? views : <DocumentProjectProvider projectId={projectId}>{views}</DocumentProjectProvider>);
  act(() => {
    editor.replaceBlocks(editor.document, blocks as never);
  });
  return editor;
}

/**
 * A media block's element in the body.
 * @param editor - The editor.
 * @param blockId - The block.
 * @returns Its row.
 */
function row(editor: Editor, blockId: string): HTMLElement {
  return editor.prosemirrorView!.dom.querySelector<HTMLElement>(`.bn-block-outer[data-id="${blockId}"]`)!;
}

/**
 * The test ids of a media block's toolbar buttons, in order.
 * @param editor - The editor.
 * @param blockId - The block.
 * @returns The ids.
 */
function toolbarButtons(editor: Editor, blockId: string): string[] {
  const bar = within(row(editor, blockId)).getByTestId('doc-media-toolbar');
  return [...bar.querySelectorAll('[data-testid]')].map((el) => el.getAttribute('data-testid')!);
}

/**
 * Posts a comment on a media block.
 * @param editor - The editor.
 * @param blockId - The block.
 * @returns The thread id.
 */
async function postOn(editor: Editor, blockId: string): Promise<string> {
  let id = '';
  await act(async () => {
    const posted = await commentOn(editor, asCommentBody('a note'), { mediaBlockId: blockId });
    id = (posted as { id: string }).id;
  });
  return id;
}

describe('the media toolbar', () => {
  it.each([
    ['a picture', PICTURE],
    ['an audio block', SOUND],
  ])('offers Add to Agent and Comment after Download and before Delete on %s', (_label, block) => {
    const editor = open([block]);

    const ids = toolbarButtons(editor, block.id);
    const at = ids.indexOf('doc-media-download');
    expect(ids.slice(at, at + 4)).toEqual(['doc-media-download', 'doc-media-add-to-agent', 'doc-media-comment', 'doc-media-delete']);
  });

  it('opens a draft on the picture from Comment', () => {
    const editor = open([PICTURE]);

    fireEvent.click(within(row(editor, 'pic')).getByTestId('doc-media-comment'));

    expect(draftIn(editor.prosemirrorState)).toMatchObject({ kind: 'aimed', mediaBlockId: 'pic' });
  });

  it('hands the picture to the project from Add to Agent', async () => {
    const editor = open([PICTURE]);

    fireEvent.click(within(row(editor, 'pic')).getByTestId('doc-media-add-to-agent'));

    await waitFor(() => expect(attachToChat).toHaveBeenCalledTimes(1));
    expect(attachToChat.mock.calls[0]![0]).toBe('project-1');
    expect(attachToChat.mock.calls[0]![1].map((item) => item.id)).toEqual(['document-media-pic']);
  });

  it('offers no Add to Agent outside a project', () => {
    const editor = open([PICTURE], { projectId: null });

    expect(toolbarButtons(editor, 'pic')).not.toContain('doc-media-add-to-agent');
    expect(toolbarButtons(editor, 'pic')).toContain('doc-media-comment');
  });

  it('offers neither to a viewer', () => {
    const editor = open([PICTURE], { readOnly: true });

    expect(toolbarButtons(editor, 'pic')).not.toContain('doc-media-add-to-agent');
    expect(toolbarButtons(editor, 'pic')).not.toContain('doc-media-comment');
  });

  it('offers neither while a table is open full screen', () => {
    const editor = open([PICTURE, tableBlock({ rows: [{ cells: ['a', 'b'] }] })]);
    const tableId = (editor.document as { id: string; type: string }[]).find((b) => b.type !== 'image')!.id;

    act(() => {
      setTableFullscreen(editor, { table: tableId, scrollTop: 0, offset: 0 });
    });

    expect(toolbarButtons(editor, 'pic')).not.toContain('doc-media-add-to-agent');
    expect(toolbarButtons(editor, 'pic')).not.toContain('doc-media-comment');
  });
});

describe('the comment icon on a media block', () => {
  it('counts the open comments and drops one once resolved', async () => {
    const editor = open([PICTURE]);
    expect(within(row(editor, 'pic')).queryByTestId('doc-media-comment-badge')).toBeNull();

    const first = await postOn(editor, 'pic');
    await postOn(editor, 'pic');
    expect(within(row(editor, 'pic')).getByTestId('doc-media-comment-badge').textContent).toBe('2');

    await act(async () => {
      await commentsOn(editor)!.threadStore.resolveThread({ threadId: first });
    });
    expect(within(row(editor, 'pic')).getByTestId('doc-media-comment-badge').textContent).toBe('1');
  });

  it('reads every open comment on the block when pressed, and outlines the block', async () => {
    const editor = open([PICTURE]);
    const first = await postOn(editor, 'pic');
    const second = await postOn(editor, 'pic');

    fireEvent.click(within(row(editor, 'pic')).getByTestId('doc-media-comment-badge'));

    expect([...selectedThreadsIn(editor.prosemirrorState)].sort()).toEqual([first, second].sort());
    expect(within(row(editor, 'pic')).getByTestId('doc-media-frame').getAttribute('data-comment-reading')).toBe('true');
  });

  it('shows to a viewer as well', async () => {
    const editor = open([PICTURE], { readOnly: true });
    await postOn(editor, 'pic');

    const badge = within(row(editor, 'pic')).getByTestId('doc-media-comment-badge');
    expect(badge.hasAttribute('data-media-viewer')).toBe(true);
  });

  it('is not drawn while a table is open full screen', async () => {
    const editor = open([PICTURE, tableBlock({ rows: [{ cells: ['a', 'b'] }] })]);
    await postOn(editor, 'pic');
    const tableId = (editor.document as { id: string; type: string }[]).find((b) => b.type !== 'image')!.id;

    act(() => {
      setTableFullscreen(editor, { table: tableId, scrollTop: 0, offset: 0 });
    });

    expect(within(row(editor, 'pic')).queryByTestId('doc-media-comment-badge')).toBeNull();
  });
});

describe('the block handle rows on media', () => {
  /**
   * Opens the block menu over one block, inside a project.
   * @param editor - The editor.
   * @param blockId - The block.
   * @returns The close callback the menu was handed.
   */
  function menuOver(editor: Editor, blockId: string): () => void {
    const close = vi.fn();
    const block = (editor.document as unknown as { id: string }[]).find((b) => b.id === blockId)!;
    render(
      <DocumentProjectProvider projectId='project-1'>
        <DropdownMenu open>
          <DropdownMenuTrigger />
          <DropdownMenuContent>
            <DocumentBlockMenu editor={editor as never} block={block as never} close={close} />
          </DropdownMenuContent>
        </DropdownMenu>
      </DocumentProjectProvider>,
    );
    return close;
  }

  it('lets Comment open a draft on an uploaded picture', () => {
    const editor = open([PICTURE]);
    menuOver(editor, 'pic');

    expect(screen.getByTestId('doc-block-row-comment').getAttribute('aria-disabled')).toBeNull();
    fireEvent.click(screen.getByTestId('doc-block-row-comment'));

    expect(draftIn(editor.prosemirrorState)).toMatchObject({ kind: 'aimed', mediaBlockId: 'pic' });
  });

  it('lets Add to Agent hand the picture over with the rows under it', async () => {
    const editor = open([{ ...PICTURE, children: [{ type: 'paragraph', content: 'Shot 1' }] }]);
    menuOver(editor, 'pic');

    fireEvent.click(screen.getByTestId('doc-block-row-addToAgent'));

    await waitFor(() => expect(attachToChat).toHaveBeenCalledTimes(1));
    expect(attachToChat.mock.calls[0]![1].map((item) => item.id)).toEqual(['document-media-pic', 'document-block-pic']);
  });

  it('greys both rows on a picture still uploading, and says why when pressed', () => {
    const editor = open([PENDING]);
    menuOver(editor, 'pending');

    expect(screen.getByTestId('doc-block-row-comment').getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByTestId('doc-block-row-addToAgent').getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(screen.getByTestId('doc-block-row-comment'));
    fireEvent.click(screen.getByTestId('doc-block-row-addToAgent'));

    expect(toast.warning).toHaveBeenCalledTimes(2);
    expect(toast.warning).toHaveBeenCalledWith('The media has not finished uploading.');
    expect(draftIn(editor.prosemirrorState)).toBeNull();
    expect(attachToChat).not.toHaveBeenCalled();
  });
});
