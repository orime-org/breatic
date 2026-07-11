// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Mock the Yjs binding so the component test never opens a real WebSocket
// (useCanvasSpace → useSocket → HocuspocusProvider). The write helpers
// (addEdge / removeNode / setNodePosition / addNode) keep their real
// implementations so we can spy on the actual write path.
vi.mock('@web/data/yjs/canvas-space', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@web/data/yjs/canvas-space')>();
  return { ...actual, useCanvasSpace: vi.fn() };
});

import { CanvasSpace } from '@web/spaces/canvas/CanvasSpace';
import * as canvasSpace from '@web/data/yjs/canvas-space';
import { serializeNodes } from '@web/spaces/canvas/node-clipboard';
import { useCanvasStore } from '@web/stores';
import { useCurrentUserStore } from '@web/stores/current-user';
import { assetsApi } from '@web/data/api';
import { useSpaceOperationsStore } from '@web/stores/space-operations';

const mockUseCanvasSpace = vi.mocked(canvasSpace.useCanvasSpace);

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
    ...over,
  };
}

/**
 * Dispatch a `keydown` on the document so the canvas history shortcut handler
 * (a document-level listener) sees it.
 * @param key - The `KeyboardEvent.key` value.
 * @param mods - Modifier flags (meta = mac Cmd, ctrl = windows Ctrl).
 */
function dispatchKeyDown(
  key: string,
  mods: { meta?: boolean; ctrl?: boolean; shift?: boolean } = {},
): void {
  act(() => {
    document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key,
        metaKey: mods.meta ?? false,
        ctrlKey: mods.ctrl ?? false,
        shiftKey: mods.shift ?? false,
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
    document.dispatchEvent(event);
  });
}

describe('CanvasSpace (ReactFlow mount)', () => {
  beforeEach(() => {
    mockUseCanvasSpace.mockReset();
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
    });
  });

  it('shows the empty-state hint when there are no nodes', () => {
    mockUseCanvasSpace.mockReturnValue(mockSpace());
    render(<CanvasSpace projectId='p' spaceId='s' />);
    expect(screen.getByTestId('canvas-space')).toBeInTheDocument();
    expect(screen.getByTestId('canvas-empty')).toBeInTheDocument();
  });

  // Figma-like interaction: the left-button drag marquee-selects rather than
  // pans, so ReactFlow's pane must NOT carry the `draggable` class (which it
  // only adds when panOnDrag enables the left button).
  it('left-button drag selects instead of panning (pane is not draggable)', () => {
    mockUseCanvasSpace.mockReturnValue(mockSpace());
    render(<CanvasSpace projectId='p' spaceId='s' />);
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
    render(<CanvasSpace projectId='p' spaceId='s' />);
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
    render(<CanvasSpace projectId='p' spaceId='s' />);
    expect(screen.getByTestId('image-node')).toBeInTheDocument();
    expect(screen.queryByTestId('canvas-empty')).not.toBeInTheDocument();
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
    render(<CanvasSpace projectId='p' spaceId='s' readOnly />);
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
    render(<CanvasSpace projectId='p' spaceId='s' />);
    const node = document.querySelector('.react-flow__node');
    expect(node).not.toBeNull();
    expect(node?.className).toContain('draggable');
  });

  // Connection rules in reference-pick mode (spec §9.1, user 2026-07-10): an
  // image node's input accepts only image / text sources, so while picking
  // references for an image node, an audio / video node must be dimmed +
  // non-pickable exactly like an already-wired node — not glowing as if it
  // were selectable and then dead-ending at execute time.
  it('pick mode dims type-incompatible sources (audio/video) and keeps image/text selectable', () => {
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
            data: { kind: 'audio', content: 'a.mp3', status: 'idle' },
          },
          {
            id: 'src-text',
            type: 'text',
            position: { x: 600, y: 0 },
            data: { kind: 'text', content: 'hello', status: 'idle' },
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
    render(<CanvasSpace projectId='p' spaceId='s' />);
    // Enter pick mode directly — the overlay keys off referencePickForNodeId
    // alone (opening the real panel would drag in the models useQuery, which
    // needs a QueryClientProvider this mount doesn't have).
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
            data: { kind: 'image', status: 'idle' },
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
        generatePanelNodeId: 'target',
        referencePickForNodeId: 'target',
      });
    });
    const pane = document.querySelector('.react-flow__pane');
    expect(pane).not.toBeNull();
    // With selectionOnDrag (our Figma-like left-drag marquee) ReactFlow routes
    // pane clicks through pointerdown→pointerup, not the click event.
    clickPane(pane as Element);
    expect(useCanvasStore.getState().generatePanelNodeId).toBe('target');
    expect(useCanvasStore.getState().referencePickForNodeId).toBe('target');
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
        generatePanelNodeId: 'target',
        referencePickForNodeId: null,
      });
    });
    const pane = document.querySelector('.react-flow__pane');
    expect(pane).not.toBeNull();
    clickPane(pane as Element);
    expect(useCanvasStore.getState().generatePanelNodeId).toBeNull();
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

    render(<CanvasSpace projectId='p' spaceId='s' readOnly />);

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

    render(<CanvasSpace projectId='p' spaceId='s' />);

    await waitFor(() => expect(addNode).toHaveBeenCalledTimes(1));
    expect(addNode.mock.calls[0][2].type).toBe('image');
    addNode.mockRestore();
  });

  it('paste plain text creates a text node carrying the pasted text', () => {
    mockUseCanvasSpace.mockReturnValue(mockSpace());
    const addNode = vi
      .spyOn(canvasSpace, 'addNode')
      .mockImplementation(() => undefined);
    render(<CanvasSpace projectId='p' spaceId='s' />);

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
    render(<CanvasSpace projectId='p' spaceId='s' />);

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
    render(<CanvasSpace projectId='p' spaceId='s' readOnly />);

    dispatchPaste('text while read-only');

    expect(addNode).not.toHaveBeenCalled();
    addNode.mockRestore();
  });

  it('paste while a field is focused is left to the browser (no node created)', () => {
    mockUseCanvasSpace.mockReturnValue(mockSpace());
    const addNode = vi
      .spyOn(canvasSpace, 'addNode')
      .mockImplementation(() => undefined);
    render(<CanvasSpace projectId='p' spaceId='s' />);
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
    render(<CanvasSpace projectId='p' spaceId='s' />);
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
    render(<CanvasSpace projectId='p' spaceId='s' readOnly />);
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
    render(<CanvasSpace projectId='p' spaceId='s' />);
    expect(useCanvasStore.getState().canUndo).toBe(true);
    expect(useCanvasStore.getState().canRedo).toBe(false);
  });

  it('consumes an undo command posted by the chrome toolbar (chrome → canvas mailbox)', async () => {
    mockUseCanvasSpace.mockReturnValue(mockSpace({ canUndo: true }));
    useCanvasStore.getState().requestHistoryCommand('undo');
    render(<CanvasSpace projectId='p' spaceId='s' />);
    await waitFor(() =>
      expect(useCanvasStore.getState().pendingHistoryCommand).toBeNull(),
    );
    expect(undoSpy).toHaveBeenCalledTimes(1);
    expect(redoSpy).not.toHaveBeenCalled();
  });

  it('Cmd+Z (mac) triggers undo; Cmd+Shift+Z triggers redo', () => {
    mockUseCanvasSpace.mockReturnValue(mockSpace({ canUndo: true, canRedo: true }));
    render(<CanvasSpace projectId='p' spaceId='s' />);

    dispatchKeyDown('z', { meta: true });
    expect(undoSpy).toHaveBeenCalledTimes(1);

    dispatchKeyDown('z', { meta: true, shift: true });
    expect(redoSpy).toHaveBeenCalledTimes(1);
  });

  it('Ctrl+Z (windows) triggers undo; Ctrl+Y triggers redo', () => {
    mockUseCanvasSpace.mockReturnValue(mockSpace({ canUndo: true, canRedo: true }));
    render(<CanvasSpace projectId='p' spaceId='s' />);

    dispatchKeyDown('z', { ctrl: true });
    expect(undoSpy).toHaveBeenCalledTimes(1);

    dispatchKeyDown('y', { ctrl: true });
    expect(redoSpy).toHaveBeenCalledTimes(1);
  });

  it('keyboard undo is a no-op while a field is focused (input native undo wins)', () => {
    mockUseCanvasSpace.mockReturnValue(mockSpace({ canUndo: true }));
    render(<CanvasSpace projectId='p' spaceId='s' />);
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
    render(<CanvasSpace projectId='p' spaceId='s' readOnly />);

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
    render(<CanvasSpace projectId='p' spaceId='s' />);

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
});

// Reference-pick mode cursor contract (canvas item 7, user 2026-07-10).
// jsdom does not resolve the CSS cascade for `cursor`, so the browser smoke
// (2026-07-10) is the real proof the dimmed node shows not-allowed. This guard
// pins the *specificity* that the smoke exposed: ReactFlow ships
// `.react-flow__node.draggable { cursor: grab }` (0,2,0), so the pick-mode
// cursor rules MUST stay scoped under `.react-flow .react-flow__node` (0,3,0)
// or the dimmed node silently keeps grab instead of not-allowed. A future
// "simplification" back to a bare `.canvas-pick-dimmed` selector regresses it.
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

  it('keeps the breathing glow on the selectable hover state (functional cue)', () => {
    expect(css).toContain(
      '.react-flow .react-flow__node.canvas-pick-selectable:hover',
    );
    expect(css).toContain('animation: canvas-pick-glow');
    expect(css).toContain('@keyframes canvas-pick-glow');
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
