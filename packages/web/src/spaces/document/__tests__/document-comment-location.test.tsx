// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Agent View reaches the real comment selection and final sidebar consumer
 * (inner#1619, inner#1509 section 5.4; comments A8/A9).
 *
 * Only the connection snapshot is isolated. The cache, pickup, proposal
 * store, selection plugin, comment store and rendered sidebar are real.
 * Geometry is controlled jsdom input to the scroll controller, not evidence
 * that the actual browser has laid the card out at these coordinates.
 */

import * as React from 'react';
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TextSelection } from '@tiptap/pm/state';
import { CommentsExtension } from '@blocknote/core/comments';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';

import { type DocumentProposal } from '@breatic/shared';

import { DocumentEditor } from '@web/spaces/document/DocumentEditor';
import {
  _resetDocumentEditorCacheForTests,
  type DocumentEditorHandle,
} from '@web/spaces/document/document-editor-cache';
import { openCommentDraft } from '@web/spaces/document/document-comment-entries';
import { draftIn, DRAFT_THREAD_ID } from '@web/spaces/document/document-comment-draft-range';
import { selectThreads, selectedThreadsIn } from '@web/spaces/document/document-comment-selection';
import { landProposal, landedAt } from '@web/spaces/document/document-proposal-landing';
import { useDocumentEditor } from '@web/spaces/document/use-document-editor';
import { useDocumentProposalPickup } from '@web/spaces/document/use-document-proposal-pickup';
import { useDocumentProposals } from '@web/stores/document-proposals';

const connection = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('@web/data/yjs/collab-socket', async (readActual) => ({
  ...await readActual<typeof import('@web/data/yjs/collab-socket')>(),
  readDocConnection: connection.read,
}));

const NAME = 'project-p/document-agent-comment-location';
const SPACE_ID = '44444444-4444-4444-8444-444444444444';

describe('an explicit Agent comment View', () => {
  let doc: Y.Doc;
  let awareness: Awareness;
  let handle: DocumentEditorHandle;
  let provider: HocuspocusProvider;
  let transport: HocuspocusProviderWebsocket;

  beforeEach(async () => {
    useDocumentProposals.getState().reset();
    doc = new Y.Doc();
    awareness = new Awareness(doc);
    transport = new HocuspocusProviderWebsocket({
      url: 'ws://localhost',
      autoConnect: false,
    });
    provider = new HocuspocusProvider({
      name: NAME,
      document: doc,
      awareness,
      websocketProvider: transport,
    });
    connection.read.mockImplementation((name: string) => name === NAME ? {
      provider,
      document: doc,
      hasEverSynced: true,
      authFailure: null,
      writeAccess: 'granted' as const,
    } : null);
    const { result } = renderHook(() => useDocumentEditor({
      doc,
      name: NAME,
      caretProvider: { awareness },
      readWho: () => ({ role: 'editor', viewerId: 'u1' }),
    }));
    await waitFor(() => expect(result.current).not.toBeNull());
    handle = result.current!;
  });

  afterEach(() => {
    cleanup();
    _resetDocumentEditorCacheForTests();
    useDocumentProposals.getState().reset();
    provider.destroy();
    transport.destroy();
    awareness.destroy();
    doc.destroy();
    vi.restoreAllMocks();
  });

  /** Renders the production pickup and its actual display consumer. */
  function Body(): React.JSX.Element {
    const landed = useDocumentProposalPickup(SPACE_ID, handle, 'granted', false, NAME);
    return <DocumentEditor handle={handle} myRole='editor' landed={landed} />;
  }

  /** Renders the same Activity ownership used when switching Spaces. */
  function visibleBody(mode: 'visible' | 'hidden'): React.JSX.Element {
    return <React.Activity mode={mode}><Body /></React.Activity>;
  }

  /** Mounts the real editor and creates an already-landed Agent comment. */
  async function fixture(): Promise<{
    proposal: DocumentProposal;
    threadId: string;
    rerender: (ui: React.ReactNode) => void;
  }> {
    const { rerender } = render(visibleBody('visible'));
    act(() => {
      handle.editor.replaceBlocks(handle.editor.document, [
        { type: 'paragraph', content: 'alpha bravo charlie' },
      ] as never);
    });
    const blockId = (handle.editor.document[0] as { id: string }).id;
    const proposal: DocumentProposal = {
      proposalId: '33333333-3333-4333-8333-333333333333',
      spaceId: SPACE_ID,
      spaceName: 'Document',
      kind: 'comment',
      blockId,
      quote: 'alpha',
      original: 'alpha bravo charlie',
      blockType: 'paragraph',
      body: 'Agent observation',
      title: 'Comment',
      heading: '',
      lossy: false,
    };
    await act(async () => {
      await landProposal(handle, proposal, 'comment', () => ({ available: true, writeAccess: 'granted' }));
    });
    const at = landedAt(handle, proposal);
    expect(at?.how).toBe('comment');
    if (at?.how !== 'comment') throw new Error('The comment fixture did not land.');
    return { proposal, threadId: at.threadId, rerender };
  }

  /** Finishes a real View request through the proposal store and pickup. */
  async function view(proposal: DocumentProposal): Promise<void> {
    act(() => {
      useDocumentProposals.getState().view(proposal, 'comment');
    });
    await waitFor(() => {
      expect(useDocumentProposals.getState().pending[proposal.proposalId]).toBeUndefined();
      expect(useDocumentProposals.getState().cards[proposal.proposalId]).toEqual({
        state: 'applied',
        action: 'comment',
      });
    });
  }

  /** Resolves the actual stored thread while preserving its body mark. */
  async function resolve(threadId: string): Promise<void> {
    await act(async () => {
      await handle.editor.getExtension(CommentsExtension)!.threadStore.resolveThread({ threadId });
    });
  }

  /** The first text range, used only to place an ordinary native caret. */
  function firstRun(): { from: number; to: number } {
    let run: { from: number; to: number } | null = null;
    handle.editor.prosemirrorState.doc.descendants((node, pos) => {
      if (node.isText && run === null) run = { from: pos, to: pos + node.nodeSize };
      return true;
    });
    if (run === null) throw new Error('The fixture has no text.');
    return run;
  }

  it('shows a resolved but still anchored Agent comment from the default filter', async () => {
    // 1509 section 5.5 recognises the stored thread and its mark, including
    // resolved threads. The explicit View must display that valid landing.
    const { proposal, threadId } = await fixture();
    await resolve(threadId);
    expect(landedAt(handle, proposal)).toEqual({
      how: 'comment', blockId: proposal.blockId, threadId,
    });

    await view(proposal);

    const card = await screen.findByTestId('doc-comment-card');
    expect(card).toHaveTextContent('Agent observation');
    expect(card.dataset.selected).toBe('true');
    expect(screen.getByTestId('doc-comment-rail-filter-all')).toHaveAttribute('aria-pressed', 'true');
    expect(selectedThreadsIn(handle.editor.prosemirrorState)).toEqual([threadId]);
    expect(handle.editor.prosemirrorView!.dom.querySelector('.bn-thread-mark')).toHaveAttribute('data-orphan', 'true');
  });

  it('keeps a later manual filter across Activity and prepares All for a fresh View', async () => {
    const { proposal, threadId, rerender } = await fixture();
    await view(proposal);
    await screen.findByTestId('doc-comment-card');
    await userEvent.click(screen.getByTestId('doc-comment-rail-filter-open'));
    await resolve(threadId);
    await waitFor(() => expect(selectedThreadsIn(handle.editor.prosemirrorState)).toEqual([]));

    rerender(visibleBody('hidden'));
    rerender(visibleBody('visible'));

    expect(screen.getByTestId('doc-comment-rail-filter-open')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryAllByTestId('doc-comment-card')).toHaveLength(0);
    await view(proposal);
    expect(await screen.findByTestId('doc-comment-card')).toHaveTextContent('Agent observation');
    expect(screen.getByTestId('doc-comment-rail-filter-all')).toHaveAttribute('aria-pressed', 'true');
    expect(selectedThreadsIn(handle.editor.prosemirrorState)).toEqual([threadId]);
  });

  it('repeats the final reveal for a fresh View of the same selected thread', async () => {
    const { proposal, threadId } = await fixture();
    const viewport = document.querySelector<HTMLElement>('[data-radix-scroll-area-viewport]')!;
    vi.spyOn(handle.editor.prosemirrorView!, 'coordsAtPos').mockReturnValue({
      top: 600, bottom: 620, left: 0, right: 10,
    });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement): DOMRect {
      if (this.dataset.testid === 'doc-comment-rail-header') return new DOMRect(0, 0, 300, 40);
      if (this.dataset.testid === 'doc-comment-rail-column') return new DOMRect(0, 40, 300, 1000);
      if (this === viewport) return new DOMRect(0, 0, 900, 300);
      return new DOMRect(0, 0, 300, 120);
    });
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(120);
    const scroll = vi.spyOn(viewport, 'scrollTo').mockImplementation((options: number | ScrollToOptions): void => {
      if (typeof options === 'object' && options.top !== undefined) viewport.scrollTop = options.top;
    });
    await view(proposal);
    await waitFor(() => expect(scroll).toHaveBeenCalled());
    expect(selectedThreadsIn(handle.editor.prosemirrorState)).toEqual([threadId]);
    act(() => { viewport.scrollTop = 900; });
    scroll.mockClear();

    await view(proposal);

    await waitFor(() => expect(scroll).toHaveBeenCalledTimes(1));
    expect(scroll).toHaveBeenCalledWith({ top: 1320, behavior: 'instant' });
    expect(selectedThreadsIn(handle.editor.prosemirrorState)).toEqual([threadId]);
  });

  it('does not restore an old View selection after the reader opens a draft', async () => {
    const { proposal, rerender } = await fixture();
    await view(proposal);
    await screen.findByTestId('doc-comment-card');
    const run = firstRun();
    act(() => {
      openCommentDraft(handle.editor, [{ from: run.from + 6, to: run.from + 11 }]);
    });
    const input = await screen.findByTestId('doc-comment-draft-input');
    await userEvent.type(input, 'Unsent thought');

    rerender(visibleBody('hidden'));
    rerender(visibleBody('visible'));

    expect(selectedThreadsIn(handle.editor.prosemirrorState)).toEqual([DRAFT_THREAD_ID]);
    expect(draftIn(handle.editor.prosemirrorState)?.kind).toBe('aimed');
    expect(screen.getByTestId('doc-comment-draft-input')).toHaveValue('Unsent thought');
  });

  it('keeps the panel closed after the reader closes a viewed comment', async () => {
    const { proposal, rerender } = await fixture();
    await view(proposal);
    await screen.findByTestId('doc-comment-card');
    await userEvent.click(screen.getByTestId('doc-comment-rail-close'));
    expect(selectedThreadsIn(handle.editor.prosemirrorState)).toEqual([]);

    rerender(visibleBody('hidden'));
    rerender(visibleBody('visible'));

    expect(screen.queryByTestId('doc-comment-rail')).toBeNull();
    expect(selectedThreadsIn(handle.editor.prosemirrorState)).toEqual([]);
  });

  it('preserves the Y document, native caret and undo history when viewing and repeating a card press', async () => {
    const { proposal, threadId } = await fixture();
    const run = firstRun();
    act(() => {
      const view = handle.editor.prosemirrorView!;
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, run.from + 8)));
    });
    const before = {
      y: Y.encodeStateAsUpdate(doc),
      selection: handle.editor.prosemirrorState.selection.toJSON(),
      undo: [...handle.undoManager.undoStack],
      redo: [...handle.undoManager.redoStack],
    };

    await view(proposal);
    const card = await screen.findByTestId('doc-comment-card');
    fireEvent.pointerDown(card, { button: 0 });
    act(() => selectThreads(handle.editor, [threadId]));

    expect(selectedThreadsIn(handle.editor.prosemirrorState)).toEqual([threadId]);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before.y);
    expect(handle.editor.prosemirrorState.selection.toJSON()).toEqual(before.selection);
    expect(handle.undoManager.undoStack).toEqual(before.undo);
    expect(handle.undoManager.redoStack).toEqual(before.redo);
  });
});
