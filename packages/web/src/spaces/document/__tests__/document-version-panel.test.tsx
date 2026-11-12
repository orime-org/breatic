// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The snapshot panel in the document body (inner#1129 design §7.2–§7.6):
 * it takes the body's place while open, never stands beside the comment
 * panel, and restores into the body as one undo step.
 */

import * as React from 'react';
import { act, fireEvent, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { deriveId, getLocale, type DocumentVersion } from '@breatic/shared';

import { documentsApi } from '@web/data/api/documents';
import { ApiException } from '@web/data/api/types';
import { clearAllDocSizes } from '@web/data/yjs/doc-size';
import { docName } from '@web/data/yjs/manager';
import { spaceRefusalMessage } from '@web/data/yjs/space-write';
import { enterSize } from '@web/data/yjs/__tests__/helpers/size-v2-harness';
import { renderWithTooltips as render } from '@web/test-utils/render-with-tooltips';
import { DocumentEditor } from '@web/spaces/document/DocumentEditor';
import { selectThreads } from '@web/spaces/document/document-comment-selection';
import type { ProposalLocation } from '@web/spaces/document/document-proposal-location';
import { _resetDocumentEditorCacheForTests, evictDocumentEditor, type DocumentEditorHandle } from '@web/spaces/document/document-editor-cache';
import { snapshotOf } from '@web/spaces/document/document-version-restore';
import { useDocumentEditor } from '@web/spaces/document/use-document-editor';

const toast = vi.hoisted(() => ({ success: vi.fn(), warning: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('@web/lib/toast', () => ({ toast }));
vi.mock('@web/data/api/documents', () => ({
  documentsApi: { list: vi.fn(), get: vi.fn(), rename: vi.fn(), remove: vi.fn(), save: vi.fn() },
}));
// Counts how many previews were let go; everything else is the real preview.
const previewsLetGo = vi.hoisted(() => ({ count: 0 }));
vi.mock('@web/spaces/document/document-version-view', async (importOriginal) => {
  const real = await importOriginal<typeof import('@web/spaces/document/document-version-view')>();
  return {
    ...real,
    buildVersionPreview: (...args: Parameters<typeof real.buildVersionPreview>) => {
      const built = real.buildVersionPreview(...args);
      const unmount = built.unmount.bind(built);
      built.unmount = () => {
        previewsLetGo.count += 1;
        unmount();
      };
      return built;
    },
  };
});

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
    previewsLetGo.count = 0;
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
    // Hidden, not unmounted: what the user folded in it is still folded afterwards.
    expect(screen.getByTestId('doc-outline-column')).not.toBeVisible();
    expect(screen.queryByTestId('doc-doc-menu-trigger')).toBeNull();
    expect(await screen.findByTestId('doc-version-row-v1')).toHaveTextContent('First draft');
    await waitFor(() => expect(screen.getByTestId('doc-version-preview-body')).toHaveTextContent('live words'));
    // Mounted inside the column's element, as the body is, so that element's own classes stay React's.
    expect(screen.getByTestId('doc-version-preview-body').querySelector('.ProseMirror[contenteditable="false"]')).not.toBeNull();

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

  it('refuses a restore while the Space is full, says why, and leaves the body and the panel as they were', async () => {
    const user = userEvent.setup();
    show();
    await openPanel(user);
    await user.click(await screen.findByTestId('doc-version-row-v1'));
    await waitFor(() => expect(screen.getByTestId('doc-version-preview-body')).toHaveTextContent('snapshot words'));
    const name = docName.documentSpace(SCOPE.projectId, SCOPE.spaceId);
    enterSize(name, 'F');
    try {
      await user.click(screen.getByTestId('doc-version-restore'));
      await user.click(await screen.findByTestId('doc-version-restore-confirm'));

      await waitFor(() => expect(toast.warning).toHaveBeenCalledWith(spaceRefusalMessage('add', 'full')));
      expect(screen.queryByTestId('doc-version-restore-confirm')).toBeNull();
      expect(screen.getByTestId('doc-version-panel')).toBeInTheDocument();
      expect(text()).toBe('live words');
      expect(toast.success).not.toHaveBeenCalled();
    } finally {
      clearAllDocSizes();
    }
  });

  it('says who saved a snapshot and when, in its row and its banner, without repeating an unnamed one’s time', async () => {
    const user = userEvent.setup();
    api.list.mockResolvedValue({ versions: [row('v1', 'First draft', 0), row('v2', null, 5)], nextCursor: null });
    show();
    await openPanel(user);
    const when = new Date(Date.UTC(2026, 10, 10, 8, 0)).toLocaleString(getLocale(), { dateStyle: 'medium', timeStyle: 'short' });
    const unnamedWhen = new Date(Date.UTC(2026, 10, 10, 8, 5)).toLocaleString(getLocale(), { dateStyle: 'medium', timeStyle: 'short' });

    const named = await screen.findByTestId('doc-version-row-v1');
    expect(named).toHaveTextContent(`First draftMia·${when}`);
    // The name may give way to the width; the time never does.
    expect(within(named).getByText(when)).toHaveClass('shrink-0');
    expect(within(named).getByText('Mia')).toHaveClass('truncate');
    expect(screen.getByTestId('doc-version-row-v2')).toHaveTextContent(`${unnamedWhen}Mia`);
    expect(within(screen.getByTestId('doc-version-row-v2')).queryByText('·')).toBeNull();

    await user.click(named);
    await waitFor(() => expect(screen.getByTestId('doc-version-banner')).toHaveTextContent(`First draft · Mia · ${when}`));
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

  it('stays open after a comment proposal has landed', async () => {
    const user = userEvent.setup();
    const land = show();
    const comment = Object.freeze({ ...writtenLocation(), how: 'comment' as const, threadId: 't1' }) as unknown as ProposalLocation;
    land(comment);
    await openPanel(user);

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.getByTestId('doc-version-panel')).toBeInTheDocument();
  });

  /**
   * Renders the body inside an Activity the test can hide, as a Space tab is.
   * @param strict - Whether to run it under StrictMode, as the development build does.
   * @returns Switches the Space away or back.
   */
  function showInSpace(strict = false): (mode: 'visible' | 'hidden') => void {
    const at = (mode: 'visible' | 'hidden'): React.JSX.Element => {
      const space = <React.Activity mode={mode}><DocumentEditor handle={handle} scope={SCOPE} /></React.Activity>;
      return strict ? <React.StrictMode>{space}</React.StrictMode> : space;
    };
    const { rerender } = render(at('visible'));
    return (mode) => rerender(at(mode));
  }

  /** Writes the body as several paragraphs, closing the undo step. */
  function writeLines(lines: readonly string[]): void {
    act(() => {
      handle.editor.replaceBlocks(handle.editor.document, lines.map((words) => ({ type: 'paragraph', content: words })) as never);
    });
    handle.undoManager.stopCapturing();
  }

  /**
   * Holds every snapshot read until released.
   * @returns Releases the reads.
   */
  function holdSnapshotReads(): () => void {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    api.get.mockImplementation(async (_scope, id) => {
      await gate;
      return { version: row(id, null, 0), content: rows.get(id)! };
    });
    return () => act(() => release());
  }

  /** The body's scroller, which the preview scrolls in too. */
  function scroller(): HTMLElement {
    const viewport = screen.getByTestId('document-editor-content').closest('[data-radix-scroll-area-viewport]') as HTMLElement;
    viewport.scrollTo = vi.fn() as typeof viewport.scrollTo;
    return viewport;
  }

  /** Shows the first snapshot, as the user would. */
  async function showSnapshot(user: ReturnType<typeof userEvent.setup>): Promise<void> {
    await openPanel(user);
    await user.click(await screen.findByTestId('doc-version-row-v1'));
    await waitFor(() => expect(screen.getByTestId('doc-version-banner')).toHaveTextContent('First draft'));
  }

  it('keeps the preview, what it shows and where the user is across a Space switch away and back', async () => {
    const user = userEvent.setup();
    const space = showInSpace();
    write('snapshot words');
    rows.set('v1', snapshotOf(handle.editor.prosemirrorState.doc).content);
    write('live words');
    const viewport = scroller();
    await showSnapshot(user);
    viewport.scrollTop = 700;

    space('hidden');
    // Hidden, not let go: the preview stays mounted, as the body does.
    expect(screen.getByTestId('doc-version-preview-body').childElementCount).toBe(1);
    expect(previewsLetGo.count).toBe(0);
    space('visible');

    expect(screen.getByTestId('doc-version-banner')).toHaveTextContent('First draft');
    expect(screen.getByTestId('doc-version-preview-body')).toHaveTextContent('snapshot words');
    expect(viewport.scrollTop).toBe(700);
    expect(api.get).toHaveBeenCalledTimes(1);
  });

  it('keeps a comparison as it was across a Space switch: opened folds stay open, no jump to the first change', async () => {
    const user = userEvent.setup();
    const space = showInSpace();
    writeLines(['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot']);
    rows.set('v1', snapshotOf(handle.editor.prosemirrorState.doc).content);
    // Only the last block changes; the others keep their ids and fold.
    act(() => {
      handle.editor.updateBlock(handle.editor.document.at(-1)!, { content: 'foxtrotted' } as never);
    });
    const viewport = scroller();
    await showSnapshot(user);
    await user.click(screen.getByTestId('doc-version-compare-current'));
    await user.click(await screen.findByTestId('doc-version-fold'));
    expect(screen.queryByTestId('doc-version-fold')).toBeNull();
    vi.mocked(viewport.scrollTo).mockClear();

    space('hidden');
    space('visible');

    expect(screen.getByTestId('doc-version-banner')).toBeInTheDocument();
    expect(screen.queryByTestId('doc-version-fold')).toBeNull();
    expect(viewport.scrollTo).not.toHaveBeenCalled();
  });

  it('lets a selection still loading arrive across a Space switch', async () => {
    const user = userEvent.setup();
    const space = showInSpace();
    write('snapshot words');
    rows.set('v1', snapshotOf(handle.editor.prosemirrorState.doc).content);
    write('second words');
    rows.set('v2', snapshotOf(handle.editor.prosemirrorState.doc).content);
    write('live words');
    api.list.mockResolvedValue({ versions: [row('v2', 'Second', 1), row('v1', 'First draft', 0)], nextCursor: null });
    await showSnapshot(user);
    const release = holdSnapshotReads();
    await user.click(screen.getByTestId('doc-version-row-v2'));

    space('hidden');
    space('visible');
    release();

    await waitFor(() => expect(screen.getByTestId('doc-version-banner')).toHaveTextContent('Second'));
    expect(screen.getByTestId('doc-version-preview-body')).toHaveTextContent('second words');
    expect(api.get).toHaveBeenCalledTimes(2);
  });

  it('scrolls a comparison that arrived while the Space was hidden to its first change', async () => {
    const user = userEvent.setup();
    const space = showInSpace();
    write('snapshot words');
    rows.set('v1', snapshotOf(handle.editor.prosemirrorState.doc).content);
    write('live words');
    const viewport = scroller();
    await showSnapshot(user);
    const release = holdSnapshotReads();
    await user.click(screen.getByTestId('doc-version-compare-current'));

    space('hidden');
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    space('visible');

    await waitFor(() => expect(viewport.scrollTo).toHaveBeenCalled());
  });

  it('keeps the pages of the list it loaded across a Space switch', async () => {
    const user = userEvent.setup();
    const space = showInSpace();
    api.list.mockImplementation(async (_scope, cursor) => cursor === undefined
      ? { versions: [row('v1', 'First draft', 1)], nextCursor: 'c1' }
      : { versions: [row('v2', 'Older', 0)], nextCursor: null });
    await openPanel(user);
    await user.click(await screen.findByTestId('doc-version-load-more'));
    await screen.findByTestId('doc-version-row-v2');

    space('hidden');
    space('visible');

    expect(screen.getByTestId('doc-version-row-v2')).toBeInTheDocument();
    expect(api.list).toHaveBeenCalledTimes(2);
  });

  it('keeps the current content as it was when the panel opened across a Space switch', async () => {
    const user = userEvent.setup();
    const space = showInSpace();
    write('live words');
    await openPanel(user);
    await waitFor(() => expect(screen.getByTestId('doc-version-preview-body')).toHaveTextContent('live words'));

    space('hidden');
    write('words a collaborator wrote meanwhile');
    space('visible');

    expect(screen.getByTestId('doc-version-preview-body')).toHaveTextContent('live words');
  });

  it('lets the preview go when its tab is closed while the Space is hidden', async () => {
    const user = userEvent.setup();
    const space = showInSpace();
    await openPanel(user);
    space('hidden');
    expect(previewsLetGo.count).toBe(0);

    act(() => evictDocumentEditor('project-p/version-panel'));

    expect(previewsLetGo.count).toBe(1);
    expect(screen.getByTestId('doc-version-preview-body').childElementCount).toBe(0);
  });

  it('lets the preview go once when its editor is evicted while shown and the body then goes', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<DocumentEditor handle={handle} scope={SCOPE} />);
    await openPanel(user);

    act(() => evictDocumentEditor('project-p/version-panel'));
    unmount();

    expect(previewsLetGo.count).toBe(1);
  });

  it('mounts one preview in development mode and lets it go when the panel closes', async () => {
    const user = userEvent.setup();
    const space = showInSpace(true);
    await openPanel(user);
    space('hidden');
    space('visible');
    expect(screen.getByTestId('doc-version-preview-body').childElementCount).toBe(1);
    expect(previewsLetGo.count).toBe(0);

    await user.click(screen.getByTestId('doc-version-close'));

    expect(previewsLetGo.count).toBe(1);
    // Let go once: the eviction that follows finds nothing left to end.
    act(() => evictDocumentEditor('project-p/version-panel'));
    expect(previewsLetGo.count).toBe(1);
  });

  it('leaves a page that came back not found to the list alone', async () => {
    const user = userEvent.setup();
    api.list.mockImplementation(async (_scope, cursor) => {
      if (cursor === undefined) return { versions: [row('v1', 'First draft', 0)], nextCursor: 'c1' };
      throw new ApiException({ status: 404, message: 'gone', fromServer: true });
    });
    show();
    await openPanel(user);
    await user.click(await screen.findByTestId('doc-version-load-more'));

    expect(await screen.findByTestId('doc-version-load-failed')).toBeInTheDocument();
    expect(toast.warning).not.toHaveBeenCalled();
    expect(api.list).toHaveBeenCalledTimes(2);
  });

  it('offers no restore while another snapshot is still loading', async () => {
    const user = userEvent.setup();
    show();
    rows.set('v2', rows.get('v1')!);
    let arrive: () => void = () => undefined;
    api.list.mockResolvedValue({ versions: [row('v1', 'First draft', 1), row('v2', 'Second', 0)], nextCursor: null });
    api.get.mockImplementation(async (_scope, id) => {
      if (id === 'v2') await new Promise<void>((resolve) => { arrive = resolve; });
      return { version: row(id, null, 0), content: rows.get(id)! };
    });
    await openPanel(user);
    await user.click(await screen.findByTestId('doc-version-row-v1'));
    await waitFor(() => expect(screen.getByTestId('doc-version-restore')).toBeEnabled());

    await user.click(screen.getByTestId('doc-version-row-v2'));
    await waitFor(() => expect(screen.getByTestId('doc-version-restore')).toBeDisabled());
    act(() => arrive());
    await waitFor(() => expect(screen.getByTestId('doc-version-restore')).toBeEnabled());
  });

  it('keeps a retry on screen, waiting, while it runs', async () => {
    const user = userEvent.setup();
    let refreshes = 0;
    let answer: () => void = () => undefined;
    api.list.mockImplementation(async () => {
      refreshes += 1;
      if (refreshes === 2) throw new ApiException({ status: 500, message: 'boom', fromServer: true });
      if (refreshes === 3) await new Promise<void>((resolve) => { answer = resolve; });
      return { versions: [row('v1', 'First draft', 0)], nextCursor: null };
    });
    api.rename.mockResolvedValue(undefined);
    show();
    await openPanel(user);
    await user.click(await screen.findByTestId('doc-version-row-menu-v1'));
    await user.click(await screen.findByTestId('doc-version-rename'));
    await user.type(await screen.findByTestId('doc-snapshot-name-input'), ' again');
    await user.click(screen.getByTestId('doc-snapshot-name-submit'));
    const failedRow = await screen.findByTestId('doc-version-load-failed');

    await user.click(within(failedRow).getByRole('button'));

    expect(within(screen.getByTestId('doc-version-load-failed')).getByRole('button')).toHaveAttribute('aria-busy', 'true');
    act(() => answer());
    await waitFor(() => expect(screen.queryByTestId('doc-version-load-failed')).toBeNull());
  });

  it('scrolls the preview to the words of the first change', async () => {
    const user = userEvent.setup();
    show();
    const viewport = screen.getByTestId('document-editor-content').closest('[data-radix-scroll-area-viewport]') as HTMLElement;
    const scrollTo = vi.fn();
    viewport.scrollTo = scrollTo as typeof viewport.scrollTo;
    const range = vi.spyOn(Range.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 900, 10, 10));
    await openPanel(user);
    await user.click(await screen.findByTestId('doc-version-row-v1'));
    await user.click(await screen.findByTestId('doc-version-compare-current'));

    await waitFor(() => expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ top: 900 })));
    range.mockRestore();
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

  it('says so when the preview cannot draw a snapshot', async () => {
    const user = userEvent.setup();
    show();
    rows.set('bad', { type: 'doc', content: [{ type: 'blockGroup', content: [{ type: 'notABlock' }] }] });
    api.list.mockResolvedValue({ versions: [row('bad', 'Broken', 0)], nextCursor: null });
    await openPanel(user);

    await user.click(await screen.findByTestId('doc-version-row-bad'));

    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('doc-version-banner')).toBeNull();
  });

  it('keeps the delete dialog open when the delete fails', async () => {
    const user = userEvent.setup();
    api.remove.mockRejectedValueOnce(new ApiException({ status: 500, message: 'boom', fromServer: true }));
    show();
    await openPanel(user);
    await user.click(await screen.findByTestId('doc-version-row-menu-v1'));
    await user.click(await screen.findByTestId('doc-version-delete'));
    await user.click(within(await screen.findByTestId('doc-version-delete-dialog')).getByTestId('doc-version-delete-confirm'));

    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('doc-version-delete-dialog')).toBeInTheDocument();
  });

  it('shows a failed page with a retry that loads that page again', async () => {
    const user = userEvent.setup();
    api.list.mockImplementation(async (_scope, cursor) => {
      if (cursor === undefined) return { versions: [row('v1', 'First draft', 0)], nextCursor: 'c1' };
      if (api.list.mock.calls.filter(([, c]) => c === 'c1').length === 1) throw new ApiException({ status: 500, message: 'boom', fromServer: true });
      return { versions: [row('v2', 'Older', 0)], nextCursor: null };
    });
    show();
    await openPanel(user);
    await user.click(await screen.findByTestId('doc-version-load-more'));

    expect(await screen.findByTestId('doc-version-load-failed')).toBeInTheDocument();
    expect(screen.getByTestId('doc-version-row-v1')).toBeInTheDocument();
    await user.click(within(screen.getByTestId('doc-version-load-failed')).getByRole('button'));

    expect(await screen.findByTestId('doc-version-row-v2')).toBeInTheDocument();
    expect(screen.queryByTestId('doc-version-load-failed')).toBeNull();
  });

  it('keeps naming a snapshot from a later page after the list goes back to the first', async () => {
    const user = userEvent.setup();
    show();
    rows.set('v2', rows.get('v1')!);
    api.list.mockImplementation(async (_scope, cursor) => (cursor === undefined
      ? { versions: [row('v1', 'First draft', 1)], nextCursor: 'c1' }
      : { versions: [row('v2', 'Second page', 0)], nextCursor: null }));
    api.rename.mockResolvedValue(undefined);
    await openPanel(user);
    await user.click(await screen.findByTestId('doc-version-load-more'));
    await user.click(await screen.findByTestId('doc-version-row-v2'));
    await waitFor(() => expect(screen.getByTestId('doc-version-banner')).toHaveTextContent('Second page'));

    await user.click(screen.getByTestId('doc-version-row-menu-v1'));
    await user.click(await screen.findByTestId('doc-version-rename'));
    await user.type(await screen.findByTestId('doc-snapshot-name-input'), ' again');
    await user.click(screen.getByTestId('doc-snapshot-name-submit'));
    await waitFor(() => expect(screen.queryByTestId('doc-version-row-v2')).toBeNull());

    expect(screen.getByTestId('doc-version-banner')).toHaveTextContent('Second page');
  });

  it('puts the body back where the user was reading when the panel closes', async () => {
    const user = userEvent.setup();
    show();
    const viewport = screen.getByTestId('document-editor-content').closest('[data-radix-scroll-area-viewport]') as HTMLElement;
    let top = 1500;
    Object.defineProperty(viewport, 'scrollTop', { configurable: true, get: () => top, set: (value: number) => { top = value; } });
    await openPanel(user);
    // The preview in its place is shorter, and the browser pulls the scroller back.
    top = 0;

    await user.click(screen.getByTestId('doc-version-close'));

    expect(top).toBe(1500);
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
