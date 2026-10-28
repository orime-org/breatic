// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The editor chrome: the scrolling body, the whole-document entry, the bubble
 * bar. The editor comes from the container, so these tests drive a real one
 * through the real user path — no test-only hooks into the component.
 *
 * ## Where the two viewer tests went
 *
 * Two tests here used to pin that the toolbar's controls were all disabled for
 * a viewer, and that clicking one changed nothing in the shared document. The
 * toolbar is gone, and with it the entry point they named.
 * `selection-bubble-bar.test.tsx` carries that ground now (A7): a viewer never
 * sees the bar at all, so there is no control on that path to click. What was
 * deleted is the tests, not the invariant.
 */

import * as React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import * as Y from 'yjs';
import { encodeInitialSpaceContent } from '@breatic/shared';
import { TextSelection } from '@tiptap/pm/state';

import { Awareness } from 'y-protocols/awareness';

import { deriveId, type DocumentProposal } from '@breatic/shared';

import { BODY_SCROLLER_CLASS } from '@web/spaces/document/document-body-scroller';
import { DocumentEditor } from '@web/spaces/document/DocumentEditor';
import { requestCommentLocation, selectedThreadsIn } from '@web/spaces/document/document-comment-selection';
import { landedAt, landProposal, type Landed } from '@web/spaces/document/document-proposal-landing';
import type { ProposalLocation } from '@web/spaces/document/document-proposal-location';
import {
  _resetDocumentEditorCacheForTests,
  adoptDocumentEditor,
  evictDocumentEditor,
  getDocumentEditor,
  type DocumentEditorHandle,
} from '@web/spaces/document/document-editor-cache';
import type { DocumentUploader } from '@web/spaces/document/document-uploads';
import { useDocumentEditor } from '@web/spaces/document/use-document-editor';
import { tableBlock } from '@web/spaces/document/__tests__/table-fixtures';

describe('DocumentEditor', () => {
  const NAME = 'project-p/document-chrome';
  let doc: Y.Doc;
  let awareness: Awareness;
  let handle: DocumentEditorHandle;

  /** Builds a valid publication for the chrome's geometry fixture. */
  function publication(at: Landed, proposal: DocumentProposal): ProposalLocation {
    return Object.freeze({ ...at, documentName: NAME, handle, pending: { proposal, action: 'view' as const, order: 0 }, owner: {} });
  }

  /** Gives the existing first block an actual proposal trace for measurement. */
  function writtenLocation(): ProposalLocation {
    const proposalId = '33333333-3333-4333-8333-333333333333';
    const blockId = deriveId(`document-proposal:${proposalId}:0`);
    const view = handle.editor.prosemirrorView;
    const first = view.state.doc.firstChild!.firstChild!;
    act(() => view.dispatch(view.state.tr.setNodeMarkup(1, undefined, { ...first.attrs, id: blockId })));
    return publication({ how: 'write', blockId }, {
      proposalId, spaceId: 'd1', spaceName: 'Document', kind: 'insert', blockId: null,
      body: 'Output', title: 'Suggestion', heading: '', original: '', blockType: null, lossy: false,
    });
  }

  beforeEach(async () => {
    doc = new Y.Doc();
    Y.applyUpdate(doc, encodeInitialSpaceContent('document'));
    awareness = new Awareness(doc);
    const { result } = renderHook(() =>
      useDocumentEditor({
        doc,
        name: NAME,
        caretProvider: { awareness },
        readWho: () => ({ role: 'editor', viewerId: 'u1' }),
      }),
    );
    await waitFor(() => expect(result.current).not.toBeNull());
    handle = result.current!;
  });

  afterEach(() => {
    _resetDocumentEditorCacheForTests();
    awareness.destroy();
    doc.destroy();
  });

  it('keeps the editor in the body when the reader turns read-only while it is open', () => {
    // A role change or an archive refetches the project with the Space open
    // (`use-refresh-on-reauth.ts`), so `readOnly` flips on a mounted body.
    const uploader: DocumentUploader = {
      start: () => Promise.resolve(),
      retry: () => undefined,
      remove: () => undefined,
    };
    const { container, rerender } = render(
      <DocumentEditor handle={handle} uploader={uploader} />,
    );
    expect(container.contains(handle.surface)).toBe(true);

    rerender(<DocumentEditor handle={handle} uploader={uploader} readOnly />);

    expect(container.contains(handle.surface)).toBe(true);
  });

  it('renders one chrome element beside the body: the scroller', () => {
    // The top toolbar is gone (task #129). This counts what the shell renders
    // rather than naming test ids the toolbar used to carry — those queries
    // went vacuous the moment it was deleted. Anything new added beside the
    // body turns this red. Two things do NOT: the bubble bar, which only
    // renders while a selection exists, and anything portalled out.
    //
    // The shell holds one row, and the row is where the columns go: the body
    // and, once the reader opens it, the comment panel (#18, A18).
    const { container } = render(<DocumentEditor handle={handle} />);
    const shell = [...container.firstElementChild!.children];
    expect(shell).toHaveLength(1);

    const columns = [...shell[0].children];
    expect(columns).toHaveLength(1);
    expect(columns[0]).toHaveClass(BODY_SCROLLER_CLASS);
  });

  it('puts the whole-document entry inside the scroller, ahead of the page', () => {
    // Inside, so a wheel over it finds the body the way the browser normally
    // does. Ahead of the page, so it sticks to the top edge while the text
    // scrolls under it.
    render(<DocumentEditor handle={handle} />);
    const viewport = document.querySelector(
      `.${BODY_SCROLLER_CLASS} [data-radix-scroll-area-viewport]`,
    )!;
    const trigger = screen.getByTestId('doc-doc-menu-trigger');
    const content = screen.getByTestId('document-editor-content');

    expect(viewport.contains(trigger)).toBe(true);
    expect(viewport.firstElementChild!.contains(trigger)).toBe(true);
    expect(
      trigger.compareDocumentPosition(content) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('renders the body and the whole-document entry', () => {
    render(<DocumentEditor handle={handle} />);
    expect(screen.getByTestId('document-editor-content')).toBeInTheDocument();
    expect(screen.getByTestId('doc-doc-menu-trigger')).toBeInTheDocument();
  });

  /**
   * Put one link in the body and drop the caret inside it.
   * @param text - The link's text.
   * @returns Nothing; the editor on `handle` is written to.
   */
  const caretInsideALink = async (text = 'our docs'): Promise<void> => {
    const { editor } = handle;
    editor.replaceBlocks(editor.document, [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'see ', styles: {} },
          { type: 'link', href: 'https://a.example/docs', content: text },
          { type: 'text', text: ' now', styles: {} },
        ],
      },
    ] as never);
    let inside = -1;
    const { doc: pmDoc, schema } = editor.prosemirrorState;
    pmDoc.descendants((node, pos) => {
      if (
        inside < 0 &&
        node.isText &&
        node.marks.some((m) => m.type === schema.marks.link)
      ) {
        inside = pos + 1;
      }
      return true;
    });
    // The caret raises the toolbar only while the body holds the focus
    // (inner#1127 A20).
    editor.prosemirrorView.dom.focus();
    editor.transact((tr) => {
      tr.setSelection(TextSelection.create(tr.doc, inside));
    });
  };

  it('raises the link toolbar for someone who can edit', async () => {
    // The other half of the case below: without this one, "no toolbar for a
    // viewer" would pass just as well if the toolbar never appeared at all.
    render(<DocumentEditor handle={handle} />);
    await caretInsideALink();

    await waitFor(() =>
      expect(screen.getByTestId('doc-link-toolbar')).toBeInTheDocument(),
    );
  });

  it('keeps the link toolbar away from a viewer', async () => {
    // Acceptance E1. The toolbar's two controls write to the document, and
    // ProseMirror does not gate a dispatch on whether the editor is editable —
    // so a viewer who can press them strips the link from their own copy.
    //
    // Waited for rather than asserted outright: what puts the toolbar on
    // screen is a state update the caret triggers, and an assertion made
    // before React has flushed it holds whether or not the viewer is gated.
    render(<DocumentEditor handle={handle} readOnly />);
    await caretInsideALink();

    await expect(
      screen.findByTestId('doc-link-toolbar', {}, { timeout: 400 }),
    ).rejects.toThrow();
  });

  /**
   * Let a co-editor write into the shared document.
   * @param write - What the peer does through the actual records editor.
   * @throws {Error} If peer construction or its real editing command fails.
   */
  const peerWrites = (write: (editor: DocumentEditorHandle['editor']) => void): void => {
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
    const peerAwareness = new Awareness(peer);
    const peerName = `${NAME}-peer`;
    const root = document.createElement('div');
    document.body.appendChild(root);
    try {
      const opened = getDocumentEditor(peer, peerName, { caretProvider: { awareness: peerAwareness }, readWho: () => ({ role: 'editor', viewerId: 'u2' }), editable: true });
      act(() => { adoptDocumentEditor(opened, root); write(opened.editor); });
      act(() => Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer)));
    } finally {
      act(() => evictDocumentEditor(peerName));
      peerAwareness.destroy();
      peer.destroy();
      root.remove();
    }
  };

  it('keeps the toolbar on the same link when a peer writes before it', async () => {
    // Acceptance F1. The controller re-asks what link the caret is on for
    // every change, a peer's included, so the toolbar has to survive one that
    // moves the link without touching it.
    render(<DocumentEditor handle={handle} />);
    await caretInsideALink();
    await waitFor(() =>
      expect(screen.getByTestId('doc-link-toolbar')).toBeInTheDocument(),
    );

    peerWrites((editor) => {
      editor.transact((transaction) => transaction.insertText('AAA ', 3));
    });

    await waitFor(() =>
      expect(handle.editor.prosemirrorState.doc.textContent).toBe(
        'AAA see our docs now',
      ),
    );
    expect(screen.getByTestId('doc-link-toolbar')).toBeInTheDocument();
    expect(screen.getByTestId('doc-link-url')).toHaveTextContent(
      'https://a.example/docs',
    );
  });

  it('takes the toolbar away when a peer deletes the link', async () => {
    // Acceptance F2. What the toolbar acts on has gone; it has nothing left to
    // point at.
    render(<DocumentEditor handle={handle} />);
    await caretInsideALink();
    await waitFor(() =>
      expect(screen.getByTestId('doc-link-toolbar')).toBeInTheDocument(),
    );

    peerWrites((editor) => {
      editor.transact((transaction) => transaction.delete(3, 3 + transaction.doc.textContent.length));
    });

    await waitFor(() =>
      expect(screen.queryByTestId('doc-link-toolbar')).not.toBeInTheDocument(),
    );
  });

  it('brings a landed block into view once, not again each time its Space is shown (inner#1509)', async () => {
    const uploader = { start: () => Promise.resolve(), retry: () => undefined, remove: () => undefined } as unknown as DocumentUploader;
    const scrollTo = vi.fn();
    const original = HTMLElement.prototype.scrollTo;
    HTMLElement.prototype.scrollTo = scrollTo as typeof HTMLElement.prototype.scrollTo;
    try {
      const at = (mode: 'visible' | 'hidden', landed: ProposalLocation | null): React.JSX.Element => (
        <React.Activity mode={mode}>
          <DocumentEditor handle={handle} uploader={uploader} landed={landed} />
        </React.Activity>
      );
      const { rerender } = render(at('visible', null));
      const landed = writtenLocation();
      rerender(at('visible', landed));
      await waitFor(() => expect(scrollTo).toHaveBeenCalledTimes(1));

      rerender(at('hidden', landed));
      rerender(at('visible', landed));
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(scrollTo).toHaveBeenCalledTimes(1);
    } finally {
      HTMLElement.prototype.scrollTo = original;
    }
  });

  it.each(['paragraph', 'table'] as const)('outlines the landed %s itself, leaving descendant blocks out of its measurement', async (kind) => {
    const { editor } = handle;
    const { rerender } = render(<DocumentEditor handle={handle} />);
    editor.replaceBlocks(editor.document, [kind === 'table'
      ? tableBlock({ rows: [{ cells: ['H1', 'H2'] }, { cells: ['A', 'B'] }] })
      : { type: 'paragraph', content: 'Parent', children: [{ type: 'paragraph', content: 'Child' }] },
    ] as never);
    const location = writtenLocation();
    const blockId = location.blockId;
    const block = handle.surface.querySelector<HTMLElement>(`[data-id="${blockId}"]`)!;
    const own = kind === 'table' ? block : block.querySelector<HTMLElement>(':scope > .bn-block > .bn-block-content')!;
    const nested = block.querySelectorAll<HTMLElement>('.bn-block-content')[kind === 'table' ? 0 : 1];
    expect(nested).not.toBe(own);
    const viewport = document.querySelector<HTMLElement>('[data-radix-scroll-area-viewport]')!;
    const spies = [
      vi.spyOn(own, 'getBoundingClientRect').mockReturnValue(new DOMRect(40, 90, 300, 160)),
      vi.spyOn(nested, 'getBoundingClientRect').mockReturnValue(new DOMRect(50, 100, 90, 20)),
      vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(new DOMRect(10, 20, 500, 400)),
    ];
    viewport.style.setProperty('--space-2', '8px');
    viewport.scrollTop = 30;
    viewport.scrollLeft = 5;
    try {
      rerender(<DocumentEditor handle={handle} landed={location} />);

      await waitFor(() => expect(screen.getByTestId('document-proposal-landed')).toHaveStyle({
        top: '92px', left: '27px', width: '316px', height: '176px',
      }));
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it.each(['timer', 'replacement', 'hidden'] as const)('remeasures a growing landed table, scrolls once and retires its callbacks after %s', async (ending) => {
    const observers: ControlledResizeObserver[] = [];
    const originalResizeObserver = globalThis.ResizeObserver;
    /** Delivers browser size notifications, including a previously queued delivery. */
    class ControlledResizeObserver implements ResizeObserver {
      readonly targets = new Set<Element>();

      /** Saves the callback that receives a browser layout notification. */
      constructor(readonly callback: ResizeObserverCallback) {
        observers.push(this);
      }

      /** Watches one real DOM element. */
      observe(target: Element): void { this.targets.add(target); }
      /** Stops watching one element. */
      unobserve(target: Element): void { this.targets.delete(target); }
      /** Ends active observations; already queued deliveries remain test inputs. */
      disconnect(): void { this.targets.clear(); }
      /** Delivers the current geometry of the given observed elements. */
      deliver(targets: readonly Element[] = [...this.targets]): void {
        const entries = targets.map((target): ResizeObserverEntry => {
          const contentRect = target.getBoundingClientRect();
          const size = [{ inlineSize: contentRect.width, blockSize: contentRect.height }];
          return { target, contentRect, borderBoxSize: size, contentBoxSize: size, devicePixelContentBoxSize: size };
        });
        if (entries.length > 0) this.callback(entries, this);
      }
    }
    vi.stubGlobal('ResizeObserver', ControlledResizeObserver);
    const at = (mode: 'visible' | 'hidden', landed: ProposalLocation | null): React.JSX.Element => (
      <React.Activity mode={mode}><DocumentEditor handle={handle} landed={landed} /></React.Activity>
    );
    const { rerender, unmount } = render(at('visible', null));
    const spies: Array<{ mockRestore: () => void }> = [];
    try {
      act(() => handle.editor.replaceBlocks(handle.editor.document, [
        tableBlock({ rows: [{ cells: ['H1', 'H2'] }, { cells: ['A', 'B'] }] }),
        { type: 'paragraph', content: 'NEXT' },
      ] as never));
      await waitFor(() => expect(handle.surface.querySelectorAll('.doc-table-frame')).toHaveLength(1));
      const location = writtenLocation();
      const block = handle.surface.querySelector<HTMLElement>(`[data-id="${location.blockId}"]`)!;
      const viewport = document.querySelector<HTMLElement>('[data-radix-scroll-area-viewport]')!;
      let bounds = new DOMRect(40, 90, 300, 160);
      spies.push(vi.spyOn(block, 'getBoundingClientRect').mockImplementation(() => bounds));
      spies.push(vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(new DOMRect(10, 20, 500, 400)));
      const scroll = vi.spyOn(viewport, 'scrollTo').mockImplementation(() => undefined);
      spies.push(scroll);
      viewport.style.setProperty('--space-2', '8px');
      viewport.scrollTop = 30;
      viewport.scrollLeft = 5;
      const bytes = Y.encodeStateAsUpdate(doc);
      const tree: unknown = handle.editor.prosemirrorState.doc.toJSON();
      const undo = [...handle.undoManager.undoStack];
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      rerender(at('visible', location));
      expect(screen.getByTestId('document-proposal-landed')).toHaveStyle({
        top: '92px', left: '27px', width: '316px', height: '176px',
      });
      expect(scroll).toHaveBeenCalledTimes(1);

      bounds = new DOMRect(50, 110, 420, 210);
      act(() => { for (const observer of [...observers]) observer.deliver(); });
      expect(screen.getByTestId('document-proposal-landed')).toHaveStyle({
        top: '112px', left: '37px', width: '436px', height: '226px',
      });
      expect(scroll).toHaveBeenCalledTimes(1);
      expect(Y.encodeStateAsUpdate(doc)).toEqual(bytes);
      expect(handle.editor.prosemirrorState.doc.toJSON()).toEqual(tree);
      expect(handle.undoManager.undoStack).toEqual(undo);
      const queued = observers.map((observer) => ({ observer, targets: [...observer.targets] }));

      if (ending === 'replacement') {
        const proposalId = '55555555-5555-4555-8555-555555555555';
        const blockId = deriveId(`document-proposal:${proposalId}:0`);
        const view = handle.editor.prosemirrorView;
        const secondPos = 1 + view.state.doc.firstChild!.firstChild!.nodeSize;
        const second = view.state.doc.nodeAt(secondPos)!;
        act(() => view.dispatch(view.state.tr.setNodeMarkup(secondPos, undefined, { ...second.attrs, id: blockId })));
        const next = publication({ how: 'write', blockId }, {
          proposalId, spaceId: 'd1', spaceName: 'Document', kind: 'insert', blockId: null,
          body: 'NEXT', title: 'Suggestion', heading: '', original: '', blockType: null, lossy: false,
        });
        const own = handle.surface.querySelector<HTMLElement>(`[data-id="${blockId}"] .bn-block-content`)!;
        spies.push(vi.spyOn(own, 'getBoundingClientRect').mockReturnValue(new DOMRect(80, 160, 160, 40)));
        rerender(at('visible', next));
        expect(screen.getByTestId('document-proposal-landed')).toHaveStyle({
          top: '162px', left: '67px', width: '176px', height: '56px',
        });
      } else if (ending === 'timer') {
        act(() => vi.advanceTimersByTime(2000));
        expect(screen.queryByTestId('document-proposal-landed')).toBeNull();
      } else {
        rerender(at('hidden', location));
        expect(screen.queryByTestId('document-proposal-landed')).toBeNull();
      }
      bounds = new DOMRect(5, 5, 900, 700);
      act(() => { for (const delivery of queued) delivery.observer.deliver(delivery.targets); });
      if (ending === 'replacement') {
        expect(screen.getByTestId('document-proposal-landed')).toHaveStyle({
          top: '162px', left: '67px', width: '176px', height: '56px',
        });
      } else {
        expect(screen.queryByTestId('document-proposal-landed')).toBeNull();
      }
      expect(scroll).toHaveBeenCalledTimes(ending === 'replacement' ? 2 : 1);
    } finally {
      unmount();
      vi.useRealTimers();
      for (const spy of spies) spy.mockRestore();
      vi.stubGlobal('ResizeObserver', originalResizeObserver);
    }
  });

  it('opens the panel on a comment an Agent proposal landed, the way a comment the reader wrote is shown (inner#1509)', async () => {
    const uploader = { start: () => Promise.resolve(), retry: () => undefined, remove: () => undefined } as unknown as DocumentUploader;
    const { editor } = handle;
    const { rerender } = render(<DocumentEditor handle={handle} uploader={uploader} />);
    editor.replaceBlocks(editor.document, await editor.tryParseMarkdownToBlocks('The hero arrives.'));
    const block = editor.document[0] as { id: string };
    const proposal = {
      proposalId: '33333333-3333-4333-8333-333333333333',
      spaceId: '44444444-4444-4444-8444-444444444444',
      spaceName: 'Storyboard',
      kind: 'comment' as const,
      blockId: block.id,
      quote: 'hero',
      body: 'Who?',
      title: 't',
      heading: '',
      original: 'The hero arrives.',
      blockType: 'paragraph',
      lossy: false,
    };
    await landProposal(handle, proposal, 'comment', () => ({ available: true, writeAccess: 'granted' }));
    const landed = landedAt(handle, proposal);
    expect(landed?.how).toBe('comment');

    if (landed === null) throw new Error('The fixture has no landing.');
    const location = publication(landed, proposal);
    act(() => requestCommentLocation(editor, location));
    rerender(<DocumentEditor handle={handle} uploader={uploader} landed={location} />);

    await waitFor(() => expect(screen.getByTestId('doc-comment-rail')).toBeInTheDocument());
    expect(selectedThreadsIn(editor.prosemirrorState)).toEqual([landed?.how === 'comment' ? landed.threadId : '']);
    expect(screen.queryByTestId('document-proposal-landed')).not.toBeInTheDocument();
  });
});
