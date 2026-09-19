// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { ReactFlowProvider, useStoreApi, type NodeProps } from '@xyflow/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import type * as Y from 'yjs';

import { _resetForTests } from '@web/data/yjs/manager';
import { addNode, getTextBody } from '@web/data/yjs/canvas-space';
import { writePlainTextIntoBody } from '@breatic/shared';
import { TooltipProvider } from '@web/components/ui/tooltip';
import { CanvasActionsContext } from '@web/spaces/canvas/canvas-actions';
import { CanvasContext } from '@web/spaces/canvas/canvas-context';
import { FLOW_NODE_TYPES } from '@web/spaces/canvas/nodes/flow-node-types';
import { useCanvasStore } from '@web/stores/canvas';
import type { AnnotationNodeView } from '@web/data/yjs/node-view';
import { NODE_KIND_LIST } from '@web/spaces/canvas/nodes/registry';
import type { TextNodeView } from '@web/data/yjs/node-view';

const PID = 'p1';
const SID = 's1';

describe('FLOW_NODE_TYPES', () => {
  it('exposes a ReactFlow component for every node kind', () => {
    NODE_KIND_LIST.forEach((kind) => {
      expect(typeof FLOW_NODE_TYPES[kind]).toBe('function');
    });
  });

  it('keys match the registry kind list exactly', () => {
    expect(Object.keys(FLOW_NODE_TYPES).sort()).toEqual(
      [...NODE_KIND_LIST].sort(),
    );
  });

  // Critical path (collaborative rename): the flow wrapper is the only layer
  // that knows ReactFlow's node id, so it must bind the header's rename to
  // `renameNode(thisNodeId, name)`. Proves the id reaches the canvas action.
  it('binds the name header rename to the node id via CanvasActions', () => {
    const renameNode = vi.fn();
    const Text = FLOW_NODE_TYPES.text;
    const data: TextNodeView = {
      kind: 'text',
      status: 'idle',
      name: 'Old',
    };
    render(
      <ReactFlowProvider>
        <CanvasActionsContext.Provider value={{ renameNode, deleteEdge: () => undefined,
          deleteNode: () => undefined, activateNodeUpload: () => undefined, commitGroupResize: () => undefined,
          reportGroupResize: () => undefined, beginGroupResize: () => undefined, }}>
          <Text {...({ id: 'n1', data, selected: false } as unknown as NodeProps)} />
        </CanvasActionsContext.Provider>
      </ReactFlowProvider>,
    );
    fireEvent.doubleClick(screen.getByTestId('node-header-name'));
    const input = screen.getByTestId('node-header-input');
    fireEvent.change(input, { target: { value: 'Renamed' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(renameNode).toHaveBeenCalledWith('n1', 'Renamed');
  });

  // §3.7.2 traded the node's concrete failure reason and its Retry button away
  // on the condition that the box carry a way to the list where both now live.
  // The wrapper is the only layer that knows this node's id, so it is the one
  // that can bind it.
  it('gives the error box a way into this node’s task list', () => {
    renderImage({
      kind: 'image',
      status: 'error',
      name: 'N',
      taskCounts: { running: 0, done: 0, failed: 1, expired: 0 },
    });

    expect(
      screen.getByTestId('node-content-view-tasks'),
    ).toBeInTheDocument();
  });

  // `deriveStatus` puts the error box up for `expired` as readily as for
  // `failed`, so the box's way in has to lead somewhere for both. The list
  // shows one state at a time; sending this reader to `failed` shows an empty
  // one.
  it('opens the expired list when that is the node’s only failure', () => {
    renderImage({
      kind: 'image',
      status: 'error',
      name: 'N',
      taskCounts: { running: 0, done: 0, failed: 0, expired: 1 },
    });

    fireEvent.click(screen.getByTestId('node-content-view-tasks'));

    expect(useCanvasStore.getState().taskPanelStatus).toBe('expired');
  });

  // Text this browser could not extract writes `errorMessage` and opens no
  // task at all (§3.7.4), so the box has no list to lead to.
  it('offers no way in when the node carries no failed task', () => {
    renderImage({
      kind: 'image',
      status: 'error',
      name: 'N',
      errorMessage: 'could not read this file',
      taskCounts: { running: 0, done: 0, failed: 0, expired: 0 },
    });

    expect(screen.queryByTestId('node-content-view-tasks')).toBeNull();
  });

  // xyflow starts a node drag one pixel into a press, so a count without
  // `nodrag` slides the node under the cursor and writes a new position into
  // the shared document while the user is opening a list.
  it('keeps a press on the counts from dragging the node', () => {
    renderImage({
      kind: 'image',
      status: 'idle',
      name: 'N',
      content: 'https://cdn.invalid/a.png',
      taskCounts: { running: 1, done: 0, failed: 0, expired: 0 },
    });

    // Asked for by the class rather than by counting levels: what matters is
    // that a press on a count lands inside a `nodrag`, whatever the wrapping
    // above it looks like.
    expect(
      screen.getByTestId('task-count-running').closest('.nodrag'),
    ).not.toBeNull();
  });

  it('lets the pane have the strip back when a node carries no task', () => {
    // A node nobody has uploaded to draws no column at all, so the strip
    // beside it is bare canvas: a marquee or a pane drag can begin in it.
    renderImage({
      kind: 'image',
      status: 'idle',
      name: 'N',
      content: 'https://cdn.invalid/a.png',
    });

    expect(screen.queryByTestId('node-task-counts')).not.toBeInTheDocument();
    expect(screen.queryAllByTestId(/^task-count-/)).toHaveLength(0);
  });

  // Critical path (collaborative text edit): the flow wrapper is the only layer
  // that knows ReactFlow's node id, and a text node needs it to find its own
  // body among all the bodies on the board. This used to be proved through the
  // inline-edit commit, which no longer exists — the editor writes to the
  // shared fragment directly — so it is proved where the id now travels: the
  // node renders ITS body and not a neighbour's.
  it('gives a text node the id it needs to find its own body', () => {
    _resetForTests();
    for (const [id, text] of [
      ['n1', 'belongs to n1'],
      ['n2', 'belongs to n2'],
    ] as ReadonlyArray<readonly [string, string]>) {
      addNode(PID, SID, {
        id,
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
      writePlainTextIntoBody(getTextBody(PID, SID, id) as Y.XmlFragment, text);
    }

    const Text = FLOW_NODE_TYPES.text;
    const data: TextNodeView = { kind: 'text', status: 'idle', name: 'N' };
    render(
      <ReactFlowProvider>
        <CanvasContext.Provider
          value={{
            projectId: PID,
            spaceId: SID,
            readOnly: false,
            myRole: 'editor',
            caretProvider: null,
          }}
        >
          <Text {...({ id: 'n2', data, selected: false } as unknown as NodeProps)} />
        </CanvasContext.Provider>
      </ReactFlowProvider>,
    );

    expect(screen.getByTestId('text-node-body')).toHaveTextContent('belongs to n2');
  });

  // Both connection handles must paint ABOVE the node body, else the one
  // rendered BEFORE the body has its inner half covered by the body's surface
  // and reads as a half-circle (the reported left-handle bug). Absolutely-
  // positioned siblings paint in DOM order, so both handles must come AFTER the
  // body. Also pins the handle styling back to the original neutral dot.
  it('renders both handles after the node body (painted on top) in the original neutral style (#1)', () => {
    const Text = FLOW_NODE_TYPES.text;
    const data: TextNodeView = {
      kind: 'text',
      status: 'idle',
      name: 'N',
    };
    const { container } = render(
      <ReactFlowProvider>
        <CanvasActionsContext.Provider
          value={{ renameNode: vi.fn(), deleteEdge: vi.fn(),
            deleteNode: vi.fn(), activateNodeUpload: vi.fn(), commitGroupResize: vi.fn(),
            reportGroupResize: vi.fn(), beginGroupResize: vi.fn(), }}
        >
          <Text {...({ id: 'n1', data, selected: false } as unknown as NodeProps)} />
        </CanvasActionsContext.Provider>
      </ReactFlowProvider>,
    );
    const handles = container.querySelectorAll('.react-flow__handle');
    expect(handles.length).toBe(2);
    const body = screen.getByTestId('text-node');
    handles.forEach((handle) => {
      // FOLLOWING is set when `handle` comes after `body` in document order.
      expect(
        body.compareDocumentPosition(handle) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      // Magnetic handle (user 2026-07-11): the anchor ELEMENT is invisible
      // (its center is the edge attachment); the visible neutral dot is a
      // child span, and the 36px hit zone is the ::before. Full geometry +
      // spring behavior are covered in MagneticHandle.test.tsx.
      expect(handle.className).toContain('!bg-transparent');
      expect(handle.className).toContain('before:absolute');
      const dot = handle.querySelector('[data-testid="handle-dot"]');
      expect(dot?.className).toContain('border-border');
      expect(dot?.className).toContain('bg-muted');
    });
  });

  // nodesConnectable (viewer backstop + pick-session connect gate) flows
  // store → NodeWrapper → the node component's isConnectable prop — and DIES
  // there unless the component forwards it to <Handle>, whose own default is
  // TRUE (adversarial round-1 HIGH: handles stayed live during a pick).
  it('forwards isConnectable to both handles (false disables their connectable state)', () => {
    const Text = FLOW_NODE_TYPES.text;
    const data: TextNodeView = {
      kind: 'text',
      status: 'idle',
      name: 'N',
    };
    const { container } = render(
      <ReactFlowProvider>
        <CanvasActionsContext.Provider
          value={{ renameNode: vi.fn(), deleteEdge: vi.fn(),
            deleteNode: vi.fn(), activateNodeUpload: vi.fn(), commitGroupResize: vi.fn(),
            reportGroupResize: vi.fn(), beginGroupResize: vi.fn(), }}
        >
          <Text
            {...({
              id: 'n1',
              data,
              selected: false,
              isConnectable: false,
            } as unknown as NodeProps)}
          />
        </CanvasActionsContext.Provider>
      </ReactFlowProvider>,
    );
    const handles = container.querySelectorAll('.react-flow__handle');
    expect(handles.length).toBe(2);
    handles.forEach((handle) => {
      expect(handle.className).not.toContain('connectable');
    });
  });

  // Bug 7: a Group is a container (Figma-Frame-style), not an edge endpoint —
  // it must render NO connection handles. The generic wrapper paints Left/Right
  // handles for content nodes; for a group they are wrong (you don't draw a
  // scissor edge to a frame) and the Left handle sat on the group's left edge,
  // interfering with the left resize grab.
  it('renders NO connection handles for a group node (Bug 7)', () => {
    const Group = FLOW_NODE_TYPES.group;
    const data = {
      kind: 'group',
      name: 'G',
      groupMinWidth: 40,
      groupMinHeight: 40,
    };
    const { container } = render(
      <ReactFlowProvider>
        <CanvasActionsContext.Provider
          value={{ renameNode: vi.fn(), deleteEdge: vi.fn(),
            deleteNode: vi.fn(), activateNodeUpload: vi.fn(), commitGroupResize: vi.fn(),
            reportGroupResize: vi.fn(), beginGroupResize: vi.fn(), }}
        >
          <Group {...({ id: 'g1', data, selected: true } as unknown as NodeProps)} />
        </CanvasActionsContext.Provider>
      </ReactFlowProvider>,
    );
    expect(container.querySelectorAll('.react-flow__handle').length).toBe(0);
  });

  it('renders NO resize controls for a selected group with empty bounds (read-only viewer)', () => {
    const Group = FLOW_NODE_TYPES.group;
    // A read-only viewer gets groupResizeBounds: [] (CanvasSpace renderNodes),
    // so the group shows no resize handles even though it is selected.
    const data = { kind: 'group', name: 'G', groupResizeBounds: [] };
    const { container } = render(
      <ReactFlowProvider>
        <CanvasActionsContext.Provider
          value={{ renameNode: vi.fn(), deleteEdge: vi.fn(),
            deleteNode: vi.fn(), activateNodeUpload: vi.fn(), commitGroupResize: vi.fn(),
            reportGroupResize: vi.fn(), beginGroupResize: vi.fn(), }}
        >
          <Group {...({ id: 'g1', data, selected: true } as unknown as NodeProps)} />
        </CanvasActionsContext.Provider>
      </ReactFlowProvider>,
    );
    expect(container.querySelectorAll('.react-flow__resize-control').length).toBe(0);
  });

  it('renders resize controls for a selected unlocked group that has bounds (editor)', () => {
    const Group = FLOW_NODE_TYPES.group;
    const bounds = [
      'right', 'left', 'bottom', 'top',
      'top-left', 'top-right', 'bottom-left', 'bottom-right',
    ].map((position) => ({ position, minWidth: 40, minHeight: 40 }));
    const data = { kind: 'group', name: 'G', groupResizeBounds: bounds };
    const { container } = render(
      <ReactFlowProvider>
        <CanvasActionsContext.Provider
          value={{ renameNode: vi.fn(), deleteEdge: vi.fn(),
            deleteNode: vi.fn(), activateNodeUpload: vi.fn(), commitGroupResize: vi.fn(),
            reportGroupResize: vi.fn(), beginGroupResize: vi.fn(), }}
        >
          <Group {...({ id: 'g1', data, selected: true } as unknown as NodeProps)} />
        </CanvasActionsContext.Provider>
      </ReactFlowProvider>,
    );
    expect(container.querySelectorAll('.react-flow__resize-control').length).toBe(8);
    // The controls have to paint after the body. An edge line is 1px wide and
    // centred on the border, and `left` / `top` centre theirs on coordinate 0 —
    // which the body's own box still covers, so painting them first hands every
    // press on those two edges to the body and the grab drags the whole Group.
    const body = container.querySelector('[data-testid="group-node"]');
    const control = container.querySelector('.react-flow__resize-control');
    expect(body).not.toBeNull();
    expect(control).not.toBeNull();
    expect(
      (body as Element).compareDocumentPosition(control as Element) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeGreaterThan(0);
  });

  // The wrapper is the only layer with the ReactFlow store, so it must feed
  // the canvas zoom down so the name header can counter-scale to a constant
  // screen size. Proves the counter-scaled anchor is wired for content nodes.
  it('feeds the canvas zoom so the content node renders a counter-scaled header anchor', () => {
    const Text = FLOW_NODE_TYPES.text;
    const data: TextNodeView = {
      kind: 'text',
      status: 'idle',
      name: 'Old',
    };
    render(
      <ReactFlowProvider>
        <CanvasActionsContext.Provider value={{ renameNode: vi.fn(), deleteEdge: vi.fn(),
          deleteNode: vi.fn(), activateNodeUpload: vi.fn(), commitGroupResize: vi.fn(),
          reportGroupResize: vi.fn(), beginGroupResize: vi.fn(), }}>
          <Text {...({ id: 'n1', data, selected: false } as unknown as NodeProps)} />
        </CanvasActionsContext.Provider>
      </ReactFlowProvider>,
    );
    const anchor = screen.getByTestId('node-header-anchor');
    expect(anchor.style.transform).toContain('scale(');
  });

  // Empty media node double-click = open the canvas file picker for THIS node.
  // The wrapper is the only layer that knows the node id + modality, so it binds
  // onActivate to activateNodeUpload(id, modality) — proves the upload entry is
  // wired (the canvas owns the picker; only image / video / audio upload here).
  it('media node empty-state double-click triggers the canvas upload for THIS node + modality', () => {
    const activateNodeUpload = vi.fn();
    const Image = FLOW_NODE_TYPES.image;
    render(
      <ReactFlowProvider>
        <CanvasActionsContext.Provider
          value={{ renameNode: vi.fn(), deleteEdge: vi.fn(),
            deleteNode: vi.fn(), activateNodeUpload, commitGroupResize: vi.fn(),
            reportGroupResize: vi.fn(), beginGroupResize: vi.fn(), }}
        >
          <Image
            {...({
              id: 'n1',
              data: { kind: 'image', content: '', status: 'idle', name: 'N' },
              selected: false,
            } as unknown as NodeProps)}
          />
        </CanvasActionsContext.Provider>
      </ReactFlowProvider>,
    );
    fireEvent.doubleClick(screen.getByTestId('node-placeholder'));
    expect(activateNodeUpload).toHaveBeenCalledWith('n1', 'image');
  });

  it('gives a sticky no handles at all', () => {
    // A sticky is about the canvas, never an input to it, so there is nothing
    // to wire into or out of (#1881 §8.5). Drawing handles and then refusing
    // the drop offered a control that always said no.
    const Annotation = FLOW_NODE_TYPES.annotation;
    const data: AnnotationNodeView = {
      kind: 'annotation',
      content: 'a cooler shot here',
      createdBy: 'u1',
      createdAt: 1,
      replies: [],
    };
    const { container } = render(
      <ReactFlowProvider>
        <QueryClientProvider
          client={
            new QueryClient({ defaultOptions: { queries: { retry: false } } })
          }
        >
          <Annotation
            {...({ id: 'a1', data, selected: false } as unknown as NodeProps)}
          />
        </QueryClientProvider>
      </ReactFlowProvider>,
    );
    expect(container.querySelectorAll('.react-flow__handle')).toHaveLength(0);
  });
});

/**
 * The zoom at which one cell still measures the smallest a target may be:
 * 26 screen px at the counter-scale floor of 0.5, so `26 × 2 × zoom === 24`.
 * Written as the fraction it is — `0.4615` is 23.998 px, which is the other
 * side of this boundary.
 */
const CELL_AT_MIN_TARGET = 24 / 52;

/** Captures the xyflow store api so a test can set the canvas zoom. */
let storeApi: ReturnType<typeof useStoreApi> | null = null;

/**
 * Grabs the xyflow store api into `storeApi` (rendered inside the provider).
 * @returns Nothing.
 */
function StoreGrabber(): null {
  storeApi = useStoreApi();
  return null;
}

/**
 * Render one image node through the wrapper.
 * @param data - The view the wrapper hands the body.
 * @param zoom - Canvas zoom to put in the xyflow store; its default when absent.
 * @returns Nothing; assert against the screen.
 */
function renderImage(data: Record<string, unknown>, zoom?: number): void {
  const Image = FLOW_NODE_TYPES.image;
  render(
    // The app hangs one tooltip provider at its root; the counts column
    // reaches for it to hang each count's tip.
    <TooltipProvider>
      <ReactFlowProvider>
        <StoreGrabber />
        <CanvasActionsContext.Provider value={{ renameNode: vi.fn(), deleteEdge: () => undefined,
          deleteNode: () => undefined, activateNodeUpload: () => undefined, commitGroupResize: () => undefined,
          reportGroupResize: () => undefined, beginGroupResize: () => undefined, }}>
          <Image {...({ id: 'n1', data, selected: false } as unknown as NodeProps)} />
        </CanvasActionsContext.Provider>
      </ReactFlowProvider>
    </TooltipProvider>,
  );
  if (zoom !== undefined) {
    act(() => {
      storeApi?.setState({ transform: [0, 0, zoom] });
    });
  }
}

/** A node with one task in each of the four states. */
const ONE_OF_EACH = {
  kind: 'image',
  status: 'idle',
  name: 'N',
  content: 'https://cdn.invalid/a.png',
  taskCounts: { running: 1, done: 1, failed: 1, expired: 1 },
};

// The node's own tasks are the reason the counts exist, and a task that is
// running is the one thing about them that is happening right now. Reading a
// board zoomed out is exactly when that matters, so the canvas taking the
// cells below the size a target may be governs the three finished states and
// leaves the running one alone (user 2026-09-13).
describe('which counts survive the canvas zooming out', () => {
  afterEach(() => {
    storeApi = null;
  });

  it('keeps drawing the running count at the smallest zoom the canvas allows', () => {
    renderImage(ONE_OF_EACH, 0.1);

    expect(screen.getByTestId('task-count-running')).toBeInTheDocument();
  });

  it('drops the three finished counts once a cell is under the target minimum', () => {
    renderImage(ONE_OF_EACH, CELL_AT_MIN_TARGET - 0.001);

    expect(screen.queryByTestId('task-count-done')).toBeNull();
    expect(screen.queryByTestId('task-count-failed')).toBeNull();
    expect(screen.queryByTestId('task-count-expired')).toBeNull();
  });

  it('draws all four while a cell still measures the target minimum', () => {
    renderImage(ONE_OF_EACH, CELL_AT_MIN_TARGET);

    expect(screen.getByTestId('task-count-running')).toBeInTheDocument();
    expect(screen.getByTestId('task-count-done')).toBeInTheDocument();
    expect(screen.getByTestId('task-count-failed')).toBeInTheDocument();
    expect(screen.getByTestId('task-count-expired')).toBeInTheDocument();
  });

  it('draws nothing at a small zoom for a node with no task running', () => {
    renderImage(
      { ...ONE_OF_EACH, taskCounts: { running: 0, done: 2, failed: 1, expired: 1 } },
      0.3,
    );

    expect(screen.queryByTestId('node-task-counts')).not.toBeInTheDocument();
    expect(screen.queryAllByTestId(/^task-count-/)).toHaveLength(0);
  });

  // The column and the name header take the same factor from the same
  // variable. Comparing the column against `overlayCounterScale(zoom)` would
  // hold only the column's side of that: the header reads the factor out of
  // `NodeScaleContext`, so a wrong value handed to the provider would break
  // the rule while such an assertion stayed green.
  it('scales the column by the factor the name header is given', () => {
    renderImage(ONE_OF_EACH, 0.3);

    expect(screen.getByTestId('node-task-counts-anchor').style.transform).toBe(
      screen.getByTestId('node-header-anchor').style.transform,
    );
  });
});
