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
import { bodyToPlainText, writePlainTextIntoBody } from '@breatic/shared/canvas/text-body';
import { addNode, getTextBody } from '@web/data/yjs/canvas-space';
import { runFocusCrop } from '@web/spaces/canvas/focus/run-focus-crop';
import * as downloadLib from '@web/lib/download';

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
const getUsersByIds = vi.fn((_ids: readonly string[]) => Promise.resolve([]));
vi.mock('@web/data/api/users', () => ({
  usersApi: { getByIds: (ids: readonly string[]) => getUsersByIds(ids) },
}));

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
    deletedByPeer: () => false,
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
function clickPane(pane: Element, at = { x: 0, y: 0 }): void {
  const pointerInit = {
    bubbles: true,
    cancelable: true,
    button: 0,
    clientX: at.x,
    clientY: at.y,
  };
  const down = new MouseEvent('pointerdown', pointerInit);
  Object.defineProperty(down, 'isPrimary', { value: true });
  Object.defineProperty(down, 'pointerId', { value: 1 });
  const up = new MouseEvent('pointerup', pointerInit);
  Object.defineProperty(up, 'isPrimary', { value: true });
  Object.defineProperty(up, 'pointerId', { value: 1 });
  act(() => {
    pane.dispatchEvent(down);
    pane.dispatchEvent(up);
    // A browser emits `click` after the press and release land on the same
    // element, and that is the event the armed annotation tool reads. Left
    // out, this double simulated half a gesture.
    pane.dispatchEvent(new MouseEvent('click', pointerInit));
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
 * The space region root the mount is wrapped in.
 * @returns The region root.
 * @throws {Error} When the space is not mounted.
 */
function spaceRegion(): HTMLElement {
  const root = document.querySelector<HTMLElement>('[data-region="space"]');
  if (!root) throw new Error('the space region root is not mounted');
  return root;
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
 * The region root is the wrapper ProjectPage puts around the space column, and
 * the keyboard gate reads it. A press aimed at an element inside the mount
 * then resolves the way it does in the app; one aimed at `<body>` — which is
 * where `keyTarget()` lands when nothing holds focus — takes the gate's
 * `<body>` branch either way.
 * @param readOnly - Mount the space in its read-only form.
 * @returns The render result.
 */
function renderSpace(readOnly = false): ReturnType<typeof render> {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <div data-region='space'>
        <CanvasSpace projectId='p' spaceId='s' readOnly={readOnly} />
      </div>
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

  it('hands focus back to the audio panel’s tool when its reference pick exits', () => {
    // The third panel to offer Reference (#1960). The lookup reads the pick
    // table by panel, so a panel absent from it finds nothing and focus lands
    // on the body — a keyboard user Tabs from the top of the document to get
    // back to the panel they were working in.
    mockUseCanvasSpace.mockReturnValue(
      mockSpace({
        nodes: [
          {
            id: 'target',
            type: 'audio',
            position: { x: 0, y: 0 },
            data: { kind: 'audio', status: 'idle' },
          },
        ],
      }),
    );
    renderSpace();
    const tool = document.createElement('button');
    tool.setAttribute('data-testid', 'generate-audio-tool-reference');
    document.body.appendChild(tool);
    act(() => {
      useCanvasStore.getState().startReferencePick('target');
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
  // The generate panel stays on screen for the whole pick session and its
  // prompt box is a contenteditable inside the space column. Escape has no
  // native behaviour there for the field to keep, so abandoning the pick from
  // the prompt box is the same press as abandoning it from the board.
  it('Escape exits a pick session from the prompt box inside the space', () => {
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
    // The panel that carries the pick's Exit trigger stays on screen for the
    // whole session, and `onExitPick` hands focus back to it.
    const trigger = document.createElement('button');
    trigger.setAttribute('data-testid', 'generate-tool-reference');
    const prompt = document.createElement('div');
    Object.defineProperty(prompt, 'isContentEditable', { value: true });
    prompt.tabIndex = 0;
    spaceRegion().append(trigger, prompt);
    prompt.focus();
    try {
      act(() => {
        fireEvent.keyDown(prompt, { key: 'Escape' });
      });
      expect(useCanvasStore.getState().pickSession).toBeNull();
      // The reader is mid-sentence in that box; ending the pick is theirs to
      // ask for, the caret is not.
      expect(document.activeElement).toBe(prompt);
    } finally {
      prompt.remove();
      trigger.remove();
    }
  });

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

  // An overlay portals to <body>, outside both region roots, so the key
  // belongs to whoever put it there rather than to the canvas.
  it('Escape yields to an open alertdialog', () => {
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

  it('readOnly canvas tells the card its proposal was not placed', async () => {
    // The card disables its button while it waits for an answer. Dropping the
    // intent without one leaves it disabled for as long as the conversation
    // is open, and the next proposal it draws starts out waiting too.
    mockUseCanvasSpace.mockReturnValue(mockSpace());
    useCanvasStore.getState().requestNodeCreate({
      proposal: {
        nodes: [
          {
            role: 'generate',
            type: 'image',
            name: 'A still life',
            mode: 't2i',
            model: 'some-model',
            prompt: [{ text: 'a still life' }],
          },
        ],
        edges: [],
        modelNote: '',
        rationale: '',
      },
    });

    renderSpace(true);

    await waitFor(() =>
      expect(useCanvasStore.getState().pendingNodeCreate).toBeNull(),
    );
    expect(useCanvasStore.getState().proposalOutcome).toBe('failed');
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
    spaceRegion().appendChild(input);
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
    spaceRegion().appendChild(input);
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

  // ---- Pick-end focus (#168) ----
  // A pick used to end by pulling focus into the canvas container whenever
  // focus was orphaned on <body>. A pick can end without any local action —
  // a collaborator writing the host node's mode ends it — so that pull moved
  // the active region with nobody touching anything. Keyboard ownership no
  // longer reads focus, so the canvas answers the keyboard on the <body>
  // target anyway and the pull has nothing left to do.
  it('leaves focus where it is when a pick ends with focus on <body>', () => {
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
    expect(document.activeElement).toBe(document.body);
  });

  it('leaves focus where it is when a pick ends with focus already placed', () => {
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

  // ---- #2108 A12: download hands over the right-clicked node's asset ----
  // Two filled nodes on the board; the menu is opened on the second one, so
  // the address has to carry that node's content and not the other's.
  it('downloads the asset of the node the menu was opened on (#2108 A12)', () => {
    const clicked = 'https://assets.example.com/image/2026-09-13/clicked.png';
    mockUseCanvasSpace.mockReturnValue(
      mockSpace({
        nodes: [
          {
            id: 'other',
            type: 'image',
            position: { x: 0, y: 0 },
            data: {
              kind: 'image',
              status: 'idle',
              content: 'https://assets.example.com/image/2026-09-13/other.png',
            },
          },
          {
            id: 'clicked',
            type: 'image',
            position: { x: 400, y: 0 },
            data: { kind: 'image', status: 'idle', content: clicked },
          },
        ],
      }),
    );
    const started = vi
      .spyOn(downloadLib, 'triggerDownload')
      .mockImplementation(() => {});
    try {
      useCanvasStore.setState({ panelHostId: null, panelKind: null });
      renderSpace();
      const node = document.querySelector(
        '.react-flow__node[data-id="clicked"]',
      );
      act(() => {
        node?.dispatchEvent(
          new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
        );
      });
      fireEvent.click(screen.getByTestId('node-menu-download'));
      expect(started).toHaveBeenCalledTimes(1);
      expect(started.mock.calls[0]?.[0]).toBe(
        `/api/v1/assets/download?url=${encodeURIComponent(clicked)}`,
      );
    } finally {
      started.mockRestore();
      useCanvasStore.setState({ panelHostId: null, panelKind: null });
    }
  });

  // ---- #2108 A4 / A14: the item follows what the node body is showing ----
  /**
   * Right-click one node and report whether Download was usable.
   *
   * The item is on the menu either way; what changes is whether it is
   * disabled, which is how the reader is told this node has nothing to take.
   * @param data - The node's view.
   * @returns Whether the download item was enabled.
   */
  function downloadOffered(data: canvasSpace.CanvasNodeView['data']): boolean {
    mockUseCanvasSpace.mockReturnValue(
      mockSpace({
        nodes: [{ id: 'n', type: data.kind, position: { x: 0, y: 0 }, data }],
      }),
    );
    renderSpace();
    act(() => {
      document
        .querySelector('.react-flow__node[data-id="n"]')
        ?.dispatchEvent(
          new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
        );
    });
    const item = screen.getByTestId('node-menu-download');
    return !item.hasAttribute('data-disabled');
  }

  const SHOWN = 'https://assets.example.com/image/2026-09-13/a.png';

  // A6. What keeps Download away from a viewer today is that the menu never
  // opens for one — `onNodeContextMenu` returns before it is set. The
  // `!readOnly` term in `menuDownloadUrl` is the second line, for when #1958
  // lifts that return; no assertion can reach it while the first line holds.
  it('opens no node menu at all for a read-only canvas (#2108 A6)', () => {
    mockUseCanvasSpace.mockReturnValue(
      mockSpace({
        nodes: [
          {
            id: 'n',
            type: 'image',
            position: { x: 0, y: 0 },
            data: { kind: 'image', status: 'idle', content: SHOWN },
          },
        ],
      }),
    );
    useCanvasStore.setState({ panelHostId: null, panelKind: null });
    renderSpace(true);
    act(() => {
      document
        .querySelector('.react-flow__node[data-id="n"]')
        ?.dispatchEvent(
          new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
        );
    });

    expect(screen.queryByTestId('node-menu-download')).toBeNull();
    expect(screen.queryByTestId('node-menu-lock-toggle')).toBeNull();
  });

  it('offers download on a video node showing its asset (#2108 A2)', () => {
    useCanvasStore.setState({ panelHostId: null, panelKind: null });
    expect(
      downloadOffered({ kind: 'video', status: 'idle', content: SHOWN }),
    ).toBe(true);
  });

  it('offers download on an audio node showing its asset (#2108 A3)', () => {
    useCanvasStore.setState({ panelHostId: null, panelKind: null });
    expect(
      downloadOffered({ kind: 'audio', status: 'idle', content: SHOWN }),
    ).toBe(true);
  });

  it('offers no download on a node showing nothing (#2108 A4)', () => {
    useCanvasStore.setState({ panelHostId: null, panelKind: null });
    expect(downloadOffered({ kind: 'image', status: 'idle' })).toBe(false);
  });

  it('offers download on a node still showing content while a task runs (#2108 A14)', () => {
    useCanvasStore.setState({ panelHostId: null, panelKind: null });
    expect(
      downloadOffered({ kind: 'image', status: 'handling', content: SHOWN }),
    ).toBe(true);
  });

  it('offers download again once the failed node shows its content (#2108 A4)', () => {
    // The error box gives the body back while this node's task list is open
    // beside it, so the reader sees the image and can take it.
    useCanvasStore.setState({
      panelHostId: 'n',
      panelKind: 'tasks',
      taskPanelStatus: 'failed',
    });
    try {
      expect(
        downloadOffered({ kind: 'image', status: 'error', content: SHOWN }),
      ).toBe(true);
    } finally {
      useCanvasStore.setState({ panelHostId: null, panelKind: null });
    }
  });

  it('still offers no download when the open task list belongs elsewhere (#2108 A4)', () => {
    // Somebody else's list is open, so this node is still showing its error
    // box — there is nothing on screen to take.
    useCanvasStore.setState({
      panelHostId: 'somebody-else',
      panelKind: 'tasks',
      taskPanelStatus: 'failed',
    });
    try {
      expect(
        downloadOffered({ kind: 'image', status: 'error', content: SHOWN }),
      ).toBe(false);
    } finally {
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

    const attached: Element[] = [];

    afterEach(() => {
      for (const el of attached) el.remove();
      attached.length = 0;
    });

    /**
     * Attaches an element holding words, standing in for a place the reader
     * can put the caret or drag across.
     * @param region - The `data-region` to wrap it in, or null for an overlay
     * or the top bar, both of which pass through no region.
     * @returns The element holding the words.
     */
    const wordsIn = (region: string | null): Element => {
      const host = document.createElement('div');
      if (region !== null) host.setAttribute('data-region', region);
      const span = document.createElement('span');
      span.textContent = 'a highlighted reply';
      host.append(span);
      document.body.append(host);
      attached.push(host);
      return span;
    };

    /**
     * Puts focus on a fresh control inside `region`, standing in for where the
     * reader last clicked. A copy event's target follows the selection rather
     * than focus, so this is the thing the gate reads.
     * @param region - The `data-region` to wrap it in, or null for an overlay
     * or the top bar, both of which pass through no region.
     * @returns The focused control.
     */
    const focusInside = (region: string | null): HTMLElement => {
      const host = document.createElement('div');
      if (region !== null) host.setAttribute('data-region', region);
      const control = document.createElement('button');
      host.append(control);
      document.body.append(host);
      attached.push(host);
      control.focus();
      return control;
    };

    /**
     * Drags across every word in `el`, leaving a live text selection.
     * @param el - The element whose words get highlighted.
     */
    const dragAcross = (el: Element): void => {
      const range = document.createRange();
      range.selectNodeContents(el);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    };

    /**
     * Clicks once in `el` without dragging, so the caret collapses there and
     * no text ends up selected.
     * @param el - The element the caret lands in.
     */
    const clickInto = (el: Element): void => {
      const caret = document.createRange();
      caret.setStart(el.firstChild as Node, 1);
      caret.collapse(true);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(caret);
    };

    /**
     * Dispatches a copy event carrying a clipboard stub, and reports what the
     * canvas wrote to it.
     * @param from - The element the event targets; defaults to the key target.
     * @returns Whatever landed on the clipboard, empty when nothing did.
     */
    const copyAndRead = (from?: Element): string => {
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
        (from ?? keyTarget()).dispatchEvent(event);
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
      // modifier meant no match at all. Taking the key over keeps that: none
      // of these delete anything today.
      it.each([
        ['Cmd+Backspace', 'Backspace', { meta: true }],
        // Ctrl is the multi-select key on Windows and Linux
        // (`multiSelectionKeyCode = isMacOs() ? 'Meta' : 'Control'`), so it is
        // held down during ordinary canvas work there.
        ['Ctrl+Backspace', 'Backspace', { ctrl: true }],
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

      // Only the first press deletes, but every repeat still belongs to the
      // canvas, so each one is answered the way the library answered it.
      it('a repeat of the delete key leaves the event default-prevented', () => {
        mountWithSelection();
        let prevented: boolean | null = null;
        const probe = (e: Event): void => {
          prevented = e.defaultPrevented;
        };
        document.addEventListener('keydown', probe);
        dispatchKeyDown('Backspace', { repeat: true });
        document.removeEventListener('keydown', probe);
        expect(prevented).toBe(true);
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

      // Both keys delete on every platform; the Mac keyboard's key is
      // Backspace, so a suite that only presses that one leaves the other
      // untested.
      it('the Delete key removes the selected node', async () => {
        mountWithSelection();
        const { removeElements } = spyWrites();
        dispatchKeyDown('Delete');
        await waitFor(() =>
          expect(removeElements).toHaveBeenCalledWith('p', 's', ['n1'], []),
        );
      });

      // Both wires run between nodes that survive, so the selected one can
      // only be in the call because the key took it.
      it('the delete key removes the selected edges alongside the nodes', async () => {
        mountWithSelection(3);
        const { removeElements } = spyWrites();
        act(() => {
          useCanvasGraphStore
            .getState()
            .setFlowNodes((prev) =>
              prev.map((n) => ({ ...n, selected: n.id === 'n1' })),
            );
          useCanvasGraphStore.getState().setFlowEdges(() => [
            { id: 'e1', source: 'n2', target: 'n3', selected: true },
            { id: 'e2', source: 'n2', target: 'n3', selected: false },
          ]);
        });
        dispatchKeyDown('Backspace');
        await waitFor(() =>
          expect(removeElements).toHaveBeenCalledWith('p', 's', ['n1'], ['e1']),
        );
      });

      it('copy puts the selection on the clipboard', () => {
        mountWithSelection();
        expect(copyAndRead()).toContain('__breatic_canvas_nodes__:');
      });

      // Words the reader dragged across are the ones they asked for, wherever
      // they sit — either region, or an overlay and the top bar, which sit in
      // none. None of those is "copy the nodes".
      it.each([
        ['inside the agent panel', 'agent'],
        ['inside the space itself', 'space'],
        ['outside both regions', null],
      ])('copy leaves the clipboard alone for words dragged %s', (_name, region) => {
        mountWithSelection();
        const words = wordsIn(region);
        dragAcross(words);
        expect(copyAndRead(words)).toBe('');
      });

      // Dragging across a picture selects something the reader asked for
      // while `toString()` stays empty, so what counts is whether the
      // selection is collapsed.
      it('copy leaves the clipboard alone for a picture dragged across', () => {
        mountWithSelection();
        const host = document.createElement('div');
        host.append(document.createElement('img'));
        document.body.append(host);
        try {
          dragAcross(host);
          expect(window.getSelection()?.isCollapsed).toBe(false);
          expect(window.getSelection()?.toString()).toBe('');
          expect(copyAndRead(host)).toBe('');
        } finally {
          host.remove();
        }
      });

      // A click without a drag leaves a caret wherever it landed and selects
      // no text, so the event's target is a leftover that says nothing about
      // this copy. What is selected is the nodes.
      it('copy puts the nodes on the clipboard with a caret left outside both regions', () => {
        mountWithSelection();
        const words = wordsIn(null);
        clickInto(words);
        expect(copyAndRead(words)).toContain('__breatic_canvas_nodes__:');
      });

      // Each of these keys has a native meaning inside a field: Backspace
      // deletes a character, Cmd+Z undoes the typing, Cmd+D and Cmd+G are the
      // browser's own. The field sits in the space region, so the region hands
      // the press over and the field is what keeps the canvas out.
      describe('a field inside the space keeps the keys it owns', () => {
        /**
         * Puts a focused text box inside the space column.
         * @returns The focused input.
         */
        const fieldInSpace = (): HTMLInputElement => {
          const field = document.createElement('input');
          spaceRegion().append(field);
          attached.push(field);
          field.focus();
          return field;
        };

        it('the delete key removes nothing', async () => {
          mountWithSelection();
          const { removeElements } = spyWrites();
          const field = fieldInSpace();
          fireEvent.keyDown(field, { key: 'Backspace' });
          await new Promise((r) => setTimeout(r, 30));
          expect(removeElements).not.toHaveBeenCalled();
        });

        it('undo leaves the document alone', () => {
          mountWithSelection();
          const field = fieldInSpace();
          fireEvent.keyDown(field, { key: 'z', metaKey: true });
          expect(undoSpy).not.toHaveBeenCalled();
        });

        it('the duplicate shortcut creates no clone', async () => {
          mountWithSelection();
          const { addNode } = spyWrites();
          const field = fieldInSpace();
          fireEvent.keyDown(field, { key: 'd', metaKey: true });
          await new Promise((r) => setTimeout(r, 30));
          expect(addNode).not.toHaveBeenCalled();
        });

        it('the group shortcut creates no group', async () => {
          mountWithSelection(2);
          const { createGroup } = spyWrites();
          const field = fieldInSpace();
          fireEvent.keyDown(field, { key: 'g', metaKey: true });
          await new Promise((r) => setTimeout(r, 30));
          expect(createGroup).not.toHaveBeenCalled();
        });

        it('paste creates no node', async () => {
          mountWithSelection();
          const { addNode } = spyWrites();
          fieldInSpace();
          dispatchPaste('hello from clipboard');
          await new Promise((r) => setTimeout(r, 30));
          expect(addNode).not.toHaveBeenCalled();
        });
      });

      // The field sits in the space region, so the region has no quarrel with
      // this press — what keeps the canvas out is the field itself.
      it('copy leaves the clipboard alone with focus inside a field', () => {
        mountWithSelection();
        const field = document.createElement('input');
        spaceRegion().append(field);
        attached.push(field);
        field.focus();
        expect(copyAndRead()).toBe('');
      });

      // Focus is what says whether something else is already handling this
      // press. An overlay portals to <body> and the top bar sits outside both
      // columns, so neither passes through a region — the canvas keeps out of
      // a copy made while focus is in one of them, exactly as it keeps out of
      // Delete there.
      it.each([
        ['an overlay or the top bar', null, ''],
        ['the space itself', 'space', '__breatic_canvas_nodes__:'],
      ])(
        'copy with focus inside %s and nothing highlighted',
        (_name, region, expected) => {
          mountWithSelection();
          focusInside(region);
          const written = copyAndRead();
          if (expected === '') expect(written).toBe('');
          else expect(written).toContain(expected);
        },
      );

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

// What one press of Understand leaves the reader looking at (#2175). The node
// it builds lands a whole node-step to the right of the one being read, which
// on a canvas scrolled near its right edge is outside the viewport — and a
// press whose only effect is off-screen reads as a press that did nothing.
// Selecting it sets a flag and moves nothing, so the viewport is moved too.
// jsdom cannot render the ReactFlow viewport, so this pins the wiring the way
// the locate-source contract above does; what that move comes to is
// `frameBuiltNode`'s, and it has its own tests.
describe('what an Understand press leaves on screen', () => {
  const src = readFileSync(resolve(__dirname, '../CanvasSpace.tsx'), 'utf8');
  const press = src.slice(
    src.indexOf('const understandFromMenu'),
    src.indexOf('const onUploadInputChange'),
  );
  const framing = src.slice(
    src.indexOf('const frameNewNode'),
    src.indexOf('const frameNewNode') + 1200,
  );

  it('moves the viewport to the node it built, not only its selection flag', () => {
    // The call, not the name: a dependency array mentions it too, and a
    // press that only lists it moves nothing.
    expect(press).toContain('setSelectAfterCreate([id])');
    expect(press).toContain('frameNewNode(position, host.id)');
  });

  // Both boxes are read where the reader is looking right now: the source
  // from ReactFlow's own store, which folds in every parent offset, and the
  // viewport from the live transform. A grouped source read off
  // `node.position` would be measured a whole group-origin away.
  it('frames against the live viewport and the source node absolute box', () => {
    expect(framing).toContain('frameBuiltNode');
    expect(framing).toContain('positionAbsolute');
    expect(framing).toContain('rfStoreApi.getState()');
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

// The annotation tool is armed in the chrome and spent on the canvas, so the
// two halves are only joined at runtime (#1881 §6.4). Both defects below were
// found on a real board.
describe('placing a note (#1881)', () => {
  beforeEach(() => {
    mockUseCanvasSpace.mockReset();
    vi.mocked(useSocket).mockReset();
    useCanvasStore.getState().reset();
    useCurrentUserStore.getState().setUser({
      id: 'u-1',
      name: 'Ada',
      email: 'ada@example.com',
      personalStudio: null,
      membershipTier: 'base',
    });
  });

  /**
   * The transparent sheet the board wears while the tool is armed.
   * @returns The layer element.
   * @throws {Error} When the tool is armed and the layer is not there.
   */
  function dropLayer(): Element {
    const layer = document.querySelector('[data-testid="annotation-drop-layer"]');
    if (!layer) throw new Error('the drop layer is not mounted');
    return layer;
  }

  /**
   * Arm the tool and drop a note where somebody clicked.
   * @returns The rendered space.
   */
  function armAndClickTheBoard(
    at: { x: number; y: number } = { x: 0, y: 0 },
  ): ReturnType<typeof render> {
    mockUseCanvasSpace.mockReturnValue(mockSpace());
    const view = renderSpace();
    act(() => {
      useCanvasStore.getState().startAnnotationPlacement();
    });
    clickPane(dropLayer(), at);
    return view;
  }

  it('takes the pointer on the box it opens', () => {
    // ReactFlow's viewport is `pointer-events: none` and hands it back per
    // node; a ViewportPortal inherits the none. Measured on a board:
    // `elementFromPoint` over the middle of the box returned the pane, and one
    // click inside threw away what had been typed.
    armAndClickTheBoard();
    const box = screen.getByTestId('annotation-composer');
    const layer = box.closest('[data-testid="annotation-composer-layer"]');
    expect(layer?.className).toContain('pointer-events-auto');
  });

  it('types into a box the size of the sticky it becomes', () => {
    // The box hangs in the viewport portal and would otherwise scale with the
    // board, while the sticky it turns into holds one screen size at every
    // zoom (§8.7.4). At 50% somebody would write into a half-size box and
    // watch their words double the moment they pressed Enter.
    armAndClickTheBoard();
    // After mounting: the canvas mirrors ReactFlow's own zoom into the store
    // as it comes up, which would overwrite a value set before that.
    act(() => {
      useCanvasStore.getState().setZoom(0.5);
    });
    const layer = screen.getByTestId('annotation-composer-layer');
    expect(layer.style.transform).toContain('scale(2)');
  });

  it('disarms the tool when the canvas goes away', () => {
    // §6.4's transition table has a cell for this. Without it the mode
    // survives a Space switch, and the first click on the next canvas drops a
    // note box nobody asked for — reproduced on a board.
    mockUseCanvasSpace.mockReturnValue(mockSpace());
    const { unmount } = renderSpace();
    act(() => {
      useCanvasStore.getState().startAnnotationPlacement();
    });
    expect(useCanvasStore.getState().placingAnnotation).toBe(true);
    unmount();
    expect(useCanvasStore.getState().placingAnnotation).toBe(false);
  });

  it('puts the tool away on Escape, dropping nothing', () => {
    // §6.4's table: Escape while armed disarms, and that is all it does. The
    // box that opens after a drop handles its own Escape — by then the tool
    // is already down.
    mockUseCanvasSpace.mockReturnValue(mockSpace());
    renderSpace();
    act(() => {
      useCanvasStore.getState().startAnnotationPlacement();
    });
    const inside = document.createElement('div');
    inside.tabIndex = 0;
    spaceRegion().append(inside);
    inside.focus();
    try {
      act(() => {
        fireEvent.keyDown(inside, { key: 'Escape' });
      });
      expect(useCanvasStore.getState().placingAnnotation).toBe(false);
    } finally {
      inside.remove();
    }
  });

  it('hands Escape to the armed tool first, then to the open sticky', () => {
    // Two modes on this canvas take Escape and they are stacked: the tool the
    // reader picked up most recently sits over the note they opened earlier,
    // so the press puts the tool down and the next one collapses the note.
    // Both ask `useEscapeInSpace` for the same press, and it hands the press
    // to every listener that wants it — measured on a board with both
    // listening, one Escape did both. Pinned here rather than in the panel's
    // own test, which mounts no canvas and so has no armed tool to lose to.
    mockUseCanvasSpace.mockReturnValue(
      mockSpace({
        nodes: [
          {
            id: 'n-note',
            type: 'annotation',
            position: { x: 0, y: 0 },
            data: {
              kind: 'annotation',
              content: 'a cooler shot here',
              createdBy: 'u-1',
              createdAt: 1,
              replies: [],
            },
          },
        ],
      }),
    );
    renderSpace();
    act(() => {
      useCanvasStore.getState().openAnnotationPanel('n-note');
      useCanvasStore.getState().startAnnotationPlacement();
    });
    const inside = document.createElement('div');
    inside.tabIndex = 0;
    spaceRegion().append(inside);
    inside.focus();
    try {
      act(() => {
        fireEvent.keyDown(inside, { key: 'Escape' });
      });
      expect(useCanvasStore.getState().placingAnnotation).toBe(false);
      expect(useCanvasStore.getState().panelKind).toBe('annotation');
      act(() => {
        fireEvent.keyDown(inside, { key: 'Escape' });
      });
      expect(useCanvasStore.getState().panelKind).toBeNull();
    } finally {
      inside.remove();
    }
  });

  it('asks the document which notes a peer removed, not which entry point ran', () => {
    // The panel says "this note was deleted" only for somebody else's delete.
    // Answered by clearing the draft at each deleting call site, the answer
    // was a list of the callers somebody remembered, and the keyboard Delete
    // and undo were not on it; answered board-wide by "who wrote last", any
    // routine write landing in between carries it off. The document names the
    // ids instead. Asserted through the outcome rather than through the
    // getter being called, so dropping any operand of the rule shows up here.
    mockUseCanvasSpace.mockReturnValue(
      mockSpace({ deletedByPeer: () => false }),
    );
    act(() => {
      useCanvasStore.getState().openAnnotationPanel('n-mine');
      useCanvasStore.getState().setAnnotationDraft('n-mine', {
        draft: { mode: 'typing', use: 'reply', text: 'half an answer', opened: '' },
        target: null,
      });
    });
    const warnSpy = vi.spyOn(toast, 'warning').mockReturnValue('t');
    renderSpace();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(useCanvasStore.getState().panelKind).toBeNull();
    warnSpy.mockRestore();
  });

  it('takes the open box away when the right to write is taken away', () => {
    // The same half the sticky's three boxes got: the entry gate is passed at
    // the moment of arming, and a demotion walks past it with a box already
    // on screen. Enter in that box wrote a whole new note into the document.
    mockUseCanvasSpace.mockReturnValue(mockSpace());
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const view = render(
      <QueryClientProvider client={client}>
        <div data-region='space'>
          <CanvasSpace projectId='p' spaceId='s' readOnly={false} />
        </div>
      </QueryClientProvider>,
    );
    act(() => {
      useCanvasStore.getState().startAnnotationPlacement();
    });
    clickPane(dropLayer());
    expect(screen.getByTestId('annotation-composer-input')).toBeInTheDocument();

    view.rerender(
      <QueryClientProvider client={client}>
        <div data-region='space'>
          <CanvasSpace projectId='p' spaceId='s' readOnly={true} />
        </div>
      </QueryClientProvider>,
    );
    expect(screen.queryByTestId('annotation-composer-input')).toBeNull();
  });

  it('carries the viewer\'s role down to the stickies, not a stand-in', () => {
    // A6 and A8 are decided by the role that reaches a sticky, and every test
    // that covers them hands the component a role of its own. Wired to a
    // constant here, an editor would get the owner's Delete on everybody's
    // notes and nothing in the suite would move. `annotation-sticky-body-delete`
    // is the entry that carries the answer: owner-only on somebody else's.
    mockUseCanvasSpace.mockReturnValue(
      mockSpace({
        nodes: [
          {
            id: 'note',
            type: 'annotation',
            position: { x: 0, y: 0 },
            data: {
              kind: 'annotation',
              content: 'somebody else wrote this',
              createdBy: 'u-somebody-else',
              createdAt: 1,
              replies: [],
            },
          },
        ],
      }),
    );
    renderSpace();
    // This account is `u-1` (see the suite's beforeEach), so the note above is
    // not theirs. An editor gets no menu on it at all; an owner gets Delete.
    expect(screen.queryByTestId('annotation-sticky-body-menu')).toBeNull();
  });

  it('covers the board while the tool is armed, and only then', () => {
    // The comment-bubble pointer is scoped by this class (index.css). Without
    // the layer the board looks exactly the same armed as not, and nothing
    // tells the reader their next click drops a note.
    mockUseCanvasSpace.mockReturnValue(mockSpace());
    renderSpace();
    const layer = (): Element | null =>
      document.querySelector('[data-testid="annotation-drop-layer"]');
    expect(layer()).toBeNull();
    act(() => {
      useCanvasStore.getState().startAnnotationPlacement();
    });
    expect(layer()?.className).toContain('annotation-drop-layer');
    act(() => {
      useCanvasStore.getState().endAnnotationPlacement();
    });
    expect(layer()).toBeNull();
  });

  it('is the topmost thing on the board, so nothing under it is pressed', () => {
    // Three rounds, three ways the press got past a rule that named the board
    // correctly: a control inside a node stopped the click and the note went
    // nowhere; a Group, a resize grip and a multi-selection each moved under
    // an armed press with 3px of travel; xyflow's marquee ran anyway because
    // its `onPointerDownCapture` is a React synthetic handler dispatched at
    // the root, upstream of any listener here; and a press on a picture
    // started the browser's own image drag, a default action no
    // `stopPropagation` reaches. Each was answered by holding one more event
    // at one more listener, and the next round found the next one.
    //
    // None of them can begin now, because none of them is what the pointer
    // hits. That is a fact about painting, so it is pinned as one: the layer
    // is the pane's last child, fills it, and sits above everything the pane
    // stacks (the viewport at 2, the multi-selection rect at 3, the marquee
    // at 6 — base.css). jsdom does no hit testing, so the behaviour itself is
    // measured on a board (tests/smoke/canvas-annotation.spec.ts).
    mockUseCanvasSpace.mockReturnValue(mockSpace());
    renderSpace();
    act(() => {
      useCanvasStore.getState().startAnnotationPlacement();
    });
    const layer = dropLayer();
    const pane = document.querySelector('.react-flow__pane');
    if (!pane) throw new Error('the pane is not mounted');
    // Inside the pane, not the renderer: a `NodeToolbar` portals into the
    // renderer with `z-index: node.z + 1`, and the minimap is a
    // `.react-flow__panel` at 5 against the renderer's 4. The pane is
    // `position: absolute; z-index: 1`, so it is a stacking context and
    // nothing in it can rise over either.
    expect(layer.parentElement).toBe(pane);
    expect(pane.lastElementChild).toBe(layer);
    expect(layer.className).toContain('absolute');
    expect(layer.className).toContain('inset-0');
    expect(layer.className).toContain('z-10');
  });

  it('answers the right-click on the board it is covering', () => {
    // The sheet is a portal, so React dispatches its events along the React
    // tree; `.react-flow__pane` is a DOM ancestor of it but not a React one,
    // and the pane's `onContextMenu` — whose first statement is the canvas's
    // unconditional `preventDefault` — is off that path. Measured on a board:
    // idle, a right-click gave `defaultPrevented true` and the canvas's own
    // menu; armed, `false` and no menu, which is Chrome's page menu over the
    // canvas. §6.4's "点画布任意处" row says a click on the board puts the
    // tool down, and that is the answer a right-click gets — the tool goes
    // away and no note is dropped, since a right-click creates nothing
    // anywhere else on this canvas either.
    mockUseCanvasSpace.mockReturnValue(mockSpace());
    renderSpace();
    act(() => {
      useCanvasStore.getState().startAnnotationPlacement();
    });
    const menu = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      dropLayer().dispatchEvent(menu);
    });
    expect(menu.defaultPrevented).toBe(true);
    expect(useCanvasStore.getState().placingAnnotation).toBe(false);
    expect(screen.queryByTestId('annotation-composer')).toBeNull();
  });

  it('writes no note for a viewer, however the tool came to be armed', () => {
    // The only gate today is the left menu's disabled button, which is an
    // entry gate. A demotion mid-session leaves the flag up, and the drop
    // path had nothing of its own — A9 says a viewer has no way to create.
    mockUseCanvasSpace.mockReturnValue(mockSpace());
    renderSpace(true);
    act(() => {
      useCanvasStore.getState().startAnnotationPlacement();
    });
    clickPane(dropLayer());
    expect(screen.queryByTestId('annotation-composer')).toBeNull();
    expect(useCanvasStore.getState().placingAnnotation).toBe(false);
  });

  it.each([
    ['editor', ['mine']],
    ['owner', ['mine', 'theirs']],
  ] as const)(
    'hands the delete gate the person actually pressing the key: %s',
    async (role, kept) => {
      // The gate itself is thoroughly unit-tested against a viewer the test
      // built for it (`group-membership.test.ts`), so nothing observed what
      // `CanvasSpace` passes. Measured: replacing `deletingViewer` with a
      // constant `{ userId: 'anybody', role: 'owner' }` left all 7060 cases
      // green, and in the app an editor's Delete then removed somebody else's
      // note. A18 and the authorship half of A7/A8 are what is on the line,
      // and the keyboard is the path the entry's own menu cannot gate: rights
      // strip the menu item, and Delete never asks the menu.
      mockUseCanvasSpace.mockReturnValue(
        mockSpace({
          nodes: (
            [
              ['mine', 'u-1'],
              ['theirs', 'u-somebody-else'],
            ] as const
          ).map(([id, author], i) => ({
            id,
            type: 'annotation' as const,
            position: { x: i * 300, y: 0 },
            data: {
              kind: 'annotation' as const,
              content: `note ${id}`,
              createdBy: author,
              createdAt: 1,
              replies: [],
            },
          })),
        }),
      );
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      render(
        <QueryClientProvider client={client}>
          <div data-region='space'>
            <CanvasSpace
              projectId='p'
              spaceId='s'
              readOnly={false}
              myRole={role}
            />
          </div>
        </QueryClientProvider>,
      );
      act(() => {
        useCanvasGraphStore
          .getState()
          .setFlowNodes((prev) => prev.map((n) => ({ ...n, selected: true })));
      });
      const removeElements = vi.spyOn(canvasSpace, 'removeElements');
      dispatchKeyDown('Delete');
      await waitFor(() =>
        expect(removeElements).toHaveBeenCalledWith('p', 's', [...kept], []),
      );
      removeElements.mockRestore();
    },
  );

  it('yields the click to a running pick rather than dropping a note on it', () => {
    // Two exclusive canvas modes. Nothing stopped both being on, and the
    // handler order decided it by accident: the drop ran first and the pick
    // never saw the click it was waiting for.
    mockUseCanvasSpace.mockReturnValue(mockSpace());
    renderSpace();
    act(() => {
      useCanvasStore.setState({
        pickSession: { nodeId: 'host', purpose: 'reference' },
      });
      useCanvasStore.getState().startAnnotationPlacement();
    });
    // Arming puts the other mode down, so there is only ever one to spend.
    expect(useCanvasStore.getState().pickSession).toBeNull();
  });

  it('spends the armed tool on the click that places the note', () => {
    armAndClickTheBoard();
    expect(useCanvasStore.getState().placingAnnotation).toBe(false);
    expect(screen.getByTestId('annotation-composer')).toBeInTheDocument();
  });

  it.each([
    ['.react-flow', 'a panel beside the board, where the minimap sits'],
    [
      '.react-flow__renderer',
      'a floating panel over the board, where every NodeToolbar is portalled',
    ],
  ])('leaves a press on chrome in %s alone', (host, _what) => {
    // The board is `.react-flow__pane`: the viewport with the nodes and edges
    // in it, and the selection rectangle over them. Chrome sits in two places
    // and both are outside it — `.react-flow__panel` siblings hold the
    // minimap, and `NodeToolbarPortal` (@xyflow/react 12.11.2,
    // dist/esm/index.mjs:4983) portals the generate, history, task and group
    // panels into `.react-flow__renderer`, a sibling of the pane. Measured on
    // a board: the group toolbar reports `closest('.react-flow__renderer')`
    // non-null and `closest('.react-flow__pane')` null, and while the tool was
    // armed its Group button wore the comment pointer, made no group, and
    // opened a note box underneath itself.
    mockUseCanvasSpace.mockReturnValue(mockSpace());
    renderSpace();
    const parent = document.querySelector(host);
    if (!parent) throw new Error(`${host} is not mounted`);
    const chrome = document.createElement('div');
    parent.append(chrome);
    act(() => {
      useCanvasStore.getState().startAnnotationPlacement();
    });
    act(() => {
      chrome.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      );
    });
    expect(screen.queryByTestId('annotation-composer')).toBeNull();
    expect(useCanvasStore.getState().placingAnnotation).toBe(true);
  });

  it('creates the note the box was typed into, where it was dropped', async () => {
    // The tool is armed in the chrome and spent here, and the node exists only
    // once Enter lands, so this join is the whole of A1 and it is made at
    // runtime. Without it the composer can stop creating anything and the
    // suite stays green — measured: emptying `createAnnotationAt` left all
    // 137 cases passing.
    const written = vi
      .spyOn(canvasSpace, 'addNode')
      .mockImplementation(() => undefined);
    armAndClickTheBoard({ x: 137, y: 241 });
    const box = screen.getByTestId('annotation-composer-input');
    fireEvent.change(box, { target: { value: 'a cooler shot here' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(written).toHaveBeenCalledTimes(1));
    const node = written.mock.calls[0][2] as unknown as {
      type: string;
      position: { x: number; y: number };
      data: { kind: string; content: string; createdBy: string };
    };
    expect(node.type).toBe('annotation');
    expect(node.data.content).toBe('a cooler shot here');
    expect(node.data.createdBy).toBe('u-1');
    // Where it was dropped, which is half of "anywhere on the canvas" and was
    // the half nothing held: replacing the coordinate with a constant left all
    // 146 cases passing. jsdom reports a zero-sized container at the origin
    // and the viewport starts untransformed, so the flow point is the client
    // point.
    expect(node.position).toEqual({ x: 137, y: 241 });
    written.mockRestore();
  });

  it('asks for every name on the board at once, not once per sticky', async () => {
    // Measured on a board of ten stickies: ten `GET /users` for what one
    // request answers, and each one a separate cache entry, so a name shared
    // by two stickies was fetched twice and could arrive at different times.
    getUsersByIds.mockClear();
    mockUseCanvasSpace.mockReturnValue(
      mockSpace({
        nodes: [
          {
            id: 'a1',
            type: 'annotation',
            position: { x: 0, y: 0 },
            data: {
              kind: 'annotation',
              content: 'a cooler shot here',
              createdBy: 'u-1',
              createdAt: 1,
              replies: [
                { id: 'r1', content: 'agreed', createdBy: 'u-2', createdAt: 2 },
              ],
            },
          },
          {
            id: 'a2',
            type: 'annotation',
            position: { x: 300, y: 0 },
            data: {
              kind: 'annotation',
              content: 'and slower',
              createdBy: 'u-3',
              createdAt: 3,
              replies: [],
            },
          },
        ],
      }),
    );
    renderSpace();
    await waitFor(() => expect(getUsersByIds).toHaveBeenCalledTimes(1));
    expect(getUsersByIds).toHaveBeenCalledWith(['u-1', 'u-2', 'u-3']);
  });

  it('forgets a note box when this canvas goes away under it', () => {
    // A box outlives the sticky's DOM on purpose — the canvas culls offscreen
    // nodes and a draft held in the component went with them (#1881 E7). What
    // ends it is the sticky closing, and a Space switch closes it by taking
    // the whole canvas away (§8.7.3's 「切 Space / 组件卸载」 row). Measured
    // before this: the draft was swept on the next mount, one frame before the
    // graph mirror refilled, so the reader came back to a sticky drawn open
    // over words that were already gone.
    mockUseCanvasSpace.mockReturnValue(
      mockSpace({
        nodes: [
          {
            id: 'n-note',
            type: 'annotation',
            position: { x: 0, y: 0 },
            data: {
              kind: 'annotation',
              content: 'a cooler shot here',
              createdBy: 'u-1',
              createdAt: 1,
              replies: [],
            },
          },
        ],
      }),
    );
    act(() => {
      useCanvasStore.getState().openAnnotationPanel('n-note');
      useCanvasStore.getState().setAnnotationDraft('n-note', {
        draft: { mode: 'typing', use: 'reply', text: 'half an answer', opened: '' },
        target: null,
      });
    });
    const view = renderSpace();
    expect(useCanvasStore.getState().annotationDrafts['n-note']).toBeDefined();
    view.unmount();
    expect(useCanvasStore.getState().annotationDrafts['n-note']).toBeUndefined();
    expect(useCanvasStore.getState().panelKind).toBeNull();
  });
});

describe('the camera this Space is left on (#2165)', () => {
  const VIEWER = 'u-camera';
  const KEY = 'breatic.projectTabs';

  /** Seed a strip holding this Space, so a camera written has somewhere to go. */
  const seedStrip = (viewport: unknown = null): void => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({
        [VIEWER]: { p: { tabs: [{ spaceId: 's', viewport }], activeId: 's' } },
      }),
    );
  };

  /** The camera stored for this Space, as the record holds it. */
  const storedCamera = (): unknown => {
    const raw = window.localStorage.getItem(KEY);
    if (raw === null) return null;
    const record = JSON.parse(raw) as Record<
      string,
      Record<string, { tabs: Array<{ spaceId: string; viewport: unknown }> }>
    >;
    return (
      record[VIEWER]?.p?.tabs.find((t) => t.spaceId === 's')?.viewport ?? null
    );
  };

  beforeEach(() => {
    act(() => {
      useCurrentUserStore.setState({
        user: { id: VIEWER } as never,
        bootstrapped: true,
      });
    });
  });

  // The canvas frames a Space it has nothing stored for, and that framing is
  // queued until the nodes have measured. Leaving inside that window used to
  // store the untouched identity transform, which reads back as a camera the
  // reader chose and turns the framing off for good. Measured in a browser:
  // the window is 118ms on a Space with 61 nodes.
  it('stores nothing when the canvas is left before it has framed anything', () => {
    seedStrip(null);
    mockUseCanvasSpace.mockReturnValue(
      mockSpace({
        nodes: [
          {
            id: 'n-1',
            type: 'image',
            position: { x: 900, y: 700 },
            data: { kind: 'image', status: 'idle' },
          },
        ],
      }),
    );
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const view = render(
      <QueryClientProvider client={client}>
        <CanvasSpace projectId='p' spaceId='s' />
      </QueryClientProvider>,
    );
    view.unmount();
    expect(storedCamera()).toBeNull();
  });

  // The other half: a Space the reader has a camera for opens on it, and
  // leaving without touching anything leaves that camera as it was.
  it('leaves a stored camera alone when the reader does not move it', () => {
    seedStrip({ x: -120, y: -80, zoom: 1.5 });
    mockUseCanvasSpace.mockReturnValue(mockSpace({ nodes: [] }));
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const view = render(
      <QueryClientProvider client={client}>
        <CanvasSpace projectId='p' spaceId='s' />
      </QueryClientProvider>,
    );
    view.unmount();
    expect(storedCamera()).toEqual({ x: -120, y: -80, zoom: 1.5 });
  });
  // The other direction, which the two above cannot see: a camera the reader
  // placed reaches the record. `onMove` is what opens the gate, and the library
  // reports it from the second event of a scroll onwards
  // (@xyflow/system `createPanOnScrollHandler`), so the pan here is two.
  it('stores the camera once the reader has moved it', async () => {
    seedStrip(null);
    mockUseCanvasSpace.mockReturnValue(mockSpace({ nodes: [] }));
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const view = render(
      <QueryClientProvider client={client}>
        <CanvasSpace projectId='p' spaceId='s' />
      </QueryClientProvider>,
    );
    const pane = document.querySelector('.react-flow__pane') as Element;
    await act(async () => {
      fireEvent.wheel(pane, { deltaX: 0, deltaY: 120 });
      fireEvent.wheel(pane, { deltaX: 0, deltaY: 120 });
    });
    view.unmount();
    expect(storedCamera()).not.toBeNull();
  });

  // The restore side: a Space with a camera opens on it rather than framing.
  it('opens on the camera it has stored', () => {
    seedStrip({ x: -300, y: -200, zoom: 2 });
    mockUseCanvasSpace.mockReturnValue(mockSpace({ nodes: [] }));
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <CanvasSpace projectId='p' spaceId='s' />
      </QueryClientProvider>,
    );
    const viewport = document.querySelector(
      '.react-flow__viewport',
    ) as HTMLElement;
    expect(viewport.style.transform).toBe('translate(-300px,-200px) scale(2)');
  });
});
