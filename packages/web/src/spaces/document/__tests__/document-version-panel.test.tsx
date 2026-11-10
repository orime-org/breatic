// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The snapshot panel in the document body (inner#1129 design §7.2–§7.6):
 * it takes the body's place while open, never stands beside the comment
 * panel, and restores into the body as one undo step.
 */

import { act, fireEvent, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { deriveId, type DocumentVersion } from '@breatic/shared';

import { documentsApi } from '@web/data/api/documents';
import { ApiException } from '@web/data/api/types';
import { renderWithTooltips as render } from '@web/test-utils/render-with-tooltips';
import { DocumentEditor } from '@web/spaces/document/DocumentEditor';
import { selectThreads } from '@web/spaces/document/document-comment-selection';
import type { ProposalLocation } from '@web/spaces/document/document-proposal-location';
import { _resetDocumentEditorCacheForTests, type DocumentEditorHandle } from '@web/spaces/document/document-editor-cache';
import { snapshotOf } from '@web/spaces/document/document-version-restore';
import { useDocumentEditor } from '@web/spaces/document/use-document-editor';

const toast = vi.hoisted(() => ({ success: vi.fn(), warning: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('@web/lib/toast', () => ({ toast }));
vi.mock('@web/data/api/documents', () => ({
  documentsApi: { list: vi.fn(), get: vi.fn(), rename: vi.fn(), remove: vi.fn(), save: vi.fn() },
}));

const api = vi.mocked(documentsApi);
const SCOPE = { projectId: 'p', spaceId: 's' };
const rows = new Map<string, Record<string, unknown>>();

/** A server row for a snapshot. */
function row(id: string, name: string | null, minutes: number): DocumentVersion {
  const at = new Date(Date.UTC(2026, 10, 10, 8, minutes)).toISOString();
  return { id, projectId: 'p', spaceId: 's', name, schemaVersion: 'x', createdAt: at, updatedAt: at, createdBy: { id: 'u1', name: 'Mia' } };
}

describe('the snapshot panel', () => {
  let doc: Y.Doc;
  let awareness: Awareness;
  let handle: DocumentEditorHandle;

  const text = (): string => handle.editor.prosemirrorState.doc.textContent;

  /** Writes the body, as the user would, closing the undo step. */
  function write(words: string): void {
    act(() => {
      handle.editor.replaceBlocks(handle.editor.document, [{ type: 'paragraph', content: words }] as never);
    });
    handle.undoManager.stopCapturing();
  }

  /**
   * Renders the body, then writes it: the editor binds to its document when
   * it mounts, and what was written before that is replaced by it.
   * @param readOnly - Whether the user is a viewer.
   */
  function show(readOnly = false): (landed: ProposalLocation) => void {
    const { rerender } = render(<DocumentEditor handle={handle} scope={SCOPE} readOnly={readOnly} />);
    write('snapshot words');
    rows.set('v1', snapshotOf(handle.editor.prosemirrorState.doc).content);
    write('live words');
    return (landed) => rerender(<DocumentEditor handle={handle} scope={SCOPE} readOnly={readOnly} landed={landed} />);
  }

  /** An Agent proposal written into the first block, as the pickup publishes it. */
  function writtenLocation(): ProposalLocation {
    const proposalId = '33333333-3333-4333-8333-333333333333';
    const blockId = deriveId(`document-proposal:${proposalId}:0`);
    const view = handle.editor.prosemirrorView!;
    const first = view.state.doc.firstChild!.firstChild!;
    act(() => view.dispatch(view.state.tr.setNodeMarkup(1, undefined, { ...first.attrs, id: blockId })));
    const proposal = {
      proposalId, spaceId: 's', spaceName: 'Document', kind: 'insert' as const, blockId: null,
      body: 'Output', title: 'Suggestion', heading: '', original: '', blockType: null, lossy: false,
    };
    return Object.freeze({ how: 'write' as const, blockId, documentName: 'project-p/version-panel', handle, pending: { proposal, action: 'view' as const, order: 0 }, owner: {} });
  }

  /** Opens the panel from the menu. */
  async function openPanel(user: ReturnType<typeof userEvent.setup>): Promise<void> {
    await user.click(screen.getByTestId('doc-doc-menu-trigger'));
    await user.click(await screen.findByTestId('doc-doc-menu-restore-snapshot'));
    await screen.findByTestId('doc-version-panel');
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    rows.clear();
    doc = new Y.Doc();
    awareness = new Awareness(doc);
    const { result } = renderHook(() =>
      useDocumentEditor({ doc, name: 'project-p/version-panel', caretProvider: { awareness }, readWho: () => ({ role: 'editor', viewerId: 'u1' }) }),
    );
    await waitFor(() => expect(result.current).not.toBeNull());
    handle = result.current!;
    api.list.mockResolvedValue({ versions: [row('v1', 'First draft', 0)], nextCursor: null });
    api.get.mockImplementation(async (_scope, id) => ({ version: row(id, null, 0), content: rows.get(id)! }));
  });

  afterEach(() => {
    _resetDocumentEditorCacheForTests();
    awareness.destroy();
    doc.destroy();
  });

  it('takes the body’s place: the body unseen and still mounted, no outline, its media paused', async () => {
    const user = userEvent.setup();
    show();
    act(() => {
      handle.editor.insertBlocks([{ type: 'video', props: { url: 'https://assets.example.invalid/v.mp4' } }] as never, handle.editor.document[0]!, 'after');
    });
    await waitFor(() => expect(handle.editor.prosemirrorView!.dom.querySelector('video')).not.toBeNull());
    expect(screen.getByTestId('doc-outline-column')).toBeInTheDocument();
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);

    await openPanel(user);

    expect(pause).toHaveBeenCalled();
    expect(screen.getByTestId('document-body-column').className).toContain('invisible');
    expect(screen.getByTestId('document-editor-content')).toBeInTheDocument();
    expect(screen.queryByTestId('doc-outline-column')).toBeNull();
    expect(screen.queryByTestId('doc-doc-menu-trigger')).toBeNull();
    expect(await screen.findByTestId('doc-version-row-v1')).toHaveTextContent('First draft');
    await waitFor(() => expect(screen.getByTestId('doc-version-preview-body')).toHaveTextContent('live words'));

    await user.click(screen.getByTestId('doc-version-close'));
    expect(screen.queryByTestId('doc-version-panel')).toBeNull();
    expect(screen.getByTestId('document-body-column').className).not.toContain('invisible');
    expect(screen.getByTestId('doc-outline-column')).toBeInTheDocument();
    pause.mockRestore();
  });

  it('previews a snapshot and restores it into the body as one undo step', async () => {
    const user = userEvent.setup();
    show();
    await openPanel(user);
    await user.click(await screen.findByTestId('doc-version-row-v1'));
    await waitFor(() => expect(screen.getByTestId('doc-version-preview-body')).toHaveTextContent('snapshot words'));
    expect(text()).toBe('live words');

    await user.click(screen.getByTestId('doc-version-restore'));
    await user.click(await screen.findByTestId('doc-version-restore-confirm'));

    await waitFor(() => expect(screen.queryByTestId('doc-version-panel')).toBeNull());
    expect(text()).toBe('snapshot words');
    expect(toast.success).toHaveBeenCalledTimes(1);
    act(() => handle.editor.undo());
    expect(text()).toBe('live words');
  });

  it('gives a viewer no way to restore, rename or delete', async () => {
    const user = userEvent.setup();
    show(true);
    await openPanel(user);
    await user.click(await screen.findByTestId('doc-version-row-v1'));
    await screen.findByTestId('doc-version-banner');

    expect(screen.queryByTestId('doc-version-restore')).toBeNull();
    await user.click(screen.getByTestId('doc-version-row-menu-v1'));
    await waitFor(() => expect(document.querySelector('[role="menu"]')).not.toBeNull());
    expect(screen.queryByTestId('doc-version-rename')).toBeNull();
    expect(screen.queryByTestId('doc-version-delete')).toBeNull();
  });

  it('gives way to the comment panel when a thread is selected', async () => {
    const user = userEvent.setup();
    show();
    await openPanel(user);

    act(() => selectThreads(handle.editor, ['t1']));

    await waitFor(() => expect(screen.queryByTestId('doc-version-panel')).toBeNull());
    expect(screen.getByTestId('doc-comment-rail')).toBeInTheDocument();
  });

  it('closes for a landed proposal, and shows it once the body is on screen', async () => {
    const user = userEvent.setup();
    const land = show();
    await openPanel(user);
    const scrollTo = vi.spyOn(HTMLElement.prototype, 'scrollTo').mockImplementation(() => undefined);

    land(writtenLocation());

    await waitFor(() => expect(screen.queryByTestId('doc-version-panel')).toBeNull());
    await waitFor(() => expect(screen.getByTestId('document-proposal-landed')).toBeInTheDocument());
    expect(scrollTo).toHaveBeenCalledTimes(1);
    scrollTo.mockRestore();
  });

  it('does not undo the unseen body from the scroller while open', async () => {
    const user = userEvent.setup();
    show();
    const viewport = screen.getByTestId('document-editor-content').closest('[data-radix-scroll-area-viewport]') as HTMLElement;
    await openPanel(user);

    fireEvent.keyDown(viewport, { key: 'z', metaKey: true });
    fireEvent.keyDown(viewport, { key: 'z', ctrlKey: true });
    expect(text()).toBe('live words');

    await user.click(screen.getByTestId('doc-version-close'));
    fireEvent.keyDown(viewport, { key: 'z', metaKey: true });
    expect(text()).toBe('snapshot words');
  });

  it('refreshes the list after a rename or delete that found the snapshot gone', async () => {
    const user = userEvent.setup();
    api.remove.mockRejectedValueOnce(new ApiException({ status: 404, message: 'gone', fromServer: true }));
    show();
    await openPanel(user);
    await user.click(await screen.findByTestId('doc-version-row-menu-v1'));
    await user.click(await screen.findByTestId('doc-version-delete'));
    await user.click(within(await screen.findByTestId('doc-version-delete-dialog')).getByTestId('doc-version-delete-confirm'));

    await waitFor(() => expect(toast.warning).toHaveBeenCalledTimes(1));
    expect(api.list).toHaveBeenCalledTimes(2);
  });
});

describe('saving a snapshot', () => {
  let doc: Y.Doc;
  let awareness: Awareness;
  let handle: DocumentEditorHandle;

  beforeEach(async () => {
    vi.clearAllMocks();
    doc = new Y.Doc();
    awareness = new Awareness(doc);
    const { result } = renderHook(() =>
      useDocumentEditor({ doc, name: 'project-p/version-save', caretProvider: { awareness }, readWho: () => ({ role: 'editor', viewerId: 'u1' }) }),
    );
    await waitFor(() => expect(result.current).not.toBeNull());
    handle = result.current!;
  });

  /** Renders the body, then writes it with one image still uploading. */
  function show(): void {
    render(<DocumentEditor handle={handle} scope={SCOPE} />);
    act(() => {
      handle.editor.replaceBlocks(handle.editor.document, [
        { type: 'paragraph', content: 'kept' },
        { type: 'image', props: { uploadId: 'u1', url: '', caption: '' } },
      ] as never);
    });
  }

  afterEach(() => {
    _resetDocumentEditorCacheForTests();
    awareness.destroy();
    doc.destroy();
  });

  /** Saves through the menu's dialog under a name. */
  async function save(user: ReturnType<typeof userEvent.setup>, name: string): Promise<void> {
    await user.click(screen.getByTestId('doc-doc-menu-trigger'));
    await user.click(await screen.findByTestId('doc-doc-menu-save-snapshot'));
    if (name !== '') await user.type(await screen.findByTestId('doc-snapshot-name-input'), name);
    await user.click(screen.getByTestId('doc-snapshot-name-submit'));
  }

  it('saves the body without what is still uploading, and says how many were left out', async () => {
    const user = userEvent.setup();
    api.save.mockResolvedValueOnce(row('v9', 'Mine', 0));
    show();

    await save(user, '  Mine  ');

    await waitFor(() => expect(screen.queryByTestId('doc-snapshot-name-dialog')).toBeNull());
    const [scope, input] = api.save.mock.calls[0]!;
    expect(scope).toEqual(SCOPE);
    expect(input.name).toBe('Mine');
    expect(JSON.stringify(input.content)).not.toContain('"u1"');
    expect(toast.success).toHaveBeenCalledTimes(1);
    expect(toast.warning).toHaveBeenCalledTimes(1);
  });

  it('sends no name when none was given', async () => {
    const user = userEvent.setup();
    api.save.mockResolvedValueOnce(row('v9', null, 0));
    show();

    await save(user, '');

    await waitFor(() => expect(api.save).toHaveBeenCalledTimes(1));
    expect(api.save.mock.calls[0]![1].name).toBeUndefined();
  });

  it('shows the server’s sentence at the ceiling, and keeps the dialog on any other failure', async () => {
    const user = userEvent.setup();
    api.save.mockRejectedValueOnce(new ApiException({ status: 409, message: 'Full at 100.', fromServer: true, reason: 'document_versions_full' }));
    show();
    await save(user, '');
    await waitFor(() => expect(toast.warning).toHaveBeenCalledWith('Full at 100.'));
    await waitFor(() => expect(screen.queryByTestId('doc-snapshot-name-dialog')).toBeNull());

    api.save.mockRejectedValueOnce(new ApiException({ status: 500, message: 'boom', fromServer: true }));
    await save(user, '');
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('doc-snapshot-name-dialog')).toBeInTheDocument();
  });
});
