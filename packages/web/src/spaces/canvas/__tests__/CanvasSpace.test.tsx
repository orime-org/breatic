// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { modelsApi } from '@web/data/api';
import { toast } from 'sonner';
import { Awareness } from 'y-protocols/awareness';
import type * as React from 'react';
import type * as Y from 'yjs';

// Mock the Yjs binding so the component test never opens a real WebSocket
// (useCanvasSpace → useSocket → HocuspocusProvider). The write helpers
// (addEdge / removeNode / setNodePosition / addNode) keep their real
// implementations so we can spy on the actual write path.
vi.mock('@web/data/yjs/canvas-space', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@web/data/yjs/canvas-space')>();
  return { ...actual, useCanvasSpace: vi.fn() };
});

// Pass through the tooltip primitives: the real Radix Tooltip throws without
// the app-level TooltipProvider (App.tsx mounts it; these 38 bare renders
// don't), and tooltip behavior is pinned precisely in GenerateToolbar.test —
// not this file's concern.
// The canvas acquires the space document's shared provider so every editor on
// the board publishes carets through one awareness. Mocked so a component test
// never opens a real WebSocket; a null provider is the genuine pre-connect
// state, in which the caret extension simply does not mount.
vi.mock('@web/data/yjs/use-socket', () => ({
  useSocket: vi.fn(
    (): {
      provider: null;
      synced: boolean;
      status: 'connecting';
      authFailedReason: null;
    } => ({
      provider: null,
      synced: false,
      status: 'connecting',
      authFailedReason: null,
    }),
  ),
}));

// #1987: the pass-through test reads what the BOTTOM of the confirm chain
// receives, so the orchestrator is a spy. Nothing else in this file touches
// the real module.
vi.mock('@web/spaces/canvas/focus/run-focus-crop', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@web/spaces/canvas/focus/run-focus-crop')>();
  return { ...actual, runFocusCrop: vi.fn() };
});

vi.mock('@web/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children?: React.ReactNode }) => children,
  TooltipTrigger: ({ children }: { children?: React.ReactNode }) => children,
  TooltipContent: () => null,
  TooltipProvider: ({ children }: { children?: React.ReactNode }) => children,
}));

import { CanvasSpace } from '@web/spaces/canvas/CanvasSpace';
import * as canvasSpace from '@web/data/yjs/canvas-space';
import * as blankPng from '@web/spaces/canvas/empty-image/generate-blank-png';
import { serializeNodes } from '@web/spaces/canvas/node-clipboard';
import { VIDEO_SLOTS } from '@web/spaces/canvas/generate/video-slots';
import { useCanvasStore, useUIStore } from '@web/stores';
import { useCanvasGraphStore } from '@web/stores/canvas-graph';
import { useCurrentUserStore } from '@web/stores/current-user';
import { assetsApi } from '@web/data/api';
import { useSpaceOperationsStore } from '@web/stores/space-operations';
import { useSocket } from '@web/data/yjs/use-socket';
import { docName, getDoc, _resetForTests } from '@web/data/yjs/manager';
import { bodyToPlainText, writePlainTextIntoBody } from '@web/data/yjs/text-body';
import { addNode, getTextBody } from '@web/data/yjs/canvas-space';
import { runFocusCrop } from '@web/spaces/canvas/focus/run-focus-crop';

const mockUseCanvasSpace = vi.mocked(canvasSpace.useCanvasSpace);

// Panel / pick state is a module singleton, and this file has five top-level
// describes. A reset that lives inside one of them leaves the others running on
// whatever the previously executed describe left behind — which is exactly how
// `reference-pick interaction contract` came to depend on running before every
// test that opens a pick session. File level, so no describe can be ordered
// into a dirty start.
beforeEach(() => {
  useCanvasStore.setState({ panelHostId: null, panelKind: null, pickSession: null });
  // The active region is a module singleton for the same reason, and the
  // canvas gates read it on every key.
  useUIStore.setState({ activeRegion: 'space' });
});
const mockRunFocusCrop = vi.mocked(runFocusCrop);

let undoSpy: ReturnType<typeof vi.fn>;
let redoSpy: ReturnType<typeof vi.fn>;

/**
 * Build a full `useCanvasSpace` return, defaulting the undo controls so each
 * test only states the fields it cares about.
 * @param over - Partial overrides (nodes / edges / canUndo / canRedo).
 * @returns The mocked hook return value.
 */
function mockSpace(
  over: Partial<ReturnType<typeof canvasSpace.useCanvasSpace>> = {},
): ReturnType<typeof canvasSpace.useCanvasSpace> {
  return {
    nodes: [],
    edges: [],
    undo: undoSpy,
    redo: redoSpy,
    canUndo: false,
    canRedo: false,
    getLastWriteWasLocal: () => true,
    ...over,
  };
}

/**
 * Where a browser aims a keyboard or clipboard event: the focused element,
 * falling back to `<body>` when nothing holds focus.
 * @returns The element to dispatch from.
 */
function keyTarget(): Element {
  return document.activeElement ?? document.body;
}

/**
 * Dispatch a `keydown` on the document so the canvas history shortcut handler
 * (a document-level listener) sees it.
 * @param key - The `KeyboardEvent.key` value.
 * @param mods - Modifier flags (meta = mac Cmd, ctrl = windows Ctrl).
 */
function dispatchKeyDown(
  key: string,
  mods: {
    meta?: boolean;
    ctrl?: boolean;
    shift?: boolean;
    alt?: boolean;
    repeat?: boolean;
  } = {},
): void {
  act(() => {
    // At the focused element, which is where a browser aims a key event —
    // `<body>` when nothing holds focus. Bubbling carries it to the document
    // listeners; dispatching on `document` itself would leave `event.target`
    // as the document, a target no real key event ever has.
    keyTarget().dispatchEvent(
      new KeyboardEvent('keydown', {
        key,
        metaKey: mods.meta ?? false,
        ctrlKey: mods.ctrl ?? false,
        shiftKey: mods.shift ?? false,
        altKey: mods.alt ?? false,
        repeat: mods.repeat ?? false,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
}

/**
 * Simulate a real user click on the ReactFlow pane. With `selectionOnDrag`
 * (our Figma-like left-drag marquee) ReactFlow disables the pane's plain
 * `click` handler and instead fires `onPaneClick` from the pointerup of a
 * no-move pointerdown→pointerup pair — so a bare click event never reaches
 * it. The pointerdown must look primary (`isPrimary`, button 0) to pass the
 * Pane's guards; jsdom has no PointerEvent, so a MouseEvent is dressed with
 * the pointer fields React reads.
 * @param pane - The `.react-flow__pane` element.
 */
function clickPane(pane: Element): void {
  const pointerInit = { bubbles: true, cancelable: true, button: 0 };
  const down = new MouseEvent('pointerdown', pointerInit);
  Object.defineProperty(down, 'isPrimary', { value: true });
  Object.defineProperty(down, 'pointerId', { value: 1 });
  const up = new MouseEvent('pointerup', pointerInit);
  Object.defineProperty(up, 'isPrimary', { value: true });
  Object.defineProperty(up, 'pointerId', { value: 1 });
  act(() => {
    pane.dispatchEvent(down);
    pane.dispatchEvent(up);
  });
}

/**
 * Dispatch a `paste` event on the document with a stubbed clipboard payload.
 * jsdom's ClipboardEvent doesn't populate `clipboardData`, so we attach a
 * minimal `getData` stub the canvas handler reads.
 * @param text - The `text/plain` payload the paste handler should see.
 */
function dispatchPaste(text: string): void {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', {
    configurable: true,
    value: {
      getData: (type: string): string => (type === 'text/plain' ? text : ''),
    },
  });
  act(() => {
    keyTarget().dispatchEvent(event);
  });
}

/**
 * Mounts the space with a query client around it, the way the real app always
 * does (`App.tsx` wraps everything in one).
 *
 * The space itself asks for the model catalog now — it prefetches it on mount
 * so the Generate panel, which since #1964 refuses to render without one, does
 * not make the first Generate of a session wait. A bare mount would throw
 * "No QueryClient set". A fresh client per mount keeps one test's cached
 * catalog out of the next one.
 * @param readOnly - Mount the space in its read-only form.
 * @returns The render result.
 */
function renderSpace(readOnly = false): ReturnType<typeof render> {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <CanvasSpace projectId='p' spaceId='s' readOnly={readOnly} />
    </QueryClientProvider>,
  );
}

describe('CanvasSpace (ReactFlow mount)', () => {
  beforeEach(() => {
    mockUseCanvasSpace.mockReset();
    // Back to the factory default (provider: null) — mockReset falls through
    // to the implementation given to vi.fn (verified against @vitest/spy
    // 3.0.0: calls resolve `implementation || state.getOriginal()`). Without
    // this, the caret-wire test's mockReturnValue leaked its provider — whose
    // Y.Doc later tests destroy via _resetForTests — into every test after
    // it, making the file order-dependent (round-5).
    vi.mocked(useSocket).mockReset();
    mockRunFocusCrop.mockClear();
    undoSpy = vi.fn();
    redoSpy = vi.fn();
    useCanvasStore.setState({
      pendingNodeCreate: null,
      pendingViewportCommand: null,
      pendingHistoryCommand: null,
      canUndo: false,
      canRedo: false,
    });
    useSpaceOperationsStore.setState({ operations: {} });
    useCurrentUserStore.getState().setUser({
      id: 'u-1',
      name: 'Ada',
      email: 'ada@example.com',
      personalStudio: null,
      membershipTier: 'base',
    });
  });

  // Every collaborative editor on the board — the text nodes, the generation
  // prompt — publishes its caret through the provider resolved here. It has to
  // be the SPACE document's: carets sent into any other awareness reach nobody
  // on this canvas, and the failure is silent, because a caret that never
  // arrives looks exactly like a collaborator who is not typing.
  it('resolves the caret channel from the space document, not some other doc', () => {
    mockUseCanvasSpace.mockReturnValue(mockSpace());
    renderSpace();
    const names = vi
      .mocked(useSocket)
      .mock.calls.map((call) => call[0]?.name);
    expect(names).toContain(docName.canvasSpace('p', 's'));
  });

  // The other half of the channel (#1774 round-4): resolving the right
  // provider proves nothing if it never REACHES an editor. This walks the
  // whole wire — useSocket's provider → canvas context → TextNode → editor
  // extensions — and asserts at the far end: opening a text node publishes
  // the local identity into the space awareness, which is what a collaborator
  // actually receives. Sever the wire anywhere (the context handing out null
  // was the mutation that survived every other test) and this goes red.
  it('hands the resolved caret channel to a text node editor', async () => {
    _resetForTests();
    addNode('p', 's', {
      id: 'n1',
      type: 'text',
      position: { x: 0, y: 0 },
      data: {
        name: 'N',
        createdAt: 1,
        createdBy: 'u',
        locked: false,
        state: 'idle',
        attachments: [],
      },
    });
    writePlainTextIntoBody(
      getTextBody('p', 's', 'n1') as Y.XmlFragment,
      'already written',
    );
    const awareness = new Awareness(getDoc(docName.canvasSpace('p', 's')));
    vi.mocked(useSocket).mockReturnValue({
      provider: { awareness } as unknown as NonNullable<
        ReturnType<typeof useSocket>['provider']
      >,
      synced: true,
      hasEverSynced: true,
      status: 'connected',
      writeAccess: 'granted',
      authFailedReason: null,
    });
    mockUseCanvasSpace.mockReturnValue(
      mockSpace({
        nodes: [
          {
            id: 'n1',
            type: 'text',
            position: { x: 0, y: 0 },
            data: { kind: 'text', status: 'idle', name: 'N' },
          },
        ],
      }),
    );
    renderSpace();
    const shell = document.querySelector('.react-flow__node');
    fireEvent.keyDown(shell as HTMLElement, { key: 'Enter' });
    await waitFor(() =>
      expect(document.querySelector('.ProseMirror')).not.toBeNull(),
    );
    // What a collaborator receives: a caret with a focus flag and nothing that
    // says who we are (#1886). The server writes the id from the credential
    // this connection presented, and peers resolve the name from the project
    // roster and the colour from that id.
    await waitFor(() => {
      const local = awareness.getLocalState() as {
        user?: Record<string, unknown>;
      } | null;
      expect(local?.user).not.toBeUndefined();
      expect(local?.user).not.toHaveProperty('id');
      expect(local?.user).not.toHaveProperty('name');
    });

    // The OTHER half of item 2, and the half the assertion above cannot see:
    // "their caret dims when they switch away". The name arrives from the
    // caret extension itself, so it stays green even with the presence hook
    // deleted (round-6, proved by mutation). The focus flag is the presence
    // hook's own output, and nothing else publishes it.
    act(() => {
      window.dispatchEvent(new Event('blur'));
    });
    await waitFor(() => {
      const local = awareness.getLocalState() as {
        user?: { focused?: boolean };
      } | null;
      expect(local?.user?.focused).toBe(false);
    });
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => {
      const local = awareness.getLocalState() as {
        user?: { focused?: boolean };
      } | null;
      expect(local?.user?.focused).toBe(true);
    });
  });

  it('shows the empty-state hint when there are no nodes', () => {
    mockUseCanvasSpace.mockReturnValue(mockSpace());
    renderSpace();
    expect(screen.getByTestId('canvas-space')).toBeInTheDocument();
    expect(screen.getByTestId('canvas-empty')).toBeInTheDocument();
  });

  // Figma-like interaction: the left-button drag marquee-selects rather than
  // pans, so ReactFlow's pane must NOT carry the `draggable` class (which it
  // only adds when panOnDrag enables the left button).
  it('left-button drag selects instead of panning (pane is not draggable)', () => {
    mockUseCanvasSpace.mockReturnValue(mockSpace());
    renderSpace();
    const pane = document.querySelector('.react-flow__pane');
    expect(pane).not.toBeNull();
    expect(pane?.className).not.toContain('draggable');
  });

  // Zoom bridge: the chrome zoom toolbar posts a command through the canvas
  // store; the canvas (which owns the ReactFlow viewport) must pick it up and
  // clear the mailbox. Proves the toolbar's buttons actually reach ReactFlow.
  it('consumes a viewport command posted by the chrome zoom toolbar', async () => {
    mockUseCanvasSpace.mockReturnValue(mockSpace());
    useCanvasStore.getState().requestViewportCommand('fit');
    renderSpace();
    await waitFor(() =>
      expect(useCanvasStore.getState().pendingViewportCommand).toBeNull(),
    );
  });

  it('renders a node body through ReactFlow + the handle wrapper', () => {
    mockUseCanvasSpace.mockReturnValue(
      mockSpace({
        nodes: [
          {
            id: 'n1',
            type: 'image',
            position: { x: 0, y: 0 },
            data: { kind: 'image', content: 'x.png', status: 'idle' },
          },
        ],
      }),
    );
    renderSpace();
    expect(screen.getByTestId('image-node')).toBeInTheDocument();
    expect(screen.queryByTestId('canvas-empty')).not.toBeInTheDocument();
  });

  // Copy and duplicate carry a text node's words (#1774, acceptance item 5).
  // Both go through ONE wiring point in this component: the capture is handed
  // the bodies read out of the document. Nothing tested that link — pulling it
  // out left all 2942 tests green while Cmd+C, the menu, and Cmd/Ctrl+D all
  // emitted blank cards (round-6, proved by mutation). The clipboard payload
  // is the far end of the wire, so that is what these read.
  //
  // The pure capture function is unit-tested with a hand-fed map elsewhere;
  // what is checked here is that the canvas actually feeds it one.
  describe('a text node keeps its words through copy and duplicate', () => {
    /**
     * Seeds one written text node, mounts the canvas with it selected.
     * @returns The node id.
     */
    const mountWithWrittenNode = (): string => {
      _resetForTests();
      addNode('p', 's', {
        id: 'n1',
        type: 'text',
        position: { x: 0, y: 0 },
        data: {
          name: 'N',
          createdAt: 1,
          createdBy: 'u',
          locked: false,
          state: 'idle',
          attachments: [],
        },
      });
      writePlainTextIntoBody(
        getTextBody('p', 's', 'n1') as Y.XmlFragment,
        'notes worth keeping',
      );
      mockUseCanvasSpace.mockReturnValue(
        mockSpace({
          nodes: [
            {
              id: 'n1',
              type: 'text',
              position: { x: 0, y: 0 },
              data: { kind: 'text', status: 'idle', name: 'N' },
            },
          ],
        }),
      );
      renderSpace();
      // Selection is LOCAL state, not a Yjs field — the mirror deliberately
      // does not carry it (`toFlowNode` sets no `selected`), so putting it in
      // the mocked space would never reach the copy path. Mark it where the
      // canvas actually reads it: its ReactFlow mirror.
      act(() => {
        useCanvasGraphStore
          .getState()
          .setFlowNodes((prev) =>
            prev.map((n) => (n.id === 'n1' ? { ...n, selected: true } : n)),
          );
      });
      return 'n1';
    };

    it('puts the words on the clipboard, not a blank card', () => {
      mountWithWrittenNode();
      let written = '';
      const event = new Event('copy', { bubbles: true }) as Event & {
        clipboardData: { setData: (type: string, data: string) => void };
      };
      Object.defineProperty(event, 'clipboardData', {
        value: {
          setData: (_type: string, data: string) => {
            written = data;
          },
        },
      });
      act(() => {
        keyTarget().dispatchEvent(event);
      });
      expect(written).toContain('notes worth keeping');
    });

    it('gives the duplicate its own copy of the words', async () => {
      mountWithWrittenNode();
      dispatchKeyDown('d', { meta: true });
      // The clone is a second text node in the document, carrying the same
      // words in a body of its own.
      const doc = getDoc(docName.canvasSpace('p', 's'));
      /** Node ids in the document RIGHT NOW — re-read on every poll. */
      const currentIds = (): string[] => [
        ...doc.getMap<Y.Map<unknown>>('nodesMap').keys(),
      ];
      await waitFor(() => expect(currentIds().length).toBeGreaterThan(1));
      const cloneId = currentIds().find((id) => id !== 'n1') as string;
      expect(
        bodyToPlainText(getTextBody('p', 's', cloneId) as Y.XmlFragment),
      ).toBe('notes worth keeping');
    });
  });

  // Keyboard entry into a text node (#1774, acceptance item 9). ReactFlow's
  // node wrapper is the tab stop, so Enter has to be caught there — a handler
  // on anything the node body renders would never see the press, because the
  // event's target IS the wrapper and events travel outwards. That is exactly
  // the kind of wiring a test rendering the body alone would bless while it
  // was dead in a browser, so this one mounts the real canvas.
  it('opens a text node editor when Enter is pressed on the focused node', async () => {
    _resetForTests();
    addNode('p', 's', {
      id: 'n1',
      type: 'text',
      position: { x: 0, y: 0 },
      data: {
        name: 'N',
        createdAt: 1,
        createdBy: 'u',
        locked: false,
        state: 'idle',
        attachments: [],
      },
    });
    writePlainTextIntoBody(
      getTextBody('p', 's', 'n1') as Y.XmlFragment,
      'already written',
    );
    mockUseCanvasSpace.mockReturnValue(
      mockSpace({
        nodes: [
          {
            id: 'n1',
            type: 'text',
            position: { x: 0, y: 0 },
            data: { kind: 'text', status: 'idle', name: 'N' },
          },
        ],
      }),
    );
    renderSpace();

    const shell = document.querySelector('.react-flow__node');
    expect(shell).not.toBeNull();
    expect(document.querySelector('.ProseMirror')).toBeNull();

    fireEvent.keyDown(shell as HTMLElement, { key: 'Enter' });
    await waitFor(() =>
      expect(document.querySelector('.ProseMirror')).not.toBeNull(),
    );
  });

  // Leaving has to hand focus back. The element the caret sat in is unmounted
  // on the way out, and a browser left to itself drops focus on the document
  // body — press Escape and a keyboard user has lost their place on the board,
  // with nothing to Tab from. Caught in a real browser: jsdom's focus after an
  // unmount does not reproduce it faithfully, so this asserts the node is
  // focused rather than trusting the absence of a failure.
  it('returns focus to the node when the editor closes', async () => {
    _resetForTests();
    addNode('p', 's', {
      id: 'n1',
      type: 'text',
      position: { x: 0, y: 0 },
      data: {
        name: 'N',
        createdAt: 1,
        createdBy: 'u',
        locked: false,
        state: 'idle',
        attachments: [],
      },
    });
    writePlainTextIntoBody(
      getTextBody('p', 's', 'n1') as Y.XmlFragment,
      'written',
    );
    mockUseCanvasSpace.mockReturnValue(
      mockSpace({
        nodes: [
          {
            id: 'n1',
            type: 'text',
            position: { x: 0, y: 0 },
            data: { kind: 'text', status: 'idle', name: 'N' },
          },
        ],
      }),
    );
    renderSpace();
    const shell = document.querySelector('.react-flow__node') as HTMLElement;

    fireEvent.keyDown(shell, { key: 'Enter' });
    await waitFor(() =>
      expect(document.querySelector('.ProseMirror')).not.toBeNull(),
    );

    fireEvent.keyDown(document.querySelector('.ProseMirror') as HTMLElement, {
      key: 'Escape',
    });
    await waitFor(() =>
      expect(document.querySelector('.ProseMirror')).toBeNull(),
    );
    expect(document.activeElement).toBe(shell);
  });

  // A failed node has no body and no placeholder on screen — the error branch
  // owns the content slot — so the ONLY way a person reaches the entry point at
  // all is Enter on the node wrapper, which exists only here. What the entry
  // guard actually prevents is a write: without it, opening a body-less failed
  // node repairs it, putting a body into the shared document for a node nobody
  // can write in. Asserted on the document, because the screen looks the same
  // either way.
  it('does not repair a failed node when Enter is pressed on it', async () => {
    _resetForTests();
    addNode('p', 's', {
      id: 'n1',
      type: 'text',
      position: { x: 0, y: 0 },
      data: {
        name: 'N',
        createdAt: 1,
        createdBy: 'u',
        locked: false,
        state: 'idle',
        attachments: [],
      },
    });
    // The state an older node is in: no body at all, so a repair would show.
    (
      getDoc(docName.canvasSpace('p', 's'))
        .getMap<Y.Map<unknown>>('nodesMap')
        .get('n1')
        ?.get('data') as Y.Map<unknown>
    ).delete('body');
    mockUseCanvasSpace.mockReturnValue(
      mockSpace({
        nodes: [
          {
            id: 'n1',
            type: 'text',
            position: { x: 0, y: 0 },
            data: {
              kind: 'text',
              status: 'error',
              name: 'N',
              errorMessage: 'Extraction failed',
            },
          },
        ],
      }),
    );
    renderSpace();
    const shell = document.querySelector('.react-flow__node') as HTMLElement;

    fireEvent.keyDown(shell, { key: 'Enter' });

    expect(getTextBody('p', 's', 'n1')).toBeNull();
    expect(document.querySelector('.ProseMirror')).toBeNull();
  });

  // The other half of that distinction, and it belongs here for the same
  // reason: the difference between the two exits is whether the node shell gets
  // focus, and only a real ReactFlow renders a shell to get it. Asserted in the
  // bare component test, both branches take focus nowhere and the assertion
  // passes whether the distinction exists or not.
  it('leaves focus alone when the editor closes because focus went elsewhere', async () => {
    _resetForTests();
    addNode('p', 's', {
      id: 'n1',
      type: 'text',
      position: { x: 0, y: 0 },
      data: {
        name: 'N',
        createdAt: 1,
        createdBy: 'u',
        locked: false,
        state: 'idle',
        attachments: [],
      },
    });
    writePlainTextIntoBody(
      getTextBody('p', 's', 'n1') as Y.XmlFragment,
      'written',
    );
    mockUseCanvasSpace.mockReturnValue(
      mockSpace({
        nodes: [
          {
            id: 'n1',
            type: 'text',
            position: { x: 0, y: 0 },
            data: { kind: 'text', status: 'idle', name: 'N' },
          },
        ],
      }),
    );
    renderSpace();
    const shell = document.querySelector('.react-flow__node') as HTMLElement;

    fireEvent.keyDown(shell, { key: 'Enter' });
    await waitFor(() =>
      expect(document.querySelector('.ProseMirror')).not.toBeNull(),
    );

    // Somewhere else on the page the user clicked into.
    const elsewhere = document.createElement('button');
    document.body.appendChild(elsewhere);
    elsewhere.focus();
    fireEvent.blur(document.querySelector('.ProseMirror') as HTMLElement, {
      relatedTarget: elsewhere,
    });

    await waitFor(() =>
      expect(document.querySelector('.ProseMirror')).toBeNull(),
    );
    expect(document.activeElement).toBe(elsewhere);
    expect(document.activeElement).not.toBe(shell);
    elsewhere.remove();
  });

  // The empty case, which is the one that matters most: a brand-new text node
  // renders a placeholder rather than a body, and an entry point that hung off
  // the body would be missing from exactly the nodes with nothing in them yet.
  it('opens the editor on Enter for an empty text node too', async () => {
    _resetForTests();
    addNode('p', 's', {
      id: 'n1',
      type: 'text',
      position: { x: 0, y: 0 },
      data: {
        name: 'N',
        createdAt: 1,
        createdBy: 'u',
        locked: false,
        state: 'idle',
        attachments: [],
      },
    });
    mockUseCanvasSpace.mockReturnValue(
      mockSpace({
        nodes: [
          {
            id: 'n1',
            type: 'text',
            position: { x: 0, y: 0 },
            data: { kind: 'text', status: 'idle', name: 'N' },
          },
        ],
      }),
    );
    renderSpace();
    expect(screen.getByTestId('node-placeholder')).toBeInTheDocument();

    fireEvent.keyDown(document.querySelector('.react-flow__node') as HTMLElement, {
      key: 'Enter',
    });
    await waitFor(() =>
      expect(document.querySelector('.ProseMirror')).not.toBeNull(),
    );
  });

  // Viewer drag backstop (#1377). A read-only viewer must not be able to drag
  // nodes: ReactFlow gates dragging via `nodesDraggable`, and when false it
  // omits the `draggable` class from the node wrapper (the drag handler is
  // disabled too). The real security boundary is the collab server — a
  // read-only connection rejects the viewer's Yjs update — but gating the UI
  // here stops the confusing "move locally then snap back" once the server
  // rejects, and stops accidental edits.
  it('readOnly canvas renders nodes as non-draggable (ReactFlow omits the draggable class)', () => {
    mockUseCanvasSpace.mockReturnValue(
      mockSpace({
        nodes: [
          {
            id: 'n1',
            type: 'image',
            position: { x: 0, y: 0 },
            data: { kind: 'image', content: 'x.png', status: 'idle' },
          },
        ],
      }),
    );
    renderSpace(true);
    const node = document.querySelector('.react-flow__node');
    expect(node).not.toBeNull();
    expect(node?.className).not.toContain('draggable');
  });

  it('editor canvas renders nodes as draggable', () => {
    mockUseCanvasSpace.mockReturnValue(
      mockSpace({
        nodes: [
          {
            id: 'n1',
            type: 'image',
            position: { x: 0, y: 0 },
            data: { kind: 'image', content: 'x.png', status: 'idle' },
          },
        ],
      }),
    );
    renderSpace();
    const node = document.querySelector('.react-flow__node');
    expect(node).not.toBeNull();
    expect(node?.className).toContain('draggable');
  });

  // Connection rules in reference-pick mode (spec §9.1, user 2026-07-10): an
  // image node's input accepts only image / text sources, so while picking
  // references for an image node, an audio / video node must be dimmed +
  // non-pickable exactly like an already-wired node — not glowing as if it
  // were selectable and then dead-ending at execute time.
  it('pick mode on an i2i target dims type-incompatible sources (audio) and keeps image/text selectable', () => {
    mockUseCanvasSpace.mockReturnValue(
      mockSpace({
        nodes: [
          {
            id: 'target',
            type: 'image',
            position: { x: 0, y: 0 },
            // i2i uses the full source pool, so images stay selectable — this
            // isolates the canConnect (type) dimming from the mode scoping.
            data: { kind: 'image', status: 'idle', mode: 'i2i' },
          },
          {
            id: 'src-audio',
            type: 'audio',
            position: { x: 300, y: 0 },
            data: { kind: 'audio', content: 'a.mp3', status: 'idle' },
          },
          {
            id: 'src-text',
            type: 'text',
            position: { x: 600, y: 0 },
            data: { kind: 'text', status: 'idle' },
          },
          {
            id: 'src-image',
            type: 'image',
            position: { x: 900, y: 0 },
            data: { kind: 'image', content: 'x.png', status: 'idle' },
          },
        ],
      }),
    );
    renderSpace();
    // Enter pick mode directly — the overlay keys off pickSession alone, so
    // this asserts the overlay and nothing about how a panel opens. (The old
    // reason given here, that a real panel would need a QueryClientProvider
    // this mount lacks, stopped being true when `renderSpace` started
    // providing one.)
    act(() => {
      useCanvasStore.getState().startReferencePick('target');
    });
    const cls = (id: string): string =>
      document.querySelector(`.react-flow__node[data-id="${id}"]`)?.className ??
      '';
    expect(cls('target')).toContain('canvas-pick-dimmed');
    expect(cls('src-audio')).toContain('canvas-pick-dimmed');
    expect(cls('src-audio')).not.toContain('canvas-pick-selectable');
    expect(cls('src-text')).toContain('canvas-pick-selectable');
    expect(cls('src-image')).toContain('canvas-pick-selectable');
  });

  // The banner is the ONLY on-canvas instruction during a pick, so it has to
  // name the pick that is actually running (#1902 Gate 2): a first-frame pick
  // wearing the reference wording tells the user to do a different thing —
  // wire a source, keep picking until Exit — while the session takes one image
  // and ends.
  it('names the running pick in the banner, not the reference default', () => {
    mockUseCanvasSpace.mockReturnValue(
      mockSpace({
        nodes: [
          {
            id: 'target',
            type: 'video',
            position: { x: 0, y: 0 },
            data: { kind: 'video', status: 'idle', mode: 'i2v' },
          },
        ],
      }),
    );
    renderSpace();
    act(() => {
      useCanvasStore.getState().startFirstFramePick('target');
    });
    expect(
      screen.getByText('Pick an image on the canvas to be the first frame'),
    ).toBeInTheDocument();
    expect(
      screen.queryByText('Select a reference from the canvas'),
    ).toBeNull();
  });

  // Keyboard handoff (#1902 Gate 2): Exit unmounts the banner, so focus has to
  // be handed back to the tool that started the pick. The lookup named the
  // IMAGE toolbar's ids only, so a pick started from the VIDEO panel found
  // nothing and fell through to the orphan catch-all — which lands on the
  // canvas container, not back in the panel the user was working in.
  it('hands focus back to the video panel’s tool when a video pick exits', () => {
    mockUseCanvasSpace.mockReturnValue(
      mockSpace({
        nodes: [
          {
            id: 'target',
            type: 'video',
            position: { x: 0, y: 0 },
            data: { kind: 'video', status: 'idle', mode: 'i2v' },
          },
        ],
      }),
    );
    renderSpace();
    // Stand in for the panel's tool row: what is under test is the handoff,
    // not the panel, and standing the button in keeps a whole panel's worth of
    // catalog and Yjs wiring out of the assertion. The id is the one the video
    // toolbar renders.
    const tool = document.createElement('button');
    tool.setAttribute('data-testid', 'generate-video-tool-first-frame');
    document.body.appendChild(tool);
    act(() => {
      useCanvasStore.getState().startFirstFramePick('target');
    });
    fireEvent.click(screen.getByTestId('reference-pick-exit'));
    expect(document.activeElement).toBe(tool);
    tool.remove();
  });

  it('hands focus back to the end-frame tool the toolbar actually renders', () => {
    // The same handoff for the second slot (#1904), and the reason it is a
    // case of its own: the id the toolbar renders and the id this lookup
    // searches for are read here from the SAME registry entry the toolbar
    // reads. Written as two literals they agreed by luck, and a typo in
    // either one was invisible — every canvas suite stayed green while a
    // keyboard user pressing Exit landed on the canvas container instead of
    // back in the panel, which is the #1902 regression again.
    mockUseCanvasSpace.mockReturnValue(
      mockSpace({
        nodes: [
          {
            id: 'target',
            type: 'video',
            position: { x: 0, y: 0 },
            data: { kind: 'video', status: 'idle', mode: 'first_last' },
          },
        ],
      }),
    );
    renderSpace();
    const tool = document.createElement('button');
    tool.setAttribute('data-testid', VIDEO_SLOTS.endFrame.testId);
    document.body.appendChild(tool);
    act(() => {
      useCanvasStore.getState().startEndFramePick('target');
    });
    fireEvent.click(screen.getByTestId('reference-pick-exit'));
    expect(document.activeElement).toBe(tool);
    tool.remove();
  });

  it('pick mode on a t2i target keeps IMAGE sources selectable — same as i2i (#1797)', () => {
    // Reference pick is ONE flow for both modes (user 2026-07-19): t2i no longer
    // dims / blocks image sources during pick — you can connect an image node in
    // t2i exactly like i2i (drag-connect already allowed it). The image reference
    // then shows GREYED in the rail + is inert (t2i ignores source images), but
    // the PICK itself is unrestricted. Only the type-incompatible audio is dimmed
    // here (canConnect), not the image.
    mockUseCanvasSpace.mockReturnValue(
      mockSpace({
        nodes: [
          {
            id: 'target',
            type: 'image',
            position: { x: 0, y: 0 },
            data: { kind: 'image', status: 'idle', mode: 't2i' },
          },
          {
            id: 'src-audio',
            type: 'audio',
            position: { x: 300, y: 0 },
            data: { kind: 'audio', content: 'a.mp3', status: 'idle' },
          },
          {
            id: 'src-text',
            type: 'text',
            position: { x: 600, y: 0 },
            data: { kind: 'text', status: 'idle' },
          },
          {
            id: 'src-image',
            type: 'image',
            position: { x: 900, y: 0 },
            data: { kind: 'image', content: 'x.png', status: 'idle' },
          },
        ],
      }),
    );
    renderSpace();
    act(() => {
      useCanvasStore.getState().startReferencePick('target');
    });
    const cls = (id: string): string =>
      document.querySelector(`.react-flow__node[data-id="${id}"]`)?.className ??
      '';
    expect(cls('src-audio')).toContain('canvas-pick-dimmed');
    // #1797: an image source is now SELECTABLE in t2i (unified with i2i) — the
    // pick no longer scopes by mode; the t2i inertness lives in the rail dim + @
    // exclusion + payload, not the pick gate.
    expect(cls('src-image')).toContain('canvas-pick-selectable');
    expect(cls('src-image')).not.toContain('canvas-pick-dimmed');
    // Text still feeds the prompt in t2i → selectable.
    expect(cls('src-text')).toContain('canvas-pick-selectable');
  });

  it('clicking an image source in t2i WIRES the reference edge — same as i2i (#1797)', () => {
    // #1797: t2i no longer blocks an image pick. Clicking an image source in t2i
    // wires the reference edge just like i2i (the reference is then greyed +
    // inert in the rail, but connecting it is unrestricted). The pick stays open
    // (continuous select).
    const warnSpy = vi.spyOn(toast, 'warning').mockReturnValue('t');
    const addEdgeSpy = vi.spyOn(canvasSpace, 'addEdge');
    mockUseCanvasSpace.mockReturnValue(
      mockSpace({
        nodes: [
          {
            id: 'target',
            type: 'image',
            position: { x: 0, y: 0 },
            data: { kind: 'image', status: 'idle', mode: 't2i' },
          },
          {
            id: 'src-image',
            type: 'image',
            position: { x: 900, y: 0 },
            data: { kind: 'image', content: 'x.png', status: 'idle' },
          },
        ],
      }),
    );
    renderSpace();
    act(() => {
      useCanvasStore.getState().startReferencePick('target');
    });
    act(() => {
      fireEvent.click(
        document.querySelector('.react-flow__node[data-id="src-image"]')!,
      );
    });
    // No warning toast (a successful pick, not a blocked one).
    expect(warnSpy).not.toHaveBeenCalled();
    // The image reference edge IS wired in t2i now (#1797).
    expect(addEdgeSpy).toHaveBeenCalledWith(
      'p',
      's',
      expect.objectContaining({ source: 'src-image', target: 'target' }),
    );
    // The pick stays open (continuous select).
    expect(useCanvasStore.getState().pickSession?.nodeId).toBe('target');
    warnSpy.mockRestore();
    addEdgeSpy.mockRestore();
  });

  it('a drag GESTURE on a LOCKED node warns; a click (no movement) stays silent (#1788 batch-5, user 2026-07-18)', () => {
    // A locked node is draggable:false, so ReactFlow fires NO drag events — the
    // canvas detects the drag GESTURE itself (pointerdown on a frozen node +
    // movement past a threshold) and warns. A click (down/up, no movement) must
    // NOT warn, so merely selecting a locked node doesn't toast.
    const warnSpy = vi.spyOn(toast, 'warning').mockReturnValue('t');
    mockUseCanvasSpace.mockReturnValue(
      mockSpace({
        nodes: [
          {
            id: 'locked',
            type: 'image',
            position: { x: 0, y: 0 },
            data: { kind: 'image', status: 'idle', locked: true },
          },
        ],
      }),
    );
    renderSpace();
    const el = document.querySelector('.react-flow__node[data-id="locked"]')!;
    // MouseEvent with the pointer type name: jsdom-safe, carries clientX/Y, and
    // fires the handler (listeners key on the type string, not the class).
    const ev = (type: string, x: number, y: number, buttons = 0): MouseEvent =>
      new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, buttons });
    // Click (no movement) → silent.
    act(() => {
      el.dispatchEvent(ev('pointerdown', 10, 10, 1));
      window.dispatchEvent(ev('pointerup', 10, 10));
    });
    expect(warnSpy).not.toHaveBeenCalled();
    // Drag gesture (button held, movement past the threshold) → warn once.
    act(() => {
      el.dispatchEvent(ev('pointerdown', 10, 10, 1));
      window.dispatchEvent(ev('pointermove', 40, 40, 1));
    });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it('a buttonless move after a stale arm does NOT warn — a hover cannot be a drag (#1788 round-2 F2)', () => {
    // If a press ends WITHOUT delivering pointerup/pointercancel to the page (a
    // mouse released outside the window — a non-draggable node takes no pointer
    // capture), the armed origin would linger. The root safeguard: a later move
    // with no button held (a hover) disarms instead of firing a spurious toast.
    const warnSpy = vi.spyOn(toast, 'warning').mockReturnValue('t');
    mockUseCanvasSpace.mockReturnValue(
      mockSpace({
        nodes: [
          {
            id: 'locked',
            type: 'image',
            position: { x: 0, y: 0 },
            data: { kind: 'image', status: 'idle', locked: true },
          },
        ],
      }),
    );
    renderSpace();
    const el = document.querySelector('.react-flow__node[data-id="locked"]')!;
    const ev = (type: string, x: number, y: number, buttons = 0): MouseEvent =>
      new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, buttons });
    // Arm (button held), then NO pointerup/pointercancel reaches the page.
    act(() => {
      el.dispatchEvent(ev('pointerdown', 10, 10, 1));
    });
    // A later hover (no button) far past the threshold must NOT warn.
    act(() => {
      window.dispatchEvent(ev('pointermove', 200, 200, 0));
    });
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('a locked drag interrupted by pointercancel does NOT leak a spurious warn on a later move (#1788 adversarial C3)', () => {
    // The Pointer Events spec ends an interrupted pointer with pointercancel
    // (touch pan / palm-rejection / a native drag off the node) — NOT pointerup.
    // If the armed origin is not cleared on cancel, a later unrelated move that
    // happens to cross the threshold from the stale origin fires a wrong toast.
    const warnSpy = vi.spyOn(toast, 'warning').mockReturnValue('t');
    mockUseCanvasSpace.mockReturnValue(
      mockSpace({
        nodes: [
          {
            id: 'locked',
            type: 'image',
            position: { x: 0, y: 0 },
            data: { kind: 'image', status: 'idle', locked: true },
          },
        ],
      }),
    );
    renderSpace();
    const el = document.querySelector('.react-flow__node[data-id="locked"]')!;
    const ev = (type: string, x: number, y: number, buttons = 0): MouseEvent =>
      new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, buttons });
    act(() => {
      el.dispatchEvent(ev('pointerdown', 10, 10, 1));
      window.dispatchEvent(ev('pointercancel', 10, 10));
    });
    // A later move far past the threshold, with a button still notionally held
    // (buttons=1) to ISOLATE pointercancel from the no-button safeguard, must
    // NOT re-fire the warn — pointercancel already disarmed the origin.
    act(() => {
      window.dispatchEvent(ev('pointermove', 200, 200, 1));
    });
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('a connect-drag from a LOCKED node handle does NOT warn — connecting FROM a locked node is allowed (#1788 adversarial U3)', () => {
    // Locking freezes mutations OF the node; connecting FROM it mutates the
    // TARGET's reference pool, which the lock does not gate (onConnect has no
    // lock term). So a press that starts on the connection handle is a connect
    // gesture, not a move gesture — it must not trip the lock-drag warning.
    const warnSpy = vi.spyOn(toast, 'warning').mockReturnValue('t');
    mockUseCanvasSpace.mockReturnValue(
      mockSpace({
        nodes: [
          {
            id: 'locked',
            type: 'image',
            position: { x: 0, y: 0 },
            data: { kind: 'image', status: 'idle', locked: true },
          },
        ],
      }),
    );
    renderSpace();
    const el = document.querySelector('.react-flow__node[data-id="locked"]')!;
    const handle = el.querySelector('.react-flow__handle');
    expect(handle).not.toBeNull();
    const ev = (type: string, x: number, y: number, buttons = 0): MouseEvent =>
      new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, buttons });
    act(() => {
      handle!.dispatchEvent(ev('pointerdown', 10, 10, 1));
      window.dispatchEvent(ev('pointermove', 40, 40, 1));
    });
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  // Style pick (#1664): a style reference is a URL COPY of an image node's
  // asset — so while style-picking only NON-EMPTY image nodes glow. Non-image
  // nodes, empty images (nothing to copy), and the target itself are dimmed.
  it('style pick keeps only non-empty image sources selectable; dims non-image + empty + target', () => {
    mockUseCanvasSpace.mockReturnValue(
      mockSpace({
        nodes: [
          {
            id: 'target',
            type: 'image',
            position: { x: 0, y: 0 },
            data: { kind: 'image', status: 'idle' },
          },
          {
            id: 'src-empty',
            type: 'image',
            position: { x: 300, y: 0 },
            data: { kind: 'image', status: 'idle' }, // no content — nothing to copy
          },
          {
            id: 'src-text',
            type: 'text',
            position: { x: 600, y: 0 },
            data: { kind: 'text', status: 'idle' },
          },
          {
            id: 'src-image',
            type: 'image',
            position: { x: 900, y: 0 },
            data: { kind: 'image', content: 'x.png', status: 'idle' },
          },
        ],
      }),
    );
    renderSpace();
    act(() => {
      useCanvasStore.getState().startStylePick('target');
    });
    const cls = (id: string): string =>
      document.querySelector(`.react-flow__node[data-id="${id}"]`)?.className ??
      '';
    expect(cls('target')).toContain('canvas-pick-dimmed');
    expect(cls('src-empty')).toContain('canvas-pick-dimmed'); // empty image
    expect(cls('src-text')).toContain('canvas-pick-dimmed'); // not an image
    expect(cls('src-text')).not.toContain('canvas-pick-selectable');
    expect(cls('src-image')).toContain('canvas-pick-selectable'); // has an asset
  });

  // #1904 acceptance 3: an end-frame pick takes an image and nothing else.
  // The click handler dispatches on the pick's purpose and the branches carry
  // no exhaustive check, so a slot with no branch of its own falls through to
  // the reference fallthrough at the end — which wires an EDGE. That failure
  // is silent: it compiles, and the user sees a connection appear instead of
  // the slot filling.
  it('end-frame pick: clicking a non-image node fills nothing and wires no edge', () => {
    const setSlot = vi
      .spyOn(canvasSpace, 'setNodeSlotValue')
      .mockImplementation(() => {});
    const addEdgeSpy = vi.spyOn(canvasSpace, 'addEdge');
    mockUseCanvasSpace.mockReturnValue(
      mockSpace({
        nodes: [
          {
            id: 'target',
            type: 'video',
            position: { x: 0, y: 0 },
            data: { kind: 'video', status: 'idle', mode: 'first_last' },
          },
          {
            id: 'src-audio',
            type: 'audio',
            position: { x: 600, y: 0 },
            data: { kind: 'audio', content: 'https://cdn/a.m4a', status: 'idle' },
          },
        ],
      }),
    );
    renderSpace();
    act(() => {
      useCanvasStore.getState().startEndFramePick('target');
    });
    act(() => {
      document
        .querySelector('.react-flow__node[data-id="src-audio"]')
        ?.dispatchEvent(
          new MouseEvent('click', { bubbles: true, cancelable: true }),
        );
    });
    expect(setSlot).not.toHaveBeenCalled();
    expect(addEdgeSpy).not.toHaveBeenCalled();
    // Still picking: the click was refused, not consumed.
    expect(useCanvasStore.getState().pickSession).toEqual({
      nodeId: 'target',
      purpose: 'endFrame',
    });
    setSlot.mockRestore();
    addEdgeSpy.mockRestore();
    act(() => {
      useCanvasStore.setState({ pickSession: null });
    });
  });

  it('end-frame pick: clicking an image fills the end-frame field, not the first', () => {
    const setSlot = vi
      .spyOn(canvasSpace, 'setNodeSlotValue')
      .mockImplementation(() => {});
    mockUseCanvasSpace.mockReturnValue(
      mockSpace({
        nodes: [
          {
            id: 'target',
            type: 'video',
            position: { x: 0, y: 0 },
            data: { kind: 'video', status: 'idle', mode: 'first_last' },
          },
          {
            id: 'src-image',
            type: 'image',
            position: { x: 600, y: 0 },
            data: { kind: 'image', content: 'https://cdn/l.png', status: 'idle' },
          },
        ],
      }),
    );
    renderSpace();
    act(() => {
      useCanvasStore.getState().startEndFramePick('target');
    });
    act(() => {
      document
        .querySelector('.react-flow__node[data-id="src-image"]')
        ?.dispatchEvent(
          new MouseEvent('click', { bubbles: true, cancelable: true }),
        );
    });
    // Every field the slot owns in one call — the end frame owns just the
    // one, and no poster key rides along for a slot that paints its own pick.
    expect(setSlot).toHaveBeenCalledWith(
      'p',
      's',
      'target',
      'endFrameUrl',
      'https://cdn/l.png',
    );
    // One slot, one pick — the session completes on selection.
    expect(useCanvasStore.getState().pickSession).toBeNull();
    setSlot.mockRestore();
  });

  // #1918 acceptance 3: the driving-video slot is the first that takes
  // something other than an image, so it is the first real exercise of the
  // registry's `accepts` field — until now every slot answered "image" and a
  // hardcoded check would have looked correct.
  it('driving-video pick: clicking an image fills nothing and wires no edge', () => {
    const setSlot = vi
      .spyOn(canvasSpace, 'setNodeSlotValue')
      .mockImplementation(() => {});
    const addEdgeSpy = vi.spyOn(canvasSpace, 'addEdge');
    mockUseCanvasSpace.mockReturnValue(
      mockSpace({
        nodes: [
          {
            id: 'target',
            type: 'video',
            position: { x: 0, y: 0 },
            data: { kind: 'video', status: 'idle', mode: 'animate' },
          },
          {
            id: 'src-image',
            type: 'image',
            position: { x: 600, y: 0 },
            data: { kind: 'image', content: 'https://cdn/i.png', status: 'idle' },
          },
        ],
      }),
    );
    renderSpace();
    act(() => {
      useCanvasStore.getState().startDrivingVideoPick('target');
    });
    act(() => {
      document
        .querySelector('.react-flow__node[data-id="src-image"]')
        ?.dispatchEvent(
          new MouseEvent('click', { bubbles: true, cancelable: true }),
        );
    });
    expect(setSlot).not.toHaveBeenCalled();
    expect(addEdgeSpy).not.toHaveBeenCalled();
    expect(useCanvasStore.getState().pickSession).toEqual({
      nodeId: 'target',
      purpose: 'drivingVideo',
    });
    setSlot.mockRestore();
    addEdgeSpy.mockRestore();
    act(() => {
      useCanvasStore.setState({ pickSession: null });
    });
  });

  it('driving-video pick: clicking a video copies its asset AND its poster', () => {
    const setSlot = vi
      .spyOn(canvasSpace, 'setNodeSlotValue')
      .mockImplementation(() => {});
    mockUseCanvasSpace.mockReturnValue(
      mockSpace({
        nodes: [
          {
            id: 'target',
            type: 'video',
            position: { x: 0, y: 0 },
            data: { kind: 'video', status: 'idle', mode: 'animate' },
          },
          {
            id: 'src-video',
            type: 'video',
            position: { x: 600, y: 0 },
            data: {
              kind: 'video',
              content: 'https://cdn/driving.mp4',
              coverUrl: 'https://cdn/driving-cover.png',
              status: 'idle',
            },
          },
        ],
      }),
    );
    renderSpace();
    act(() => {
      useCanvasStore.getState().startDrivingVideoPick('target');
    });
    act(() => {
      document
        .querySelector('.react-flow__node[data-id="src-video"]')
        ?.dispatchEvent(
          new MouseEvent('click', { bubbles: true, cancelable: true }),
        );
    });
    // Both fields in ONE call: written separately, a collaborator could see
    // the new video wearing the previous pick's poster.
    expect(setSlot).toHaveBeenCalledWith('p', 's', 'target', 'drivingVideo', {
      url: 'https://cdn/driving.mp4',
      cover: 'https://cdn/driving-cover.png',
    });
    expect(useCanvasStore.getState().pickSession).toBeNull();
    setSlot.mockRestore();
  });

  it('character-image pick: clicking a video fills nothing and wires no edge', () => {
    const setSlot = vi
      .spyOn(canvasSpace, 'setNodeSlotValue')
      .mockImplementation(() => {});
    const addEdgeSpy = vi.spyOn(canvasSpace, 'addEdge');
    mockUseCanvasSpace.mockReturnValue(
      mockSpace({
        nodes: [
          {
            id: 'target',
            type: 'video',
            position: { x: 0, y: 0 },
            data: { kind: 'video', status: 'idle', mode: 'animate' },
          },
          {
            id: 'src-video',
            type: 'video',
            position: { x: 600, y: 0 },
            data: {
              kind: 'video',
              content: 'https://cdn/v.mp4',
              status: 'idle',
            },
          },
        ],
      }),
    );
    renderSpace();
    act(() => {
      useCanvasStore.getState().startCharacterImagePick('target');
    });
    act(() => {
      document
        .querySelector('.react-flow__node[data-id="src-video"]')
        ?.dispatchEvent(
          new MouseEvent('click', { bubbles: true, cancelable: true }),
        );
    });
    expect(setSlot).not.toHaveBeenCalled();
    expect(addEdgeSpy).not.toHaveBeenCalled();
    setSlot.mockRestore();
    addEdgeSpy.mockRestore();
    act(() => {
      useCanvasStore.setState({ pickSession: null });
    });
  });

  // #1904 acceptance 4: the visual half of the same rule. The candidate
  // highlighting is a list of purposes too, so a slot missing from it falls
  // through to the reference painting and everything looks pickable.
  it('end-frame pick marks only image nodes as candidates', () => {
    mockUseCanvasSpace.mockReturnValue(
      mockSpace({
        nodes: [
          {
            id: 'target',
            type: 'video',
            position: { x: 0, y: 0 },
            data: { kind: 'video', status: 'idle', mode: 'first_last' },
          },
          {
            id: 'src-empty',
            type: 'image',
            position: { x: 300, y: 0 },
            data: { kind: 'image', status: 'idle' },
          },
          {
            id: 'src-text',
            type: 'text',
            position: { x: 600, y: 0 },
            data: { kind: 'text', status: 'idle' },
          },
          {
            id: 'src-audio',
            type: 'audio',
            position: { x: 900, y: 0 },
            data: { kind: 'audio', content: 'https://cdn/a.m4a', status: 'idle' },
          },
          {
            id: 'src-image',
            type: 'image',
            position: { x: 1200, y: 0 },
            data: { kind: 'image', content: 'https://cdn/l.png', status: 'idle' },
          },
        ],
      }),
    );
    renderSpace();
    act(() => {
      useCanvasStore.getState().startEndFramePick('target');
    });
    const cls = (id: string): string =>
      document.querySelector(`.react-flow__node[data-id="${id}"]`)?.className ??
      '';
    expect(cls('target')).toContain('canvas-pick-dimmed');
    expect(cls('src-empty')).toContain('canvas-pick-dimmed');
    expect(cls('src-text')).toContain('canvas-pick-dimmed');
    expect(cls('src-audio')).toContain('canvas-pick-dimmed');
    expect(cls('src-image')).toContain('canvas-pick-selectable');
    expect(cls('src-image')).not.toContain('canvas-pick-dimmed');
    act(() => {
      useCanvasStore.setState({ pickSession: null });
    });
  });

  it('names the end-frame pick in the banner, not the first-frame one', () => {
    mockUseCanvasSpace.mockReturnValue(
      mockSpace({
        nodes: [
          {
            id: 'target',
            type: 'video',
            position: { x: 0, y: 0 },
            data: { kind: 'video', status: 'idle', mode: 'first_last' },
          },
        ],
      }),
    );
    renderSpace();
    act(() => {
      useCanvasStore.getState().startEndFramePick('target');
    });
    expect(
      screen.getByText('Pick an image on the canvas to be the end frame'),
    ).toBeInTheDocument();
    expect(
      screen.queryByText('Pick an image on the canvas to be the first frame'),
    ).toBeNull();
    act(() => {
      useCanvasStore.setState({ pickSession: null });
    });
  });

  // Unified pick-session Esc (user 2026-07-17 #8): EVERY pick purpose exits on
  // Escape with the same guard set — reference and style had no listener at
  // all (only focus did), so their banners showed Exit but Esc was dead.
  it('Escape exits a REFERENCE pick session (was silently dead — #8)', () => {
    mockUseCanvasSpace.mockReturnValue(
      mockSpace({
        nodes: [
          {
            id: 'target',
            type: 'image',
            position: { x: 0, y: 0 },
            data: { kind: 'image', status: 'idle' },
          },
        ],
      }),
    );
    renderSpace();
    act(() => {
      useCanvasStore.getState().startReferencePick('target');
    });
    act(() => {
      fireEvent.keyDown(keyTarget(), { key: 'Escape' });
    });
    expect(useCanvasStore.getState().pickSession).toBeNull();
  });

  it('Escape exits a STYLE pick session with the shared guards (#8)', () => {
    mockUseCanvasSpace.mockReturnValue(
      mockSpace({
        nodes: [
          {
            id: 'target',
            type: 'image',
            position: { x: 0, y: 0 },
            data: { kind: 'image', status: 'idle' },
          },
        ],
      }),
    );
    renderSpace();
    act(() => {
      useCanvasStore.getState().startStylePick('target');
    });
    // Guard set (mirrors the focus handler): a consumed Esc never exits.
    act(() => {
      const prevented = new KeyboardEvent('keydown', {
        key: 'Escape',
        cancelable: true,
        bubbles: true,
      });
      prevented.preventDefault();
      window.dispatchEvent(prevented);
    });
    expect(useCanvasStore.getState().pickSession).not.toBeNull();
    // An auto-repeat Esc is ignored too.
    act(() => {
      fireEvent.keyDown(keyTarget(), { key: 'Escape', repeat: true });
    });
    expect(useCanvasStore.getState().pickSession).not.toBeNull();
    act(() => {
      fireEvent.keyDown(keyTarget(), { key: 'Escape' });
    });
    expect(useCanvasStore.getState().pickSession).toBeNull();
  });

  it('an Esc consumed while a tooltip is open stays consumed — layered peel (adversarial r2)', () => {
    // Round-2 reversal: a [role=tooltip]-presence bypass misattributed the
    // preventDefault of OTHER consumers (rename editors, the @-suggestion)
    // whenever a tooltip happened to be open or fading, double-acting on one
    // press. The codebase-wide protocol stands: every consumer that
    // preventDefaults owns the press (NodeHeader round-12) — an open tooltip
    // costs one Esc (it visibly dismisses), the next press exits.
    mockUseCanvasSpace.mockReturnValue(
      mockSpace({
        nodes: [
          {
            id: 'target',
            type: 'image',
            position: { x: 0, y: 0 },
            data: { kind: 'image', status: 'idle' },
          },
        ],
      }),
    );
    renderSpace();
    act(() => {
      useCanvasStore.getState().startReferencePick('target');
    });
    const tip = document.createElement('div');
    tip.setAttribute('role', 'tooltip');
    document.body.appendChild(tip);
    try {
      act(() => {
        const prevented = new KeyboardEvent('keydown', {
          key: 'Escape',
          cancelable: true,
          bubbles: true,
        });
        prevented.preventDefault();
        window.dispatchEvent(prevented);
      });
      expect(useCanvasStore.getState().pickSession).not.toBeNull();
      // The next, unconsumed press exits.
      act(() => {
        fireEvent.keyDown(keyTarget(), { key: 'Escape' });
      });
      expect(useCanvasStore.getState().pickSession).toBeNull();
    } finally {
      tip.remove();
    }
  });

  it('Escape yields to an open alertdialog (adversarial r2 — role was missing from the yield)', () => {
    mockUseCanvasSpace.mockReturnValue(
      mockSpace({
        nodes: [
          {
            id: 'target',
            type: 'image',
            position: { x: 0, y: 0 },
            data: { kind: 'image', status: 'idle' },
          },
        ],
      }),
    );
    renderSpace();
    act(() => {
      useCanvasStore.getState().startReferencePick('target');
    });
    const alert = document.createElement('div');
    alert.setAttribute('role', 'alertdialog');
    const btn = document.createElement('button');
    alert.appendChild(btn);
    document.body.appendChild(alert);
    btn.focus();
    try {
      act(() => {
        fireEvent.keyDown(keyTarget(), { key: 'Escape' });
      });
      expect(useCanvasStore.getState().pickSession).not.toBeNull();
    } finally {
      alert.remove();
    }
  });

  // Style pick completion (#1664): clicking a non-empty image COPIES its asset
  // URL onto the target (no upstream relationship) and AUTO-EXITS the session
  // (one slot, one pick — unlike the continuous reference pick).
  it('style pick click copies the image URL and auto-exits the session', async () => {
    const setStyle = vi
      .spyOn(canvasSpace, 'setNodeStyleImage')
      .mockImplementation(() => {});
    mockUseCanvasSpace.mockReturnValue(
      mockSpace({
        nodes: [
          {
            id: 'target',
            type: 'image',
            position: { x: 0, y: 0 },
            data: { kind: 'image', status: 'idle' },
          },
          {
            id: 'src-image',
            type: 'image',
            position: { x: 600, y: 0 },
            data: { kind: 'image', content: 'https://cdn/x.png', status: 'idle' },
          },
        ],
      }),
    );
    renderSpace();
    act(() => {
      useCanvasStore.getState().startStylePick('target');
    });
    const candidate = document.querySelector(
      '.react-flow__node[data-id="src-image"]',
    );
    expect(candidate).not.toBeNull();
    act(() => {
      candidate?.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      );
    });
    await waitFor(() =>
      expect(setStyle).toHaveBeenCalledWith('p', 's', 'target', 'https://cdn/x.png'),
    );
    // One slot — the session ends on selection.
    expect(useCanvasStore.getState().pickSession).toBeNull();
    setStyle.mockRestore();
  });

  it('style pick click on an EMPTY image is a no-op (nothing to copy; stays picking)', () => {
    const setStyle = vi
      .spyOn(canvasSpace, 'setNodeStyleImage')
      .mockImplementation(() => {});
    mockUseCanvasSpace.mockReturnValue(
      mockSpace({
        nodes: [
          {
            id: 'target',
            type: 'image',
            position: { x: 0, y: 0 },
            data: { kind: 'image', status: 'idle' },
          },
          {
            id: 'src-empty',
            type: 'image',
            position: { x: 600, y: 0 },
            data: { kind: 'image', status: 'idle' },
          },
        ],
      }),
    );
    renderSpace();
    act(() => {
      useCanvasStore.getState().startStylePick('target');
    });
    const candidate = document.querySelector(
      '.react-flow__node[data-id="src-empty"]',
    );
    act(() => {
      candidate?.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      );
    });
    expect(setStyle).not.toHaveBeenCalled();
    expect(useCanvasStore.getState().pickSession).toEqual({
      nodeId: 'target',
      purpose: 'style',
    });
    setStyle.mockRestore();
    act(() => {
      useCanvasStore.setState({ pickSession: null });
    });
  });

  // The pick banner explains the active purpose: style picks read differently
  // from reference picks so the user knows what a click will wire (#1664).
  it('shows the style-pick banner text during a style pick', () => {
    mockUseCanvasSpace.mockReturnValue(
      mockSpace({
        nodes: [
          {
            id: 'target',
            type: 'image',
            position: { x: 0, y: 0 },
            data: { kind: 'image', status: 'idle' },
          },
        ],
      }),
    );
    renderSpace();
    act(() => {
      useCanvasStore.getState().startStylePick('target');
    });
    // en fixture: "Select a style reference from the canvas".
    expect(screen.getByTestId('reference-pick-banner').textContent).toContain(
      'style reference',
    );
    act(() => {
      useCanvasStore.setState({ pickSession: null });
    });
  });

  // Pick-mode pane-click guard (spec §9.2, user-ratified): while picking
  // references across a large canvas a stray click on empty space is a natural
  // misclick — it must NOT close the panel + abort the pick session (item 7:
  // Exit is the only way out). Off pick mode, the pane click still closes an
  // open panel (item 6b).
  it('pane click during reference-pick keeps the panel + pick session alive', () => {
    // The panel node must EXIST — the container's node-gone guard closes the
    // panel for a vanished node, which would mask what this test pins.
    mockUseCanvasSpace.mockReturnValue(
      mockSpace({
        nodes: [
          {
            id: 'target',
            type: 'image',
            position: { x: 0, y: 0 },
            data: { kind: 'image', status: 'idle', mode: 'i2i' },
          },
        ],
      }),
    );
    // The open panel renders the models useQuery — needs a QueryClient.
    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <CanvasSpace projectId='p' spaceId='s' />
      </QueryClientProvider>,
    );
    act(() => {
      useCanvasStore.setState({
        panelHostId: 'target', panelKind: 'generate',
        pickSession: { nodeId: 'target', purpose: 'reference' },
      });
    });
    const pane = document.querySelector('.react-flow__pane');
    expect(pane).not.toBeNull();
    // With selectionOnDrag (our Figma-like left-drag marquee) ReactFlow routes
    // pane clicks through pointerdown→pointerup, not the click event.
    clickPane(pane as Element);
    expect(useCanvasStore.getState().panelHostId).toBe('target');
    expect(useCanvasStore.getState().pickSession?.nodeId).toBe('target');
    // The banner is neutral card chrome (user 2026-07-14, reversing the
    // batch-2 item-11 violet tint) — the violet pick glow on candidate nodes
    // stays the mode indicator.
    const banner = screen.getByTestId('reference-pick-banner');
    expect(banner.className).toContain('bg-card');
    expect(banner.className).toContain('border-border');
    expect(banner.style.backgroundColor).toBe('');
  });

  it('pane click with the panel open but NOT picking closes the panel (item 6b)', () => {
    // The panel node must EXIST (otherwise the container's node-gone guard
    // closes the panel by itself and this test would pass without exercising
    // the pane click at all).
    mockUseCanvasSpace.mockReturnValue(
      mockSpace({
        nodes: [
          {
            id: 'target',
            type: 'image',
            position: { x: 0, y: 0 },
            data: { kind: 'image', status: 'idle' },
          },
        ],
      }),
    );
    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <CanvasSpace projectId='p' spaceId='s' />
      </QueryClientProvider>,
    );
    act(() => {
      useCanvasStore.setState({
        panelHostId: 'target', panelKind: 'generate',
        pickSession: null,
      });
    });
    const pane = document.querySelector('.react-flow__pane');
    expect(pane).not.toBeNull();
    clickPane(pane as Element);
    expect(useCanvasStore.getState().panelHostId).toBeNull();
  });

  // Selection-driven panel lifecycle (user bug report 2026-07-11): the panel
  // binds to its host's SELECTION — any path that moves selection away from
  // the host must close it. The old design enumerated close triggers per
  // event handler and missed the programmatic-selection paths below.
  it('closes the panel when a library-menu node creation moves selection away (repro)', async () => {
    const target = {
      id: 'target',
      type: 'image',
      position: { x: 0, y: 0 },
      data: { kind: 'image', status: 'idle' },
    } as const;
    mockUseCanvasSpace.mockReturnValue(mockSpace({ nodes: [target] }));
    const addNode = vi
      .spyOn(canvasSpace, 'addNode')
      .mockImplementation(() => undefined);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { rerender } = render(
      <QueryClientProvider client={client}>
        <CanvasSpace projectId='p' spaceId='s' />
      </QueryClientProvider>,
    );
    act(() => {
      useCanvasStore.setState({
        panelHostId: 'target', panelKind: 'generate',
        pickSession: null,
      });
    });
    // The panel-open effect selects the host.
    await waitFor(() =>
      expect(
        document.querySelector('[data-id="target"]')?.className,
      ).toContain('selected'),
    );
    // Library menu → create-node mailbox → CanvasSpace writes the node to
    // Yjs and flags it for auto-selection once mirrored back.
    act(() => {
      useCanvasStore.getState().requestNodeCreate('image');
    });
    await waitFor(() => expect(addNode).toHaveBeenCalledTimes(1));
    // The written node (CanvasNodeFields) carries kind/status at runtime;
    // the static read shape (CanvasNodeView) just doesn't overlap — cast for
    // the mocked mirror round-trip.
    const created = addNode.mock
      .calls[0][2] as unknown as canvasSpace.CanvasNodeView;
    // The Yjs mirror hands the created node back → the auto-select effect
    // selects it (deselecting the host) → the panel must close.
    mockUseCanvasSpace.mockReturnValue(
      mockSpace({ nodes: [target, created] }),
    );
    rerender(
      <QueryClientProvider client={client}>
        <CanvasSpace projectId='p' spaceId='s' />
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(useCanvasStore.getState().panelHostId).toBeNull(),
    );
    addNode.mockRestore();
  });

  it('closes the panel when pasting a node moves selection away (repro)', async () => {
    const target = {
      id: 'target',
      type: 'image',
      position: { x: 0, y: 0 },
      data: { kind: 'image', status: 'idle' },
    } as const;
    mockUseCanvasSpace.mockReturnValue(mockSpace({ nodes: [target] }));
    const addNode = vi
      .spyOn(canvasSpace, 'addNode')
      .mockImplementation(() => undefined);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { rerender } = render(
      <QueryClientProvider client={client}>
        <CanvasSpace projectId='p' spaceId='s' />
      </QueryClientProvider>,
    );
    act(() => {
      useCanvasStore.setState({
        panelHostId: 'target', panelKind: 'generate',
        pickSession: null,
      });
    });
    await waitFor(() =>
      expect(
        document.querySelector('[data-id="target"]')?.className,
      ).toContain('selected'),
    );
    // Right-click paste on empty canvas → clone written to Yjs + flagged for
    // auto-selection on mirror-back (same mechanism as ⌘V).
    dispatchPaste(
      serializeNodes([
        {
          type: 'image',
          position: { x: 10, y: 20 },
          name: 'Pasted',
          content: 'a.png',
        },
      ]),
    );
    await waitFor(() => expect(addNode).toHaveBeenCalledTimes(1));
    const pasted = addNode.mock
      .calls[0][2] as unknown as canvasSpace.CanvasNodeView;
    mockUseCanvasSpace.mockReturnValue(mockSpace({ nodes: [target, pasted] }));
    rerender(
      <QueryClientProvider client={client}>
        <CanvasSpace projectId='p' spaceId='s' />
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(useCanvasStore.getState().panelHostId).toBeNull(),
    );
    addNode.mockRestore();
  });

  it('Exit from reference-pick keeps the panel open and restores host selection', async () => {
    // Pick clicks move selection to candidate nodes by design (exempt from the
    // selection rule); Exit must restore the host as the sole selection so the
    // panel⇄selection invariant re-establishes — otherwise the guard would
    // close the panel the moment the pick session ends.
    const target = {
      id: 'target',
      type: 'image',
      position: { x: 0, y: 0 },
      data: { kind: 'image', status: 'idle', mode: 'i2i' },
    } as const;
    const other = {
      id: 'other',
      type: 'image',
      position: { x: 200, y: 0 },
      data: { kind: 'image', status: 'idle' },
    } as const;
    mockUseCanvasSpace.mockReturnValue(mockSpace({ nodes: [target, other] }));
    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <CanvasSpace projectId='p' spaceId='s' />
      </QueryClientProvider>,
    );
    act(() => {
      useCanvasStore.setState({
        panelHostId: 'target', panelKind: 'generate',
        pickSession: { nodeId: 'target', purpose: 'reference' },
      });
    });
    act(() => {
      screen.getByTestId('reference-pick-exit').click();
    });
    expect(useCanvasStore.getState().panelHostId).toBe('target');
    expect(useCanvasStore.getState().pickSession).toBeNull();
    await waitFor(() =>
      expect(
        document.querySelector('[data-id="target"]')?.className,
      ).toContain('selected'),
    );
  });

  // Round-1 adversarial hole 1: a space-tab round-trip unmounts the canvas
  // while the panel id persists in the global store; on remount the one-shot
  // open effect used to fire against the reset-EMPTY buffer and never again,
  // leaving an open panel on an unselected host with the close guard
  // permanently disarmed. The binding machine must re-assert the selection
  // after the mirror lands — and the guard must be re-armed (pane click
  // closes again).
  it('re-establishes the binding after a canvas remount with a persisted panel', async () => {
    const target = {
      id: 'target',
      type: 'image',
      position: { x: 0, y: 0 },
      data: { kind: 'image', status: 'idle' },
    } as const;
    mockUseCanvasSpace.mockReturnValue(mockSpace({ nodes: [target] }));
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const view = render(
      <QueryClientProvider client={client}>
        <CanvasSpace projectId='p' spaceId='s' />
      </QueryClientProvider>,
    );
    act(() => {
      useCanvasStore.setState({
        panelHostId: 'target', panelKind: 'generate',
        pickSession: null,
      });
    });
    await waitFor(() =>
      expect(
        document.querySelector('[data-id="target"]')?.className,
      ).toContain('selected'),
    );
    // Space-tab switch away and back: unmount + fresh mount, store untouched.
    view.unmount();
    render(
      <QueryClientProvider client={client}>
        <CanvasSpace projectId='p' spaceId='s' />
      </QueryClientProvider>,
    );
    // The machine re-asserts the host selection once the mirror lands…
    await waitFor(() =>
      expect(
        document.querySelector('[data-id="target"]')?.className,
      ).toContain('selected'),
    );
    // …and the close guard is armed again: pane click closes the panel.
    const pane = document.querySelector('.react-flow__pane');
    clickPane(pane as Element);
    await waitFor(() =>
      expect(useCanvasStore.getState().panelHostId).toBeNull(),
    );
  });

  // Round-1 adversarial hole 2: during a pick the selection sits on a
  // candidate (host deselected, machine held). Re-choosing Generate on the
  // SAME host clears the pick (store semantics) but the host id never
  // changes — the machine must still re-assert the host selection.
  it('re-establishes the binding on a same-host reopen mid-pick', async () => {
    const target = {
      id: 'target',
      type: 'image',
      position: { x: 0, y: 0 },
      data: { kind: 'image', status: 'idle' },
    } as const;
    const other = {
      id: 'other',
      type: 'image',
      position: { x: 200, y: 0 },
      data: { kind: 'image', status: 'idle' },
    } as const;
    mockUseCanvasSpace.mockReturnValue(mockSpace({ nodes: [target, other] }));
    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <CanvasSpace projectId='p' spaceId='s' />
      </QueryClientProvider>,
    );
    act(() => {
      useCanvasStore.setState({
        panelHostId: 'target', panelKind: 'generate',
        pickSession: null,
      });
    });
    await waitFor(() =>
      expect(
        document.querySelector('[data-id="target"]')?.className,
      ).toContain('selected'),
    );
    // Enter pick; a pick click moves selection to the candidate by design —
    // simulate the selection move via the machine-visible path (ReactFlow's
    // native click-select), then reopen Generate on the SAME host.
    act(() => {
      useCanvasStore.setState({ pickSession: { nodeId: 'target', purpose: 'reference' } });
    });
    const otherEl = document.querySelector('[data-id="other"]');
    act(() => {
      otherEl?.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      );
    });
    // Reopen on the same host (context menu → Generate): clears the pick.
    act(() => {
      useCanvasStore.getState().openGeneratePanel('target', 'image');
    });
    expect(useCanvasStore.getState().pickSession).toBeNull();
    await waitFor(() =>
      expect(
        document.querySelector('[data-id="target"]')?.className,
      ).toContain('selected'),
    );
    expect(useCanvasStore.getState().panelHostId).toBe('target');
  });

  // Round-2 adversarial: opening the panel on an ALREADY-selected host used
  // to skip the sole-selection assert entirely — a co-selected node (or edge)
  // kept its Delete-key claim under the open panel. A multi-node paste
  // selects the whole pasted group (real path), so opening Generate on one of
  // them must deselect the rest.
  it('opening the panel on a co-selected host clears the co-selection', async () => {
    mockUseCanvasSpace.mockReturnValue(mockSpace({ nodes: [] }));
    const addNode = vi
      .spyOn(canvasSpace, 'addNode')
      .mockImplementation(() => undefined);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { rerender } = render(
      <QueryClientProvider client={client}>
        <CanvasSpace projectId='p' spaceId='s' />
      </QueryClientProvider>,
    );
    // Paste TWO nodes — both get auto-selected once mirrored back.
    dispatchPaste(
      serializeNodes([
        { type: 'image', position: { x: 0, y: 0 }, name: 'One', content: 'a.png' },
        { type: 'image', position: { x: 100, y: 0 }, name: 'Two', content: 'b.png' },
      ]),
    );
    await waitFor(() => expect(addNode).toHaveBeenCalledTimes(2));
    const one = addNode.mock
      .calls[0][2] as unknown as canvasSpace.CanvasNodeView;
    const two = addNode.mock
      .calls[1][2] as unknown as canvasSpace.CanvasNodeView;
    mockUseCanvasSpace.mockReturnValue(mockSpace({ nodes: [one, two] }));
    rerender(
      <QueryClientProvider client={client}>
        <CanvasSpace projectId='p' spaceId='s' />
      </QueryClientProvider>,
    );
    await waitFor(() => {
      expect(
        document.querySelector(`[data-id="${one.id}"]`)?.className,
      ).toContain('selected');
      expect(
        document.querySelector(`[data-id="${two.id}"]`)?.className,
      ).toContain('selected');
    });
    // Open Generate on node ONE (host already selected, node TWO co-selected).
    act(() => {
      useCanvasStore.setState({
        panelHostId: one.id, panelKind: 'generate',
        pickSession: null,
      });
    });
    await waitFor(() =>
      expect(
        document.querySelector(`[data-id="${two.id}"]`)?.className,
      ).not.toContain('selected'),
    );
    expect(
      document.querySelector(`[data-id="${one.id}"]`)?.className,
    ).toContain('selected');
    expect(useCanvasStore.getState().panelHostId).toBe(one.id);
    addNode.mockRestore();
  });

  // Round-1 adversarial: an idle pane click (nothing selected) must not
  // publish a fresh flowNodes identity — map-always-allocates would re-render
  // every node on every misclick (reference-stability discipline).
  it('idle pane click keeps the flowNodes buffer identity (no-op deselect)', async () => {
    mockUseCanvasSpace.mockReturnValue(
      mockSpace({
        nodes: [
          {
            id: 'n1',
            type: 'image',
            position: { x: 0, y: 0 },
            data: { kind: 'image', status: 'idle' },
          },
        ],
      }),
    );
    renderSpace();
    await waitFor(() =>
      expect(useCanvasGraphStore.getState().flowNodes).toHaveLength(1),
    );
    const before = useCanvasGraphStore.getState().flowNodes;
    const pane = document.querySelector('.react-flow__pane');
    clickPane(pane as Element);
    expect(useCanvasGraphStore.getState().flowNodes).toBe(before);
  });

  // Viewer gate (the canvas-internal backstop for the HIGH review finding):
  // a read-only canvas must drop a library create intent without ever
  // writing to Yjs. The `consumed` assertion proves the effect actually ran
  // and took the readOnly branch (not that it silently never fired).
  it('readOnly canvas drops a library create intent without writing to Yjs', async () => {
    mockUseCanvasSpace.mockReturnValue(mockSpace());
    const addNode = vi
      .spyOn(canvasSpace, 'addNode')
      .mockImplementation(() => undefined);
    useCanvasStore.getState().requestNodeCreate('image');

    renderSpace(true);

    await waitFor(() =>
      expect(useCanvasStore.getState().pendingNodeCreate).toBeNull(),
    );
    expect(addNode).not.toHaveBeenCalled();
    addNode.mockRestore();
  });

  it('editor canvas fulfils a library create intent (writes via addNode)', async () => {
    mockUseCanvasSpace.mockReturnValue(mockSpace());
    const addNode = vi
      .spyOn(canvasSpace, 'addNode')
      .mockImplementation(() => undefined);
    useCanvasStore.getState().requestNodeCreate('image');

    renderSpace();

    await waitFor(() => expect(addNode).toHaveBeenCalledTimes(1));
    expect(addNode.mock.calls[0][2].type).toBe('image');
    addNode.mockRestore();
  });

  it('paste plain text creates a text node carrying the pasted text', () => {
    mockUseCanvasSpace.mockReturnValue(mockSpace());
    const addNode = vi
      .spyOn(canvasSpace, 'addNode')
      .mockImplementation(() => undefined);
    renderSpace();

    dispatchPaste('hello from clipboard');

    expect(addNode).toHaveBeenCalledTimes(1);
    const node = addNode.mock.calls[0][2];
    expect(node.type).toBe('text');
    expect(node.data.content).toBe('hello from clipboard');
    addNode.mockRestore();
  });

  it('paste a marked node payload clones the node (offset +24), not a text node', () => {
    mockUseCanvasSpace.mockReturnValue(mockSpace());
    const addNode = vi
      .spyOn(canvasSpace, 'addNode')
      .mockImplementation(() => undefined);
    renderSpace();

    dispatchPaste(
      serializeNodes([
        { type: 'image', position: { x: 10, y: 20 }, name: 'Hero', content: 'a.png' },
      ]),
    );

    expect(addNode).toHaveBeenCalledTimes(1);
    const node = addNode.mock.calls[0][2];
    expect(node.type).toBe('image');
    expect(node.data.content).toBe('a.png');
    expect(node.position).toEqual({ x: 34, y: 44 });
    addNode.mockRestore();
  });

  it('readOnly canvas ignores paste (no Yjs write)', () => {
    mockUseCanvasSpace.mockReturnValue(mockSpace());
    const addNode = vi
      .spyOn(canvasSpace, 'addNode')
      .mockImplementation(() => undefined);
    renderSpace(true);

    dispatchPaste('text while read-only');

    expect(addNode).not.toHaveBeenCalled();
    addNode.mockRestore();
  });

  it('paste while a field is focused is left to the browser (no node created)', () => {
    mockUseCanvasSpace.mockReturnValue(mockSpace());
    const addNode = vi
      .spyOn(canvasSpace, 'addNode')
      .mockImplementation(() => undefined);
    renderSpace();
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();

    dispatchPaste('text into the input');

    expect(addNode).not.toHaveBeenCalled();
    input.remove();
    addNode.mockRestore();
  });

  // ---- Right-click menu (context menu) ----
  // The reported bug: canvas surfaces leaked the browser's native menu. Right-
  // clicking the pane must suppress it (preventDefault) and open our custom menu
  // (the Paste item proves it mounted).
  it('right-clicking the pane suppresses the native menu and opens the custom menu', () => {
    mockUseCanvasSpace.mockReturnValue(mockSpace());
    renderSpace();
    const pane = document.querySelector('.react-flow__pane');
    expect(pane).not.toBeNull();

    const event = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      pane?.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(true);
    expect(screen.getByTestId('canvas-menu-paste')).toBeInTheDocument();
  });

  // Viewer (read-only) still gets the native menu suppressed on the canvas
  // surface, but no custom menu opens — there are no mutating items to offer
  // (spec R5).
  it('readOnly pane right-click suppresses the native menu but opens no custom menu', () => {
    mockUseCanvasSpace.mockReturnValue(mockSpace());
    renderSpace(true);
    const pane = document.querySelector('.react-flow__pane');

    const event = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      pane?.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(true);
    expect(screen.queryByTestId('canvas-menu-paste')).not.toBeInTheDocument();
  });

  // ---- History bridge (undo / redo) ----

  it('mirrors the hook undo availability into the canvas store (canvas → chrome)', () => {
    mockUseCanvasSpace.mockReturnValue(mockSpace({ canUndo: true, canRedo: false }));
    renderSpace();
    expect(useCanvasStore.getState().canUndo).toBe(true);
    expect(useCanvasStore.getState().canRedo).toBe(false);
  });

  it('consumes an undo command posted by the chrome toolbar (chrome → canvas mailbox)', async () => {
    mockUseCanvasSpace.mockReturnValue(mockSpace({ canUndo: true }));
    useCanvasStore.getState().requestHistoryCommand('undo');
    renderSpace();
    await waitFor(() =>
      expect(useCanvasStore.getState().pendingHistoryCommand).toBeNull(),
    );
    expect(undoSpy).toHaveBeenCalledTimes(1);
    expect(redoSpy).not.toHaveBeenCalled();
  });

  it('Cmd+Z (mac) triggers undo; Cmd+Shift+Z triggers redo', () => {
    mockUseCanvasSpace.mockReturnValue(mockSpace({ canUndo: true, canRedo: true }));
    renderSpace();

    dispatchKeyDown('z', { meta: true });
    expect(undoSpy).toHaveBeenCalledTimes(1);

    dispatchKeyDown('z', { meta: true, shift: true });
    expect(redoSpy).toHaveBeenCalledTimes(1);
  });

  it('Ctrl+Z (windows) triggers undo; Ctrl+Y triggers redo', () => {
    mockUseCanvasSpace.mockReturnValue(mockSpace({ canUndo: true, canRedo: true }));
    renderSpace();

    dispatchKeyDown('z', { ctrl: true });
    expect(undoSpy).toHaveBeenCalledTimes(1);

    dispatchKeyDown('y', { ctrl: true });
    expect(redoSpy).toHaveBeenCalledTimes(1);
  });

  it('keyboard undo is a no-op while a field is focused (input native undo wins)', () => {
    mockUseCanvasSpace.mockReturnValue(mockSpace({ canUndo: true }));
    renderSpace();
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();

    dispatchKeyDown('z', { meta: true });

    expect(undoSpy).not.toHaveBeenCalled();
    input.remove();
  });

  it('readOnly canvas ignores keyboard undo and posted history commands', async () => {
    mockUseCanvasSpace.mockReturnValue(mockSpace({ canUndo: true }));
    useCanvasStore.getState().requestHistoryCommand('undo');
    renderSpace(true);

    await waitFor(() =>
      expect(useCanvasStore.getState().pendingHistoryCommand).toBeNull(),
    );
    dispatchKeyDown('z', { meta: true });

    expect(undoSpy).not.toHaveBeenCalled();
  });

  // ---- Upload operation registry: pre-registration window (#1617) ----
  // A front-end upload must mark its space BUSY in the operation registry
  // synchronously the moment it starts — BEFORE the async upload-config fetch.
  // The tab-close guard (ProjectPage.onCloseTab) reads hasOperations at event
  // time; if registration lags behind `await fetchUploadConfig()`, a tab close
  // during that round-trip bypasses the guard and the resumed write-back lands
  // on a detached Yjs doc = lost upload (adversarial re-attack round 2, #1617).
  it('drop marks the space busy synchronously, before the upload-config fetch resolves (#1617 window)', () => {
    mockUseCanvasSpace.mockReturnValue(mockSpace());
    // Deferred config fetch: stays pending so the upload flow is suspended AT
    // the config await — the exact point the pre-fix code had not yet registered.
    const configSpy = vi
      .spyOn(assetsApi, 'fetchUploadConfig')
      .mockReturnValue(
        new Promise(() => {}) as ReturnType<typeof assetsApi.fetchUploadConfig>,
      );
    renderSpace();

    const surface = screen.getByTestId('canvas-space');
    const file = new File(['x'], 'a.png', { type: 'image/png' });
    const drop = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(drop, 'dataTransfer', {
      configurable: true,
      value: { files: [file], types: ['Files'] },
    });
    Object.defineProperty(drop, 'clientX', { configurable: true, value: 10 });
    Object.defineProperty(drop, 'clientY', { configurable: true, value: 10 });
    act(() => {
      surface.dispatchEvent(drop);
    });

    // The drop reached the upload flow (it awaited the config)...
    expect(configSpy).toHaveBeenCalled();
    // ...and the space is ALREADY busy — before the config fetch resolves.
    expect(useSpaceOperationsStore.getState().hasOperations('s')).toBe(true);

    configSpy.mockRestore();
  });

  // ---- Magnetic handle (user 2026-07-11) ----
  // The 8px anchor element is invisible (its center is the edge attachment);
  // the visible dot is a spring-following child, and the 36px outside-the-
  // border hit zone is the ::before. jsdom sees classes, not geometry; the
  // magnetic behavior + geometry are covered in MagneticHandle.test.tsx and
  // the real-browser smoke.
  it('mounts magnetic connection handles with an outside-the-border hit zone and a dot child', () => {
    mockUseCanvasSpace.mockReturnValue(
      mockSpace({
        nodes: [
          {
            id: 'n1',
            type: 'image',
            position: { x: 0, y: 0 },
            data: { kind: 'image', content: 'x.png', status: 'idle' },
          },
        ],
      }),
    );
    renderSpace();
    const target = document.querySelector('.react-flow__handle.target');
    const source = document.querySelector('.react-flow__handle.source');
    expect(target).not.toBeNull();
    expect(source).not.toBeNull();
    for (const handle of [target, source]) {
      expect(handle?.className).toContain('!bg-transparent');
      expect(handle?.className).toContain('before:h-9');
      expect(handle?.className).toContain('before:w-9');
      expect(
        handle?.querySelector('[data-testid="handle-dot"]'),
      ).not.toBeNull();
    }
    // Border-pinned anchors (P1, user 2026-07-12): both shifted 4px inward
    // (!left-1 / !right-1) so the outer edge — the wire attachment — sits ON the
    // border, and the 36px zone offsets gain +4px to still start at the border:
    // source before:left-2, target before:-left-9.
    expect(target?.className).toContain('!left-1');
    expect(source?.className).toContain('!right-1');
    expect(target?.className).toContain('before:-left-9');
    expect(source?.className).toContain('before:left-2');
  });

  // ---- Pick session owns ALL connect gestures (adversarial round-1 HIGH) ----
  // The item-12 gate covered only uploads; handles stayed live during a pick,
  // so two candidate clicks in their hot zones ARMED xyflow click-connect and
  // silently wrote a candidate-to-candidate edge the user never drew (and a
  // 1px hot-zone drag released on blank could pop the create menu mid-pick).
  // nodesConnectable=false during the pick kills both at the gesture source.
  it('a reference pick disables the connection handles (no connectable state)', () => {
    mockUseCanvasSpace.mockReturnValue(
      mockSpace({
        nodes: [
          {
            id: 'target',
            type: 'image',
            position: { x: 0, y: 0 },
            data: { kind: 'image', status: 'idle' },
          },
          {
            id: 'candidate',
            type: 'image',
            position: { x: 400, y: 0 },
            data: { kind: 'image', content: 'c.png', status: 'idle' },
          },
        ],
      }),
    );
    renderSpace();
    const handle = document.querySelector('.react-flow__handle');
    expect(handle?.className).toContain('connectable');
    // Pick state only — the panel (its own catalog/query stack) is not
    // needed to prove the gesture gate.
    act(() => {
      useCanvasStore.setState({ pickSession: { nodeId: 'target', purpose: 'reference' } });
    });
    expect(
      document.querySelector('.react-flow__handle')?.className,
    ).not.toContain('connectable');
    act(() => {
      useCanvasStore.setState({ pickSession: null });
    });
    expect(
      document.querySelector('.react-flow__handle')?.className,
    ).toContain('connectable');
  });

  // ---- Pick session suppresses the context menus (adversarial round-1) ----
  // A node right-click mid-pick opened the full action menu (whose Upload
  // silently no-ops behind the item-12 gate, and whose Delete would mutate
  // the pick surface). The pick session owns pointer interactions until Exit.
  it('a reference pick suppresses the node and pane context menus', () => {
    mockUseCanvasSpace.mockReturnValue(
      mockSpace({
        nodes: [
          {
            id: 'target',
            type: 'image',
            position: { x: 0, y: 0 },
            data: { kind: 'image', status: 'idle' },
          },
        ],
      }),
    );
    renderSpace();
    act(() => {
      useCanvasStore.setState({ pickSession: { nodeId: 'target', purpose: 'reference' } });
    });
    const node = document.querySelector('.react-flow__node');
    act(() => {
      node?.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
      );
    });
    expect(screen.queryByTestId('node-menu-generate')).toBeNull();
    const pane = document.querySelector('.react-flow__pane');
    act(() => {
      pane?.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
      );
    });
    expect(screen.queryByTestId('create-node-text')).toBeNull();
    act(() => {
      useCanvasStore.setState({ pickSession: null });
    });
  });

  // ---- Exit restores keyboard focus (adversarial round-1, a11y) ----
  // The Exit button unmounts with the banner; without a hand-off, focus
  // drops to <body> and a keyboard user is stranded. Exit passes focus to
  // the panel's pick trigger (still mounted — the pick kept the panel open).
  it('exiting the pick via the banner hands focus to the pick trigger', () => {
    mockUseCanvasSpace.mockReturnValue(
      mockSpace({
        nodes: [
          {
            id: 'target',
            type: 'image',
            position: { x: 0, y: 0 },
            data: { kind: 'image', status: 'idle' },
          },
        ],
      }),
    );
    renderSpace();
    // The real trigger lives in the Generate panel (kept open by the pick);
    // this test plants a stand-in so the hand-off contract is provable
    // without mounting the full panel stack (catalog fetch + socket).
    const trigger = document.createElement('button');
    trigger.setAttribute('data-testid', 'generate-tool-reference');
    document.body.appendChild(trigger);
    try {
      act(() => {
        useCanvasStore.setState({ pickSession: { nodeId: 'target', purpose: 'reference' } });
      });
      const exit = screen.getByTestId('reference-pick-exit');
      act(() => {
        exit.dispatchEvent(
          new MouseEvent('click', { bubbles: true, cancelable: true }),
        );
      });
      expect(useCanvasStore.getState().pickSession).toBeNull();
      expect(document.activeElement).toBe(trigger);
    } finally {
      trigger.remove();
      act(() => {
        useCanvasStore.setState({ pickSession: null });
      });
    }
  });

  // ---- Pick-end focus catch-all (adversarial round-2, a11y) ----
  // The banner Exit hand-off focuses the pick trigger, but when the trigger
  // is disabled (t2i switch mid-pick) or the pick ends by another path (panel
  // X, host node deleted) focus dropped to <body>. A catch-all restores focus
  // to the canvas container whenever a pick ends with focus orphaned.
  it('restores focus to the canvas container when a pick ends with focus on <body>', () => {
    mockUseCanvasSpace.mockReturnValue(
      mockSpace({
        nodes: [
          {
            id: 'target',
            type: 'image',
            position: { x: 0, y: 0 },
            data: { kind: 'image', status: 'idle' },
          },
        ],
      }),
    );
    renderSpace();
    act(() => {
      useCanvasStore.setState({ pickSession: { nodeId: 'target', purpose: 'reference' } });
    });
    // Simulate an orphaned focus (the disabled-trigger / panel-X / node-gone
    // paths all land here) and end the pick WITHOUT the banner hand-off.
    act(() => {
      document.body.focus();
      useCanvasStore.setState({ pickSession: null });
    });
    expect(document.activeElement).toBe(screen.getByTestId('canvas-space'));
  });

  it('does not steal focus when a pick ends with focus already placed (Exit hand-off)', () => {
    mockUseCanvasSpace.mockReturnValue(
      mockSpace({
        nodes: [
          {
            id: 'target',
            type: 'image',
            position: { x: 0, y: 0 },
            data: { kind: 'image', status: 'idle' },
          },
        ],
      }),
    );
    renderSpace();
    const elsewhere = document.createElement('button');
    document.body.appendChild(elsewhere);
    try {
      act(() => {
        useCanvasStore.setState({ pickSession: { nodeId: 'target', purpose: 'reference' } });
      });
      act(() => {
        elsewhere.focus();
        useCanvasStore.setState({ pickSession: null });
      });
      // Focus was NOT on body, so the catch-all leaves it alone.
      expect(document.activeElement).toBe(elsewhere);
    } finally {
      elsewhere.remove();
    }
  });

  // ---- Reference-pick double-click gate (batch-2 item 12) ----
  // onNodeClick / onPaneClick already delegate to the pick session, but a
  // DOUBLE-click on an empty node's placeholder went straight to
  // activateNodeUpload and popped the file picker over the running pick. The
  // gate lives in activateNodeUpload itself (single choke point: placeholder
  // double-click AND the node-menu Upload both route through it).
  it('a double-click on an empty node during a reference pick does not open the file picker', () => {
    mockUseCanvasSpace.mockReturnValue(
      mockSpace({
        nodes: [
          {
            id: 'n1',
            type: 'image',
            position: { x: 0, y: 0 },
            data: { kind: 'image', status: 'idle' },
          },
        ],
      }),
    );
    const clickSpy = vi
      .spyOn(HTMLInputElement.prototype, 'click')
      .mockImplementation(() => {});
    // finally-cleanup: a failing assertion mid-test must not leak the pick
    // state / prototype spy into later tests (bit us in the red phase).
    try {
      renderSpace();
      act(() => {
        useCanvasStore.setState({ pickSession: { nodeId: 'other', purpose: 'reference' } });
      });
      const placeholder = screen.getByTestId('node-placeholder');
      act(() => {
        placeholder.dispatchEvent(
          new MouseEvent('dblclick', { bubbles: true, cancelable: true }),
        );
      });
      expect(clickSpy).not.toHaveBeenCalled();

      // Control: off pick mode the same double-click opens the picker — proves
      // the gate (not a broken wire) is what suppressed it above.
      act(() => {
        useCanvasStore.setState({ pickSession: null });
      });
      act(() => {
        placeholder.dispatchEvent(
          new MouseEvent('dblclick', { bubbles: true, cancelable: true }),
        );
      });
      expect(clickSpy).toHaveBeenCalledTimes(1);
    } finally {
      act(() => {
        useCanvasStore.setState({ pickSession: null });
      });
      clickSpy.mockRestore();
    }
  });

  // ---- Node-state gate: Generate menu opens on a LOCKED node (bug 2a) ----
  // A locked image node still OFFERS Generate so the user can open the panel to
  // view / edit the prompt; EXECUTE is what the gate stops (in the panel), not
  // the menu affordance. Previously the item was disabled on locked nodes.
  it('the Generate menu item is enabled on a locked image node (bug 2a)', () => {
    mockUseCanvasSpace.mockReturnValue(
      mockSpace({
        nodes: [
          {
            id: 'locked-img',
            type: 'image',
            position: { x: 0, y: 0 },
            data: { kind: 'image', status: 'idle', locked: true },
          },
        ],
      }),
    );
    renderSpace();
    const node = document.querySelector('.react-flow__node');
    act(() => {
      node?.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
      );
    });
    // Present AND enabled — a Radix disabled item carries data-disabled /
    // aria-disabled='true'; an enabled item carries neither.
    const generate = screen.getByTestId('node-menu-generate');
    expect(generate).not.toHaveAttribute('data-disabled');
    expect(generate.getAttribute('aria-disabled')).not.toBe('true');
  });

  // ---- Node-state gate: upload refused on a LOCKED node (bug 4) ----
  // Right-click Upload and the empty-node double-click both funnel through
  // activateNodeUpload; the gate there refuses a locked node before popping the
  // file picker. Fresh Yjs read → spied here (the real doc is empty in tests).
  it('a double-click on a locked empty node does not open the file picker (bug 4)', () => {
    mockUseCanvasSpace.mockReturnValue(
      mockSpace({
        nodes: [
          {
            id: 'locked',
            type: 'image',
            position: { x: 0, y: 0 },
            data: { kind: 'image', status: 'idle' },
          },
        ],
      }),
    );
    const clickSpy = vi
      .spyOn(HTMLInputElement.prototype, 'click')
      .mockImplementation(() => {});
    const lockedSpy = vi
      .spyOn(canvasSpace, 'isNodeLocked')
      .mockReturnValue(true);
    try {
      renderSpace();
      const placeholder = screen.getByTestId('node-placeholder');
      act(() => {
        placeholder.dispatchEvent(
          new MouseEvent('dblclick', { bubbles: true, cancelable: true }),
        );
      });
      expect(clickSpy).not.toHaveBeenCalled();

      // Control: unlocked, the same double-click opens the picker — proves the
      // gate (not a broken wire) is what suppressed it above.
      lockedSpy.mockReturnValue(false);
      act(() => {
        placeholder.dispatchEvent(
          new MouseEvent('dblclick', { bubbles: true, cancelable: true }),
        );
      });
      expect(clickSpy).toHaveBeenCalledTimes(1);
    } finally {
      clickSpy.mockRestore();
      lockedSpy.mockRestore();
    }
  });

  // ---- reset menu click is GATE-FREE (user 2026-07-22, unify with History) ----
  // Right-click opens the reset panel regardless of node state — configuring a
  // reset is not a mutation. The gate lives at EXECUTE (gate 2 test below), so a
  // LOCKED node still opens the panel here and never toasts at menu-click.
  it('reset-to-empty on a LOCKED image node OPENS the panel gate-free — menu never gates (user 2026-07-22)', () => {
    mockUseCanvasSpace.mockReturnValue(
      mockSpace({
        nodes: [
          {
            id: 'img',
            type: 'image',
            position: { x: 0, y: 0 },
            data: { kind: 'image', status: 'idle', locked: true },
          },
        ],
      }),
    );
    const warnSpy = vi.spyOn(toast, 'warning').mockReturnValue('t');
    const lockedSpy = vi
      .spyOn(canvasSpace, 'isNodeLocked')
      .mockReturnValue(true);
    try {
      useCanvasStore.setState({ panelHostId: null, panelKind: null });
      renderSpace();
      const node = document.querySelector('.react-flow__node');
      act(() => {
        node?.dispatchEvent(
          new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
        );
      });
      fireEvent.click(screen.getByTestId('node-menu-reset-image'));
      // Panel opens even though the node is locked; NO menu-click toast — the
      // gate fires only at Execute (the gate-2 test proves the write is blocked).
      expect(warnSpy).not.toHaveBeenCalled();
      expect(useCanvasStore.getState().panelKind).toBe('resetEmpty');
      expect(useCanvasStore.getState().panelHostId).toBe('img');
    } finally {
      warnSpy.mockRestore();
      lockedSpy.mockRestore();
      useCanvasStore.setState({ panelHostId: null, panelKind: null });
    }
  });

  // ---- #1623 reset gate 2: Execute after the node was locked ----
  // The panel is open; a collaborator locks the node; Execute must NOT write —
  // it toasts, closes the panel, and never even rasterises the blank PNG.
  it('reset Execute on a since-locked node toasts, closes, and never rasterises (#1623 gate 2)', () => {
    mockUseCanvasSpace.mockReturnValue(
      mockSpace({
        nodes: [
          {
            id: 'img',
            type: 'image',
            position: { x: 0, y: 0 },
            data: { kind: 'image', status: 'idle' },
          },
        ],
      }),
    );
    const warnSpy = vi.spyOn(toast, 'warning').mockReturnValue('t');
    const genSpy = vi
      .spyOn(blankPng, 'generateBlankPng')
      .mockResolvedValue(new File([], 'blank.png', { type: 'image/png' }));
    const lockedSpy = vi
      .spyOn(canvasSpace, 'isNodeLocked')
      .mockReturnValue(false);
    try {
      renderSpace();
      act(() => {
        useCanvasStore.getState().openEmptyImagePanel('img');
      });
      // The node gets locked while the panel is open.
      lockedSpy.mockReturnValue(true);
      fireEvent.click(screen.getByTestId('empty-image-execute'));
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(genSpy).not.toHaveBeenCalled();
      expect(useCanvasStore.getState().panelHostId).toBeNull();
    } finally {
      warnSpy.mockRestore();
      genSpy.mockRestore();
      lockedSpy.mockRestore();
      useCanvasStore.setState({ panelHostId: null, panelKind: null });
    }
  });

  // ---- #1623 reset success path: Execute on an UNLOCKED node ----
  // Complements gate 2: an unlocked node DOES rasterise (with the panel's
  // default 1024² white spec) and closes the panel. Guards the wiring from
  // Execute → generateBlankPng args (a regression to the dims / colour, or a
  // gate that wrongly blocks the happy path, is caught here).
  it('reset Execute on an unlocked node rasterises with the chosen spec and closes (#1623 success)', () => {
    mockUseCanvasSpace.mockReturnValue(
      mockSpace({
        nodes: [
          {
            id: 'img',
            type: 'image',
            position: { x: 0, y: 0 },
            data: { kind: 'image', status: 'idle' },
          },
        ],
      }),
    );
    const genSpy = vi
      .spyOn(blankPng, 'generateBlankPng')
      .mockResolvedValue(new File([], 'blank.png', { type: 'image/png' }));
    const lockedSpy = vi
      .spyOn(canvasSpace, 'isNodeLocked')
      .mockReturnValue(false);
    try {
      renderSpace();
      act(() => {
        useCanvasStore.getState().openEmptyImagePanel('img');
      });
      fireEvent.click(screen.getByTestId('empty-image-execute'));
      expect(genSpy).toHaveBeenCalledWith(1024, 1024, '#ffffff');
      expect(useCanvasStore.getState().panelHostId).toBeNull();
    } finally {
      genSpy.mockRestore();
      lockedSpy.mockRestore();
      useCanvasStore.setState({ panelHostId: null, panelKind: null });
    }
  });

  // ── #1987 视频节点也能被聚焦 ──────────────────────────────────────
  // 聚焦的类型判据是一个函数 isFocusCandidate，变暗规则（哪些节点看起来能选）
  // 和点击处理（点下去生不生效）各调它一次。两处各有测试，缺一不可 —— 只钉变暗
  // 那半，对「看着能选、点了没反应」是瞎的，而 round-4 修过的正是这个病（病史
  // 见该函数的 TSDoc）。

  it('聚焦挑选：视频节点是候选，不变暗（#1987 A1/A6）', () => {
    mockUseCanvasSpace.mockReturnValue(
      mockSpace({
        nodes: [
          {
            id: 'target',
            type: 'image',
            position: { x: 0, y: 0 },
            data: { kind: 'image', status: 'idle' },
          },
          {
            id: 'src-video',
            type: 'video',
            position: { x: 300, y: 0 },
            data: { kind: 'video', content: 'v.mp4', status: 'idle' },
          },
          {
            id: 'src-image',
            type: 'image',
            position: { x: 600, y: 0 },
            data: { kind: 'image', content: 'x.png', status: 'idle' },
          },
        ],
      }),
    );
    renderSpace();
    act(() => {
      useCanvasStore.getState().startFocusPick('target');
    });
    const cls = (id: string): string =>
      document.querySelector(`.react-flow__node[data-id="${id}"]`)?.className ??
      '';
    expect(cls('src-video')).toContain('canvas-pick-selectable');
    expect(cls('src-video')).not.toContain('canvas-pick-dimmed');
    // 图片仍然是候选（这次是加类型，不是换类型）
    expect(cls('src-image')).toContain('canvas-pick-selectable');
  });

  it('风格挑选：视频节点仍然变暗，不受聚焦那次放宽影响（#1987 A6）', () => {
    // 变暗规则那条分支里，style 和视频槽位共用一个回落值（`pickedNodes` 里
    // 那句 `paintingSlot ? VIDEO_SLOTS[...].accepts : 'image'`，行号会漂、
    // 按这个表达式找），而 style 的点击侧只认图片。照着那个回落值放宽
    // 会让视频在风格挑选里变成「看着能选、点了没反应」—— 正是上面那条注释
    // 记的病。所以放宽必须只作用于 focus 那一支。
    mockUseCanvasSpace.mockReturnValue(
      mockSpace({
        nodes: [
          {
            id: 'target',
            type: 'image',
            position: { x: 0, y: 0 },
            data: { kind: 'image', status: 'idle' },
          },
          {
            id: 'src-video',
            type: 'video',
            position: { x: 300, y: 0 },
            data: { kind: 'video', content: 'v.mp4', status: 'idle' },
          },
        ],
      }),
    );
    renderSpace();
    act(() => {
      useCanvasStore.getState().startStylePick('target');
    });
    const cls = (id: string): string =>
      document.querySelector(`.react-flow__node[data-id="${id}"]`)?.className ??
      '';
    expect(cls('src-video')).toContain('canvas-pick-dimmed');
    expect(cls('src-video')).not.toContain('canvas-pick-selectable');
  });

  it('聚焦挑选：点中视频节点之后裁剪浮层挂上（#1987 A1）', () => {
    // 判据的另一半。浮层的渲染门是 pickSession.purpose === 'focus' &&
    // focusCropTargetId !== null，而 focusCropTargetId 是 CanvasSpace 的本地
    // state，测试看不到它 —— 看得到的是浮层出没出来。
    mockUseCanvasSpace.mockReturnValue(
      mockSpace({
        nodes: [
          {
            id: 'target',
            type: 'image',
            position: { x: 0, y: 0 },
            data: { kind: 'image', status: 'idle' },
          },
          {
            id: 'src-video',
            type: 'video',
            position: { x: 300, y: 0 },
            data: { kind: 'video', content: 'v.mp4', status: 'idle' },
          },
        ],
      }),
    );
    renderSpace();
    act(() => {
      useCanvasStore.getState().startFocusPick('target');
    });
    expect(screen.queryByTestId('focus-crop-overlay')).toBeNull();
    act(() => {
      fireEvent.click(
        document.querySelector('.react-flow__node[data-id="src-video"]')!,
      );
    });
    expect(screen.getByTestId('focus-crop-overlay')).toBeInTheDocument();
  });

  it('聚焦挑选：音频节点两道都被拒（#1987）', () => {
    // 音频的 <audio> 跟视频共用 media-element 这个 testid，所以判类型不能靠
    // testid。这条钉的是候选那一道：音频不该变成候选。
    mockUseCanvasSpace.mockReturnValue(
      mockSpace({
        nodes: [
          {
            id: 'target',
            type: 'image',
            position: { x: 0, y: 0 },
            data: { kind: 'image', status: 'idle' },
          },
          {
            id: 'src-audio',
            type: 'audio',
            position: { x: 300, y: 0 },
            data: { kind: 'audio', content: 'a.m4a', status: 'idle' },
          },
        ],
      }),
    );
    renderSpace();
    act(() => {
      useCanvasStore.getState().startFocusPick('target');
    });
    const cls = (id: string): string =>
      document.querySelector(`.react-flow__node[data-id="${id}"]`)?.className ??
      '';
    expect(cls('src-audio')).toContain('canvas-pick-dimmed');
    expect(cls('src-audio')).not.toContain('canvas-pick-selectable');
    // 点它也不该挂上浮层
    act(() => {
      fireEvent.click(
        document.querySelector('.react-flow__node[data-id="src-audio"]')!,
      );
    });
    expect(screen.queryByTestId('focus-crop-overlay')).toBeNull();
  });

  it('聚焦挑选：正在生成或出错的视频不是候选（#1987 A1 的 idle 门）', () => {
    // The overlay anchors its marquee to a RENDERED element, and a handling /
    // error node renders a skeleton or an error box instead — round-4 of #1782
    // fixed exactly the "looks pickable, click does nothing" this causes.
    // Round 2 measured that deleting this clause kept all 95 tests green.
    mockUseCanvasSpace.mockReturnValue(
      mockSpace({
        nodes: [
          {
            id: 'target',
            type: 'image',
            position: { x: 0, y: 0 },
            data: { kind: 'image', status: 'idle' },
          },
          {
            id: 'busy-video',
            type: 'video',
            position: { x: 300, y: 0 },
            data: { kind: 'video', content: 'v.mp4', status: 'handling' },
          },
          {
            id: 'broken-video',
            type: 'video',
            position: { x: 600, y: 0 },
            data: { kind: 'video', content: 'v.mp4', status: 'error' },
          },
          {
            id: 'empty-video',
            type: 'video',
            position: { x: 900, y: 0 },
            data: { kind: 'video', status: 'idle' },
          },
        ],
      }),
    );
    renderSpace();
    act(() => {
      useCanvasStore.getState().startFocusPick('target');
    });
    const cls = (id: string): string =>
      document.querySelector(`.react-flow__node[data-id="${id}"]`)?.className ??
      '';
    for (const id of ['busy-video', 'broken-video', 'empty-video']) {
      expect(cls(id)).toContain('canvas-pick-dimmed');
      expect(cls(id)).not.toContain('canvas-pick-selectable');
    }
    // And the click side agrees — the two predicates are the same function.
    for (const id of ['busy-video', 'broken-video', 'empty-video']) {
      act(() => {
        fireEvent.click(
          document.querySelector(`.react-flow__node[data-id="${id}"]`)!,
        );
      });
      expect(screen.queryByTestId('focus-crop-overlay')).toBeNull();
    }
  });

  it('聚焦挑选：目标节点自己不是候选（#1987 A1）', () => {
    // Cropping the node you are filling would feed it its own content.
    mockUseCanvasSpace.mockReturnValue(
      mockSpace({
        nodes: [
          {
            id: 'target',
            type: 'video',
            position: { x: 0, y: 0 },
            data: { kind: 'video', content: 'self.mp4', status: 'idle' },
          },
        ],
      }),
    );
    renderSpace();
    act(() => {
      useCanvasStore.getState().startFocusPick('target');
    });
    const cls =
      document.querySelector('.react-flow__node[data-id="target"]')?.className ??
      '';
    expect(cls).toContain('canvas-pick-dimmed');
    act(() => {
      fireEvent.click(document.querySelector('.react-flow__node[data-id="target"]')!);
    });
    expect(screen.queryByTestId('focus-crop-overlay')).toBeNull();
  });

  it('贯通：浮层交出的时间点原样到达 runFocusCrop 的入参（#1987 A9）', () => {
    // 从浮层到取源之间有五个环节，其中一个是函数赋值 —— 编译器管不住它，
    // 少给一个字段照样编译通过（`natural` 今天就是这么被吃掉的）。所以这条
    // 走完整条链：真的点节点、真的画选框、真的点确认，然后看最下游收到什么。
    const rect = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: HTMLElement) {
        const isTarget = this.tagName === 'VIDEO';
        return {
          x: isTarget ? 100 : 0,
          y: isTarget ? 50 : 0,
          left: isTarget ? 100 : 0,
          top: isTarget ? 50 : 0,
          right: isTarget ? 500 : 1000,
          bottom: isTarget ? 350 : 1000,
          width: isTarget ? 400 : 1000,
          height: isTarget ? 300 : 1000,
          toJSON: () => ({}),
        } as DOMRect;
      });
    try {
      mockUseCanvasSpace.mockReturnValue(
        mockSpace({
          nodes: [
            {
              id: 'target',
              type: 'image',
              position: { x: 0, y: 0 },
              data: { kind: 'image', status: 'idle' },
            },
            {
              id: 'src-video',
              type: 'video',
              position: { x: 300, y: 0 },
              data: {
                kind: 'video',
                content: 'https://cdn/clip.mp4',
                name: 'Video Node 3',
                status: 'idle',
              },
            },
          ],
        }),
      );
      renderSpace();
      act(() => {
        useCanvasStore.getState().startFocusPick('target');
      });
      act(() => {
        fireEvent.click(
          document.querySelector('.react-flow__node[data-id="src-video"]')!,
        );
      });
      const video = screen.getByTestId('media-element') as HTMLVideoElement;
      Object.defineProperty(video, 'videoWidth', { value: 800, configurable: true });
      Object.defineProperty(video, 'videoHeight', { value: 600, configurable: true });
      // 用户拖时间轴停在的那一帧，故意不是整秒。
      Object.defineProperty(video, 'currentTime', {
        value: 4.375,
        writable: true,
        configurable: true,
      });
      act(() => {
        fireEvent(window, new Event('resize'));
      });
      const layer = screen.getByTestId('focus-crop-layer');
      act(() => {
        fireEvent.pointerDown(layer, { clientX: 150, clientY: 100, button: 0 });
        fireEvent.pointerMove(layer, { clientX: 250, clientY: 180 });
        fireEvent.pointerUp(layer);
      });
      act(() => {
        fireEvent.click(screen.getByTestId('focus-crop-confirm'));
      });
      expect(mockRunFocusCrop).toHaveBeenCalledTimes(1);
      expect(mockRunFocusCrop.mock.calls[0]![0]).toMatchObject({
        sourceUrl: 'https://cdn/clip.mp4',
        sourceTimeSeconds: 4.375,
      });
    } finally {
      rect.mockRestore();
    }
  });

  // Every global keyboard and clipboard outlet on the canvas asks the same
  // question first: does this event belong to the space region? The seven below
  // are the ones #168 changes; the modifier-key props ReactFlow owns are scoped
  // by where the pointer lands, so they are untouched.
  describe('keyboard and clipboard belong to the active region (#168)', () => {
    /**
     * Mounts a space holding `count` text nodes, all selected the way the
     * canvas reads selection (its ReactFlow mirror, not Yjs). Two of them is
     * what the group shortcut needs before it offers anything.
     * @param count - How many nodes to put on the board.
     */
    const mountWithSelection = (count = 1): void => {
      mockUseCanvasSpace.mockReturnValue(
        mockSpace({
          nodes: Array.from({ length: count }, (_, i) => ({
            id: `n${i + 1}`,
            type: 'text' as const,
            position: { x: i * 400, y: 0 },
            data: { kind: 'text' as const, status: 'idle' as const, name: 'N' },
          })),
        }),
      );
      renderSpace();
      act(() => {
        useCanvasGraphStore
          .getState()
          .setFlowNodes((prev) => prev.map((n) => ({ ...n, selected: true })));
      });
    };

    /**
     * Spies on the space's write helpers, which is where every one of these
     * outlets ends up. The mocked hook feeds the canvas its nodes, so the
     * document itself never holds them — the write call is the observable.
     * @returns The spies, restored by `vi.restoreAllMocks` between tests.
     */
    const spyWrites = (): {
      removeElements: ReturnType<typeof vi.spyOn>;
      addNode: ReturnType<typeof vi.spyOn>;
      createGroup: ReturnType<typeof vi.spyOn>;
    } => ({
      removeElements: vi.spyOn(canvasSpace, 'removeElements'),
      addNode: vi.spyOn(canvasSpace, 'addNode'),
      createGroup: vi.spyOn(canvasSpace, 'createGroup'),
    });

    /**
     * Dispatches a copy event carrying a clipboard stub, and reports what the
     * canvas wrote to it.
     * @returns Whatever landed on the clipboard, empty when nothing did.
     */
    const copyAndRead = (): string => {
      let written = '';
      const event = new Event('copy', { bubbles: true }) as Event & {
        clipboardData: { setData: (type: string, data: string) => void };
      };
      Object.defineProperty(event, 'clipboardData', {
        value: {
          setData: (_type: string, data: string) => {
            written = data;
          },
        },
      });
      act(() => {
        keyTarget().dispatchEvent(event);
      });
      return written;
    };

    describe('the agent panel holds it', () => {
      beforeEach(() => {
        useUIStore.setState({ activeRegion: 'agent' });
      });

      it('undo leaves the document alone', () => {
        mockUseCanvasSpace.mockReturnValue(mockSpace());
        renderSpace();
        dispatchKeyDown('z', { meta: true });
        expect(undoSpy).not.toHaveBeenCalled();
      });

      it('redo leaves the document alone', () => {
        mockUseCanvasSpace.mockReturnValue(mockSpace());
        renderSpace();
        dispatchKeyDown('z', { meta: true, shift: true });
        expect(redoSpy).not.toHaveBeenCalled();
      });

      it('paste creates no node', () => {
        mockUseCanvasSpace.mockReturnValue(mockSpace());
        renderSpace();
        const { addNode } = spyWrites();
        dispatchPaste('https://example.com/a.png');
        expect(addNode).not.toHaveBeenCalled();
      });

      it('copy leaves the clipboard alone', () => {
        mountWithSelection();
        expect(copyAndRead()).toBe('');
      });

      it('the duplicate shortcut creates no clone', async () => {
        mountWithSelection();
        const { addNode } = spyWrites();
        dispatchKeyDown('d', { meta: true });
        await new Promise((r) => setTimeout(r, 30));
        expect(addNode).not.toHaveBeenCalled();
      });

      it('the group shortcut creates no group', async () => {
        mountWithSelection(2);
        const { createGroup } = spyWrites();
        dispatchKeyDown('g', { meta: true });
        await new Promise((r) => setTimeout(r, 30));
        expect(createGroup).not.toHaveBeenCalled();
      });

      it('the delete key removes nothing', async () => {
        mountWithSelection();
        const { removeElements } = spyWrites();
        dispatchKeyDown('Backspace');
        await new Promise((r) => setTimeout(r, 30));
        expect(removeElements).not.toHaveBeenCalled();
      });

      it('escape does not end a pick session', () => {
        mockUseCanvasSpace.mockReturnValue(mockSpace());
        renderSpace();
        act(() => {
          useCanvasStore.getState().startReferencePick('n1');
        });
        act(() => {
          keyTarget().dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
          );
        });
        expect(useCanvasStore.getState().pickSession).not.toBeNull();
      });
    });

    describe('the space region holds it', () => {
      // The library matched a single key against the whole pressed set, so a
      // modifier meant no match at all. Taking the key over keeps that: these
      // three delete nothing today.
      it.each([
        ['Cmd+Backspace', 'Backspace', { meta: true }],
        ['Shift+Delete', 'Delete', { shift: true }],
        ['Option+Backspace', 'Backspace', { alt: true }],
      ])('%s deletes nothing', async (_name, key, mods) => {
        mountWithSelection();
        const { removeElements } = spyWrites();
        dispatchKeyDown(key, mods);
        await new Promise((r) => setTimeout(r, 30));
        expect(removeElements).not.toHaveBeenCalled();
      });

      // A held key repeated ~30 times a second; the library's boolean meant one
      // delete per press.
      it('a repeat of the delete key deletes nothing', async () => {
        mountWithSelection();
        const { removeElements } = spyWrites();
        dispatchKeyDown('Backspace', { repeat: true });
        await new Promise((r) => setTimeout(r, 30));
        expect(removeElements).not.toHaveBeenCalled();
      });

      it('the delete key leaves the event default-prevented', () => {
        mountWithSelection();
        let prevented: boolean | null = null;
        const probe = (e: Event): void => {
          prevented = e.defaultPrevented;
        };
        document.addEventListener('keydown', probe);
        dispatchKeyDown('Backspace');
        document.removeEventListener('keydown', probe);
        expect(prevented).toBe(true);
      });

      it('the delete key removes the selected node', async () => {
        mountWithSelection();
        const { removeElements } = spyWrites();
        dispatchKeyDown('Backspace');
        await waitFor(() =>
          expect(removeElements).toHaveBeenCalledWith('p', 's', ['n1'], []),
        );
      });

      it('copy puts the selection on the clipboard', () => {
        mountWithSelection();
        expect(copyAndRead()).toContain('__breatic_canvas_nodes__:');
      });

      it('undo runs', () => {
        mockUseCanvasSpace.mockReturnValue(mockSpace());
        renderSpace();
        dispatchKeyDown('z', { meta: true });
        expect(undoSpy).toHaveBeenCalled();
      });
    });
  });
});

// Reference-pick mode cursor contract (canvas item 7, user 2026-07-10).
// jsdom does not resolve the CSS cascade for `cursor`, so the browser smoke
// (2026-07-10) is the real proof the dimmed node shows not-allowed. This guard
// pins the *specificity* that the smoke exposed: ReactFlow ships
// `.react-flow__node.draggable { cursor: grab }` (0,2,0), so the pick-mode
// cursor rules MUST stay scoped under `.react-flow .react-flow__node` (0,3,0)
// or the dimmed node silently keeps grab instead of not-allowed. A future
// "simplification" back to a bare `.canvas-pick-dimmed` selector regresses it.
describe('reference-pick interaction contract', () => {
  const src = readFileSync(
    resolve(__dirname, '../CanvasSpace.tsx'),
    'utf8',
  );

  it('disables marquee select while picking (NodesSelection rect would swallow pick clicks)', () => {
    // Round-1 adversarial: with selectionOnDrag always on, a marquee during a
    // pick leaves xyflow's NodesSelection rect overlaying the candidates and
    // subsequent pick clicks hit the rect instead of the nodes (a dead zone in
    // the continuous-pick contract). The prop must be pick-gated.
    expect(src).toContain('selectionOnDrag={pickForNodeId == null}');
  });

  it('adds the canvas-connecting class SYNCHRONOUSLY on connect-start so the magnetic zone stands down (round-4)', () => {
    // xyflow resolves a wire's target via elementFromPoint in the SAME tick it
    // starts the connection (onConnectStart → isValidHandle). A React class off
    // connection.inProgress commits one frame late, so the first move still
    // hit-tests the live 36px handle zones and could hijack to a neighbor. The
    // class must be added imperatively in onConnectStart (which runs
    // synchronously before that first target resolution) and removed on end.
    expect(src).toContain('onConnectStart={onConnectDragStart}');
    expect(src).toMatch(/classList\.add\(['"]canvas-connecting['"]\)/);
    expect(src).toMatch(/classList\.remove\(['"]canvas-connecting['"]\)/);
  });

  it('gates the magnetic zone on the DRAG path ONLY, never the click-connect path (round-5)', () => {
    // The click-connect path resolves each tap by a literal Handle onClick (no
    // connectionRadius net), so the 36px ::before zone must stay live to arm /
    // complete a tap in the zone — disabling it broke click-connect and, since
    // its cleanup only fires on the second tap, stuck the class on an abandoned
    // pick. Exactly ONE add and ONE remove (the drag pair) may exist.
    expect(src.match(/classList\.add\(['"]canvas-connecting['"]\)/g)).toHaveLength(1);
    expect(
      src.match(/classList\.remove\(['"]canvas-connecting['"]\)/g),
    ).toHaveLength(1);
    // The add lives in the drag-start callback, not the click-start one.
    const clickStart = src.slice(
      src.indexOf('const onClickConnectStart'),
      src.indexOf('const onClickConnectEnd'),
    );
    expect(clickStart).not.toContain('canvas-connecting');
  });

  it('NEVER toggles selectionKeyCode dynamically (xyflow latches mid-keyhold)', () => {
    // Round-3 adversarial: a round-2 fix gated selectionKeyCode on pick mode
    // ('Shift' → null). xyflow's useKeyPress detaches its listeners on the
    // flip WITHOUT resetting keyPressed, so flipping mid-Shift-hold (Shift+
    // clicking the add-reference button) latched the key permanently true and
    // every subsequent drag became a marquee hijack — with no recovery path
    // during the pick. Key-code props must stay CONSTANT; the pick dead zone
    // is neutralized at the render layer instead (canvas-picking CSS).
    // Matched as a JSX prop assignment — comments may (and do) mention the
    // prop name to document the trap.
    expect(src).not.toMatch(/selectionKeyCode=/);
    expect(src).toContain('canvas-picking');
  });

  it('clears the NodesSelection rect on programmatic sole-select and pane deselect', () => {
    // Round-2 adversarial: a native single node click clears xyflow's
    // nodesSelectionActive, but the programmatic assert (selectOnlyNode)
    // bypassed that lifecycle — after a pre-open marquee the rect shrank onto
    // the host and swallowed clicks until a pane click. Both programmatic
    // selection writes must clear the flag. Matched as the full setState call
    // (not a raw substring, which a comment could satisfy — round-3 finding).
    const calls = src.match(
      /rfStoreApi\.setState\(\{ nodesSelectionActive: false \}\)/g,
    );
    expect(calls?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it('marks the canvas wrapper as canvas-picking while a pick session is active', async () => {
    // The pick-mode stylesheet (NodesSelection hidden) is scoped by this
    // class — assert the wrapper actually carries it during a pick.
    mockUseCanvasSpace.mockReturnValue(
      mockSpace({
        nodes: [
          {
            id: 'target',
            type: 'image',
            position: { x: 0, y: 0 },
            data: { kind: 'image', status: 'idle', mode: 'i2i' },
          },
        ],
      }),
    );
    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <CanvasSpace projectId='p' spaceId='s' />
      </QueryClientProvider>,
    );
    expect(screen.getByTestId('canvas-space').className).not.toContain(
      'canvas-picking',
    );
    act(() => {
      useCanvasStore.setState({
        panelHostId: 'target', panelKind: 'generate',
        pickSession: { nodeId: 'target', purpose: 'reference' },
      });
    });
    await waitFor(() =>
      expect(screen.getByTestId('canvas-space').className).toContain(
        'canvas-picking',
      ),
    );
    // Store is module-global — clear so later suites start clean.
    act(() => {
      useCanvasStore.setState({
        panelHostId: null, panelKind: null,
        pickSession: null,
      });
    });
  });
});

describe('reference-pick stylesheet contract (item 7 cursor specificity)', () => {
  const css = readFileSync(resolve(__dirname, '../../../index.css'), 'utf8');

  it('scopes the dimmed cursor rule under .react-flow__node so it outranks ReactFlow grab', () => {
    expect(css).toContain(
      '.react-flow .react-flow__node.canvas-pick-dimmed',
    );
    const rule = css.slice(
      css.indexOf('.react-flow .react-flow__node.canvas-pick-dimmed'),
    );
    expect(rule).toContain('cursor: not-allowed');
    // A bare, unscoped selector (specificity 0,1,0) loses to ReactFlow's grab.
    expect(css).not.toMatch(/^\.canvas-pick-dimmed\s*\{/m);
  });

  it('scopes the selectable cursor rule under .react-flow__node so hover reads pointer', () => {
    expect(css).toContain(
      '.react-flow .react-flow__node.canvas-pick-selectable',
    );
    const rule = css.slice(
      css.indexOf('.react-flow .react-flow__node.canvas-pick-selectable'),
    );
    expect(rule).toContain('cursor: pointer');
    expect(css).not.toMatch(/^\.canvas-pick-selectable\s*\{/m);
  });

  it('stands the magnetic handle ::before zone down while connecting (round-4)', () => {
    // The synchronous .canvas-connecting class disables the 36px handle hit
    // zone during a drag so it cannot hijack xyflow's elementFromPoint target
    // resolution for a nearby node. Block-scoped so a decoy elsewhere can't
    // satisfy the substring (R4 gameable-contract lesson).
    expect(css).toMatch(
      /\.canvas-connecting \.react-flow__handle::before\s*\{[^}]*pointer-events:\s*none/,
    );
  });

  it('hides the NodesSelection rect during a pick (marquee dead-zone neutralizer)', () => {
    // Round-3: the Shift marquee stays enabled during a pick (gating
    // selectionKeyCode latches xyflow's key state mid-hold), so the
    // click-swallowing rect must simply never render while picking.
    // display:none must sit INSIDE this rule block (round-4 adversarial: a
    // slice-to-EOF check passed with the rule weakened to `opacity: 0` —
    // which keeps the rect's pointer-events:all hit-target alive — as soon
    // as any later rule in the file used display:none).
    expect(css).toMatch(
      /\.canvas-picking \.react-flow__nodesselection\s*\{[^}]*display:\s*none/,
    );
  });

  it('keeps the breathing glow on the selectable hover state (functional cue)', () => {
    expect(css).toContain(
      '.react-flow .react-flow__node.canvas-pick-selectable:hover',
    );
    expect(css).toContain('animation: canvas-pick-glow');
    expect(css).toContain('@keyframes canvas-pick-glow');
  });

  it('glow corner follows the node radius token, not a hardcoded value (batch-2 item 6)', () => {
    // A hardcoded 12px drew the halo at 2x the node card's 6px rounded-sm
    // corner (user screenshot 2026-07-11). Block-scoped match so the pin
    // cannot be satisfied by an unrelated later rule.
    expect(css).toMatch(
      /\.canvas-pick-selectable:hover\s*\{[^}]*border-radius:\s*var\(--radius-sm\)/,
    );
  });
});

// Locate-source absolute-position contract (item 7 locate, adversarial fix
// 2026-07-10). A grouped node stores a parent-relative position, but setCenter
// expects absolute canvas coordinates — centering on the bare `.position` panned
// the viewport toward the origin for a grouped source. jsdom can't render the
// ReactFlow grouped-node internals, so this source guard pins the fix: locate
// must read the internal node's `positionAbsolute`, never a bare user-node
// `.position`, when computing the center.
describe('onLocateSource absolute-position contract (item 7 grouped source)', () => {
  const src = readFileSync(
    resolve(__dirname, '../CanvasSpace.tsx'),
    'utf8',
  );
  const locate = src.slice(
    src.indexOf('const onLocateSource'),
    src.indexOf('const onLocateSource') + 900,
  );

  it('centers on the internal node positionAbsolute, not a parent-relative position', () => {
    expect(locate).toContain('getInternalNode');
    expect(locate).toContain('positionAbsolute');
    // The regression is centering on `node.position` (relative for a grouped
    // member). setCenter must not be fed a bare `.position.x`.
    expect(locate).not.toMatch(/setCenter\(\s*node\.position\.x/);
  });
});

// The space warms the model catalog on mount (#1966). Pinned here rather than
// left to the hook's own test, because the hook and the CALL are two different
// invariants: `use-prefetch-model-catalog.test.tsx` proves the hook prefetches,
// and this proves anything at all invokes it. Measured before it was written —
// deleting `usePrefetchModelCatalog()` from `CanvasSpace` left all 364 web test
// files and 3975 assertions green, so nothing in the suite held the wire.
//
// The assertion is that a request goes out with no panel opened, which is the
// whole point of a prefetch: without it the first Generate of a session pays
// for the round trip behind a panel that refuses to render until it lands.
describe('model catalog prefetch (#1966)', () => {
  it('asks for the catalog on mount, with no panel open', async () => {
    const list = vi
      .spyOn(modelsApi, 'list')
      .mockResolvedValue({ image: [], video: [], audio: [] } as never);
    try {
      mockUseCanvasSpace.mockReturnValue(mockSpace());
      renderSpace();
      await waitFor(() => expect(list).toHaveBeenCalled());
      // No Generate panel was opened, and none is on screen — the request came
      // from the space itself.
      expect(screen.queryByTestId('generate-video-execute')).toBeNull();
      expect(screen.queryByTestId('generate-execute')).toBeNull();
    } finally {
      list.mockRestore();
    }
  });

});
