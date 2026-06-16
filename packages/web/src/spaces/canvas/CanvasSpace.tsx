// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import {
  Background,
  BackgroundVariant,
  PanOnScrollMode,
  ReactFlow,
  ReactFlowProvider,
  applyNodeChanges,
  useReactFlow,
  useStore,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import * as React from 'react';

import {
  addEdge,
  removeNode,
  setNodeLocked,
  setNodeName,
  setNodePosition,
  useCanvasSpace,
  type CanvasEdge,
  type CanvasNodeView,
} from '@web/data/yjs/canvas-space';
import { useTranslation } from '@web/i18n/use-translation';
import type { SpaceBodyProps } from '@web/spaces';
import {
  CanvasActionsContext,
  type CanvasActions,
} from '@web/spaces/canvas/canvas-actions';
import { CanvasContextMenu } from '@web/spaces/canvas/CanvasContextMenu';
import { NodeContextMenu } from '@web/spaces/canvas/NodeContextMenu';
import { mergeMirroredSelection } from '@web/spaces/canvas/mirror-selection';
import {
  parseClipboardNodes,
  serializeNodes,
  type ClipboardNode,
} from '@web/spaces/canvas/node-clipboard';
import {
  isCreatableNodeType,
  type CreatableNodeType,
} from '@web/spaces/canvas/node-factory';
import { FLOW_NODE_TYPES } from '@web/spaces/canvas/nodes/flow-node-types';
import { useNodeCreation } from '@web/spaces/canvas/use-node-creation';
import { useCanvasStore } from '@web/stores';

/** Steps repeated centre-drops apart so library creations don't stack exactly. */
const STAGGER_STEP_PX = 24;
const STAGGER_WRAP = 8;

/** Pixels a pasted node is shifted from its source so it doesn't fully cover it. */
const PASTE_OFFSET_PX = 24;

const DELETE_KEYS = ['Backspace', 'Delete'];

/** Background dot grid spacing (px at zoom 1). Tighter = denser dot field. */
const DOT_GAP_PX = 12;

/**
 * Whether a focused element should keep the browser's native paste / copy —
 * so editing a node body or a form field isn't hijacked by the canvas
 * clipboard handlers.
 * @param el - The currently focused element (`document.activeElement`).
 * @returns True for inputs, textareas, and contenteditable elements.
 */
function isEditableTarget(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    (el as HTMLElement).isContentEditable
  );
}

/**
 * Project a ReactFlow node into the clipboard-portable subset, or null when
 * it isn't a copyable content node (annotation / group aren't copied yet).
 * @param node - A ReactFlow node from the render buffer.
 * @returns The clipboard node, or null to skip it.
 */
function flowNodeToClipboard(node: Node): ClipboardNode | null {
  if (!node.type || !isCreatableNodeType(node.type)) return null;
  const data = node.data as { name?: unknown; content?: unknown };
  return {
    type: node.type,
    position: node.position,
    ...(typeof data.name === 'string' ? { name: data.name } : {}),
    ...(typeof data.content === 'string' ? { content: data.content } : {}),
  };
}

/**
 * Project a Yjs canvas node view into a ReactFlow node. ReactFlow's
 * `node.type` is the view `kind` (the `FLOW_NODE_TYPES` lookup key) and
 * `node.data` carries the full narrowed view for the body to render.
 * @param node - The canvas node view from the Yjs binding.
 * @returns The ReactFlow node.
 */
function toFlowNode(node: CanvasNodeView): Node {
  return {
    id: node.id,
    type: node.type,
    position: node.position,
    data: node.data as unknown as Record<string, unknown>,
  };
}

/**
 * Project a Yjs canvas edge into a ReactFlow edge.
 * @param edge - The canvas edge from the Yjs binding.
 * @returns The ReactFlow edge.
 */
function toFlowEdge(edge: CanvasEdge): Edge {
  return { id: edge.id, source: edge.source, target: edge.target };
}

/**
 * Canvas body — mounts ReactFlow over the Yjs-backed canvas space.
 *
 * Yjs is the single source of truth: `useCanvasSpace` observes the doc and
 * the observed nodes are mirrored into ReactFlow's local render buffer
 * (`flowNodes`) so drag stays smooth. The three frontend-owned mutations
 * are bridged back to Yjs — position on drag stop, deletion, and edge
 * connect. The backend never creates / deletes / moves nodes; it only
 * writes state fields into a node's `data` (see the canvas-space binding).
 * @param root0 - Space body props from the project space outlet.
 * @param root0.projectId - Owning project id.
 * @param root0.spaceId - Canvas space id.
 * @param root0.readOnly - Viewer read-only mode; blocks node creation.
 * @returns The ReactFlow canvas surface.
 */
function CanvasSpaceInner({
  projectId,
  spaceId,
  readOnly = false,
}: SpaceBodyProps): React.JSX.Element {
  const t = useTranslation();
  const { nodes, edges } = useCanvasSpace(projectId, spaceId);
  const [flowNodes, setFlowNodes] = React.useState<Node[]>([]);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const { screenToFlowPosition, zoomIn, zoomOut, fitView, zoomTo } =
    useReactFlow();

  // ---- Zoom bridge (chrome toolbar ↔ ReactFlow) ----
  // The zoom toolbar lives in chrome, outside this ReactFlowProvider, so it
  // can't read or drive the real zoom. Mirror the live zoom into the canvas
  // store for the toolbar's read-out, and run the toolbar's commands (posted
  // through the store mailbox) against ReactFlow here, where the API exists.
  const setZoom = useCanvasStore((s) => s.setZoom);
  const rfZoom = useStore((s) => s.transform[2]);
  React.useEffect(() => {
    setZoom(rfZoom);
  }, [rfZoom, setZoom]);

  const pendingViewportCommand = useCanvasStore(
    (s) => s.pendingViewportCommand,
  );
  const consumeViewportCommand = useCanvasStore(
    (s) => s.consumeViewportCommand,
  );
  React.useEffect(() => {
    if (!pendingViewportCommand) return;
    const command = pendingViewportCommand;
    if (command === 'zoomIn') zoomIn();
    else if (command === 'zoomOut') zoomOut();
    else if (command === 'fit') fitView();
    else zoomTo(command.zoomTo);
    consumeViewportCommand();
  }, [
    pendingViewportCommand,
    zoomIn,
    zoomOut,
    fitView,
    zoomTo,
    consumeViewportCommand,
  ]);
  const { createNodeAt, pasteTextAt, pasteNodesAt } = useNodeCreation(
    projectId,
    spaceId,
  );

  // Mirror the Yjs-observed nodes into ReactFlow's render buffer. ReactFlow
  // needs a local node array for smooth drag; Yjs stays the source of truth
  // and positions are persisted back on drag stop (onNodeDragStop). Local
  // selection / drag state is per-user (not in Yjs), so carry it forward by
  // id — otherwise any collaborator / backend write would wipe the current
  // user's selection (including a just-created node's auto-selection).
  React.useEffect(() => {
    setFlowNodes((prev) => mergeMirroredSelection(prev, nodes.map(toFlowNode)));
  }, [nodes]);

  const flowEdges = React.useMemo(() => edges.map(toFlowEdge), [edges]);

  const onNodesChange = React.useCallback((changes: NodeChange[]): void => {
    setFlowNodes((current) => applyNodeChanges(changes, current));
  }, []);

  const onNodeDragStop = React.useCallback(
    (_event: React.MouseEvent, node: Node): void => {
      setNodePosition(projectId, spaceId, node.id, node.position);
    },
    [projectId, spaceId],
  );

  const onNodesDelete = React.useCallback(
    (deleted: Node[]): void => {
      deleted.forEach((node) => removeNode(projectId, spaceId, node.id));
    },
    [projectId, spaceId],
  );

  const onConnect = React.useCallback(
    (connection: Connection): void => {
      if (!connection.source || !connection.target) return;
      addEdge(projectId, spaceId, {
        id: `${connection.source}->${connection.target}`,
        source: connection.source,
        target: connection.target,
        kind: 'primary',
      });
    },
    [projectId, spaceId],
  );

  // ---- Node creation (library mailbox + right-click) ----
  // Viewers can't create. The chrome node-library button is already disabled,
  // but the canvas-internal right-click path has no chrome gate, so the canvas
  // gates on the `readOnly` prop (sourced from the project `myRole`). Broader
  // viewer read-only for drag / delete / edit / rename is a separate,
  // canvas-wide concern.
  const pendingNodeCreate = useCanvasStore((s) => s.pendingNodeCreate);
  const consumePendingNodeCreate = useCanvasStore(
    (s) => s.consumePendingNodeCreate,
  );
  const [selectAfterCreate, setSelectAfterCreate] = React.useState<
    string[] | null
  >(null);
  const staggerRef = React.useRef(0);
  const [contextMenu, setContextMenu] = React.useState({
    open: false,
    x: 0,
    y: 0,
  });
  const [nodeMenu, setNodeMenu] = React.useState({
    open: false,
    x: 0,
    y: 0,
    nodeId: '',
    locked: false,
  });

  // Create a node at a flow position and flag it for auto-selection once the
  // Yjs round-trip mirrors it back into the render buffer.
  const createNode = React.useCallback(
    (type: CreatableNodeType, position: { x: number; y: number }): void => {
      setSelectAfterCreate([createNodeAt(type, position)]);
    },
    [createNodeAt],
  );

  // Library path: chrome posted a create intent. Drop the node at the
  // viewport centre (the chrome button has no viewport), staggering repeats
  // so they don't stack exactly. Always clear the mailbox afterward.
  React.useEffect(() => {
    if (!pendingNodeCreate) return;
    const type = pendingNodeCreate;
    const rect = containerRef.current?.getBoundingClientRect();
    if (readOnly || !rect || !isCreatableNodeType(type)) {
      consumePendingNodeCreate();
      return;
    }
    const offset = (staggerRef.current % STAGGER_WRAP) * STAGGER_STEP_PX;
    staggerRef.current += 1;
    const center = screenToFlowPosition({
      x: rect.left + rect.width / 2 + offset,
      y: rect.top + rect.height / 2 + offset,
    });
    createNode(type, center);
    consumePendingNodeCreate();
  }, [
    pendingNodeCreate,
    readOnly,
    consumePendingNodeCreate,
    screenToFlowPosition,
    createNode,
  ]);

  // Right-click path: open the creatable-node menu at the cursor; the node
  // drops exactly where the user clicked. Suppress the browser menu for
  // everyone, but only editors get the create menu.
  const onPaneContextMenu = React.useCallback(
    (event: React.MouseEvent | MouseEvent): void => {
      event.preventDefault();
      if (readOnly) return;
      setContextMenu({ open: true, x: event.clientX, y: event.clientY });
    },
    [readOnly],
  );

  const onContextMenuPick = React.useCallback(
    (type: CreatableNodeType): void => {
      const position = screenToFlowPosition({
        x: contextMenu.x,
        y: contextMenu.y,
      });
      createNode(type, position);
      setContextMenu((prev) => ({ ...prev, open: false }));
    },
    [contextMenu.x, contextMenu.y, screenToFlowPosition, createNode],
  );

  // Node right-click path: open the per-node action menu (lock / unlock) at the
  // cursor. Suppress the browser menu for everyone, but only editors get the
  // menu — locking is a shared-state edit gated like node creation.
  const onNodeContextMenu = React.useCallback(
    (event: React.MouseEvent, node: Node): void => {
      event.preventDefault();
      if (readOnly) return;
      const locked = Boolean((node.data as { locked?: unknown }).locked);
      setNodeMenu({
        open: true,
        x: event.clientX,
        y: event.clientY,
        nodeId: node.id,
        locked,
      });
    },
    [readOnly],
  );

  const onToggleNodeLock = React.useCallback((): void => {
    setNodeLocked(projectId, spaceId, nodeMenu.nodeId, !nodeMenu.locked);
    setNodeMenu((prev) => ({ ...prev, open: false }));
  }, [projectId, spaceId, nodeMenu.nodeId, nodeMenu.locked]);

  // Select the freshly created / pasted node(s) once the Yjs mirror has them
  // all. Runs once per creation (keyed on the pending ids), not on every
  // collaborator edit. A multi-node paste selects the whole pasted group.
  React.useEffect(() => {
    if (!selectAfterCreate) return;
    if (!selectAfterCreate.every((id) => nodes.some((node) => node.id === id)))
      return;
    const targets = new Set(selectAfterCreate);
    setFlowNodes((current) =>
      current.map((node) => ({
        ...node,
        selected: targets.has(node.id),
      })),
    );
    setSelectAfterCreate(null);
  }, [selectAfterCreate, nodes]);

  // ---- Clipboard (slice 2b) ----
  // The system clipboard is the single source of truth. Copy serializes the
  // selected nodes (marker-tagged JSON); paste branches on the marker —
  // cloning nodes or, for plain text, creating a text node. Both bail when a
  // field / node body is being edited (browser default) or the viewer is
  // read-only. The copy handler reads the latest selection through a ref so
  // the document listener needn't re-attach on every render.
  const flowNodesRef = React.useRef<Node[]>([]);
  React.useEffect(() => {
    flowNodesRef.current = flowNodes;
  }, [flowNodes]);

  React.useEffect(() => {
    /**
     * Document paste handler: clone a marked node payload, else create a text
     * node from plain text. No-op while read-only or editing a field.
     * @param event - The clipboard paste event.
     */
    const onPaste = (event: ClipboardEvent): void => {
      if (readOnly || isEditableTarget(document.activeElement)) return;
      const text = event.clipboardData?.getData('text/plain') ?? '';

      const clipboardNodes = parseClipboardNodes(text);
      if (clipboardNodes && clipboardNodes.length > 0) {
        event.preventDefault();
        setSelectAfterCreate(
          pasteNodesAt(clipboardNodes, {
            dx: PASTE_OFFSET_PX,
            dy: PASTE_OFFSET_PX,
          }),
        );
        return;
      }

      if (text.trim().length === 0) return;
      event.preventDefault();
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const center = screenToFlowPosition({
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
      });
      setSelectAfterCreate([pasteTextAt(text, center)]);
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, [readOnly, pasteNodesAt, pasteTextAt, screenToFlowPosition]);

  React.useEffect(() => {
    /**
     * Document copy handler: serialize the selected nodes to the system
     * clipboard. No-op while read-only, editing a field, or with no selection.
     * @param event - The clipboard copy event.
     */
    const onCopy = (event: ClipboardEvent): void => {
      if (readOnly || isEditableTarget(document.activeElement)) return;
      const clipboardNodes = flowNodesRef.current
        .filter((node) => node.selected)
        .map(flowNodeToClipboard)
        .filter((node): node is ClipboardNode => node !== null);
      if (clipboardNodes.length === 0) return;
      event.clipboardData?.setData(
        'text/plain',
        serializeNodes(clipboardNodes),
      );
      event.preventDefault();
    };
    document.addEventListener('copy', onCopy);
    return () => document.removeEventListener('copy', onCopy);
  }, [readOnly]);

  // Frontend-owned mutation surfaced to the node bodies through context: a
  // node knows its new name but not the project / space it lives in. The
  // ReactFlow wrapper pre-binds this to each node's id.
  const actions = React.useMemo<CanvasActions>(
    () => ({
      renameNode: (nodeId: string, name: string): void =>
        setNodeName(projectId, spaceId, nodeId, name),
    }),
    [projectId, spaceId],
  );

  return (
    <CanvasActionsContext.Provider value={actions}>
      <div
        ref={containerRef}
        data-testid='canvas-space'
        data-project-id={projectId}
        data-space-id={spaceId}
        data-readonly={readOnly ? 'true' : undefined}
        className='relative h-full w-full bg-canvas'
      >
        <ReactFlow
          nodes={flowNodes}
          edges={flowEdges}
          nodeTypes={FLOW_NODE_TYPES}
          onNodesChange={onNodesChange}
          onNodeDragStop={onNodeDragStop}
          onNodesDelete={onNodesDelete}
          onConnect={onConnect}
          onPaneContextMenu={onPaneContextMenu}
          onNodeContextMenu={onNodeContextMenu}
          deleteKeyCode={DELETE_KEYS}
          proOptions={{ hideAttribution: true }}
          fitView
          // Canvas zoom pinned to 10%–200% (the viewport toolbar's ZOOM_MIN /
          // ZOOM_MAX use the same range); overrides ReactFlow's default 0.1–4
          // ceiling so wheel / pinch can't exceed 200%.
          minZoom={0.1}
          maxZoom={2}
          // Figma-like interaction: left-button drag marquee-selects (not
          // pans); two-finger trackpad scroll pans the canvas freely; pinch
          // zooms. With panOnScroll on, a plain wheel / two-finger scroll pans
          // and a ctrl-wheel / pinch zooms (zoomOnPinch, default) — ReactFlow
          // routes the two automatically, so zoomOnScroll stays at its default.
          selectionOnDrag
          panOnDrag={false}
          panOnScroll
          panOnScrollMode={PanOnScrollMode.Free}
        >
          <Background
            variant={BackgroundVariant.Dots}
            gap={DOT_GAP_PX}
            size={1}
            color='var(--color-canvas-grid)'
          />
        </ReactFlow>
        {flowNodes.length === 0 ? (
          <div
            data-testid='canvas-empty'
            className='pointer-events-none absolute inset-0 flex items-center justify-center text-center text-sm leading-relaxed text-muted-foreground'
          >
            <div className='max-w-[360px] rounded-sm border border-dashed border-border bg-card px-6 py-4'>
              <strong className='block text-foreground'>
                {t('canvas.emptyState.title')}
              </strong>
              <span className='text-xs text-muted-foreground'>
                {t('canvas.emptyState.hint')}
              </span>
            </div>
          </div>
        ) : null}
        <CanvasContextMenu
          open={contextMenu.open}
          x={contextMenu.x}
          y={contextMenu.y}
          onOpenChange={(open) =>
            setContextMenu((prev) => ({ ...prev, open }))
          }
          onPick={onContextMenuPick}
        />
        <NodeContextMenu
          open={nodeMenu.open}
          x={nodeMenu.x}
          y={nodeMenu.y}
          locked={nodeMenu.locked}
          onOpenChange={(open) => setNodeMenu((prev) => ({ ...prev, open }))}
          onToggleLock={onToggleNodeLock}
        />
      </div>
    </CanvasActionsContext.Provider>
  );
}

/**
 * Canvas space body. Wraps {@link CanvasSpaceInner} in a
 * `ReactFlowProvider` so the canvas and any future chrome (viewport
 * toolbar zoom controls) share one ReactFlow store.
 * @param props - Space body props supplied by the project space outlet.
 * @returns The provider-wrapped canvas surface.
 */
export function CanvasSpace(props: SpaceBodyProps): React.JSX.Element {
  return (
    <ReactFlowProvider>
      <CanvasSpaceInner {...props} />
    </ReactFlowProvider>
  );
}
