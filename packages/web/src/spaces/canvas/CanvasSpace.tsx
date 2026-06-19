// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import {
  Background,
  BackgroundVariant,
  NodeToolbar,
  PanOnScrollMode,
  Position,
  ReactFlow,
  ReactFlowProvider,
  applyEdgeChanges,
  applyNodeChanges,
  useReactFlow,
  useStore,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import * as React from 'react';

import {
  addEdge,
  addNode,
  addToGroup,
  moveGroup,
  removeEdge,
  removeElements,
  removeFromGroup,
  removeNode,
  setGroupBackground,
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
import { matchGroupShortcut } from '@web/spaces/canvas/canvas-group-shortcut';
import { matchHistoryShortcut } from '@web/spaces/canvas/canvas-history-shortcut';
import {
  applyGroupGeometry,
  computeGroupRect,
} from '@web/spaces/canvas/group-geometry';
import {
  resolveGroupDrop,
  type GroupBox,
} from '@web/spaces/canvas/group-membership';
import {
  computeGroupToolbar,
  type NodeGroupInfo,
} from '@web/spaces/canvas/group-toolbar';
import { EDGE_TYPES } from '@web/spaces/canvas/edges/edge-types';
import { CanvasContextMenu } from '@web/spaces/canvas/CanvasContextMenu';
import { GroupBackgroundPicker } from '@web/spaces/canvas/GroupBackgroundPicker';
import { NodeContextMenu } from '@web/spaces/canvas/NodeContextMenu';
import {
  mergeMirroredEdgeSelection,
  mergeMirroredSelection,
} from '@web/spaces/canvas/mirror-selection';
import {
  parseClipboardNodes,
  serializeNodes,
  type ClipboardNode,
} from '@web/spaces/canvas/node-clipboard';
import {
  createEmptyGroup,
  isCreatableNodeType,
  type CreatableNodeType,
} from '@web/spaces/canvas/node-factory';
import { FLOW_NODE_TYPES } from '@web/spaces/canvas/nodes/flow-node-types';
import { useNodeCreation } from '@web/spaces/canvas/use-node-creation';
import { useCanvasStore } from '@web/stores';
import { useCurrentUserStore } from '@web/stores/current-user';

/** Steps repeated centre-drops apart so library creations don't stack exactly. */
const STAGGER_STEP_PX = 24;
const STAGGER_WRAP = 8;

/** Pixels a pasted node is shifted from its source so it doesn't fully cover it. */
const PASTE_OFFSET_PX = 24;

const DELETE_KEYS = ['Backspace', 'Delete'];

/**
 * Background dot grid base. Doubled from the old gap (12) + size (1) so the
 * dots read at 100% zoom the way they used to at 200% — bigger + sparser —
 * while still scaling with zoom (a frozen, non-scaling grid felt disorienting).
 */
const DOT_GAP_PX = 24;
const DOT_SIZE_PX = 2;

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

/** Fallback footprint for an unmeasured node when hit-testing its center. */
const NODE_FALLBACK_W = 160;
const NODE_FALLBACK_H = 96;

/**
 * A node's center in flow coordinates, from its measured size (or a default
 * before ReactFlow has measured it).
 * @param node - The flow node.
 * @returns The node's center point.
 */
function nodeCenter(node: Node): { x: number; y: number } {
  const width = node.measured?.width ?? NODE_FALLBACK_W;
  const height = node.measured?.height ?? NODE_FALLBACK_H;
  return { x: node.position.x + width / 2, y: node.position.y + height / 2 };
}

/**
 * Build the hit-test boxes for every group, excluding the dragged node from
 * each group's bounds so a member dragged out of its own group reads as
 * "outside" (the group's rect is its *other* members' bounds). A group with
 * no remaining members is skipped (its sole member following it is a move,
 * not a leave). `childIds` keeps the dragged node so its current group is
 * still detectable.
 * @param flowNodes - The current flow nodes.
 * @param draggedId - The node being dropped (excluded from each rect).
 * @returns One {@link GroupBox} per group with a resolvable rect.
 */
function groupBoxesFor(
  flowNodes: ReadonlyArray<Node>,
  draggedId: string,
): GroupBox[] {
  const boxes: GroupBox[] = [];
  for (const node of flowNodes) {
    if (node.type !== 'group') continue;
    const childIds = (node.data as { childIds?: string[] }).childIds ?? [];
    const members = flowNodes.filter(
      (member) => childIds.includes(member.id) && member.id !== draggedId,
    );
    const rect = computeGroupRect(members);
    if (rect) boxes.push({ id: node.id, rect, childIds });
  }
  return boxes;
}

/**
 * Project a Yjs canvas edge into a ReactFlow edge.
 * @param edge - The canvas edge from the Yjs binding.
 * @returns The ReactFlow edge.
 */
function toFlowEdge(edge: CanvasEdge): Edge {
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    type: 'scissors',
  };
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
  const { nodes, edges, undo, redo, canUndo, canRedo } = useCanvasSpace(
    projectId,
    spaceId,
  );
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

  // ---- History bridge (chrome toolbar ↔ canvas undo manager) ----
  // The undo / redo buttons live in chrome, outside this provider, same as
  // zoom. Mirror the manager's availability into the store for the toolbar's
  // disabled state, and run the toolbar's posted commands here where the
  // manager lives. Viewport (zoom / pan) is deliberately NOT undoable.
  const setHistoryAvailability = useCanvasStore(
    (s) => s.setHistoryAvailability,
  );
  React.useEffect(() => {
    setHistoryAvailability(canUndo, canRedo);
  }, [canUndo, canRedo, setHistoryAvailability]);

  const pendingHistoryCommand = useCanvasStore((s) => s.pendingHistoryCommand);
  const consumeHistoryCommand = useCanvasStore(
    (s) => s.consumeHistoryCommand,
  );
  React.useEffect(() => {
    if (!pendingHistoryCommand) return;
    if (readOnly) {
      consumeHistoryCommand();
      return;
    }
    if (pendingHistoryCommand === 'undo') undo();
    else redo();
    consumeHistoryCommand();
  }, [pendingHistoryCommand, readOnly, undo, redo, consumeHistoryCommand]);

  // Keyboard undo / redo — double-platform (Cmd on mac, Ctrl on windows; see
  // matchHistoryShortcut). Gated like the clipboard handlers: no-op while a
  // field / node body is being edited (let the input's native undo win) or
  // the viewer is read-only.
  React.useEffect(() => {
    /**
     * Document keydown handler: route undo / redo shortcuts to the manager.
     * @param event - The keyboard event.
     */
    const onKeyDown = (event: KeyboardEvent): void => {
      if (readOnly || isEditableTarget(document.activeElement)) return;
      const action = matchHistoryShortcut(event);
      if (!action) return;
      event.preventDefault();
      if (action === 'undo') undo();
      else redo();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [readOnly, undo, redo]);

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

  // Mirror the Yjs-observed edges into ReactFlow's render buffer the same way
  // as nodes — a LOCAL edges array + onEdgesChange. Without a local buffer,
  // ReactFlow can't track per-user edge selection: the `selected` flag never
  // reaches the scissors edge (so no scissors appears) and the delete key has
  // no selected edge to remove. Yjs stays the source of truth; the viewer
  // read-only flag rides on each edge's `data` so the scissors hides for
  // viewers, and local `selected` is carried forward across Yjs re-mirrors.
  const [flowEdges, setFlowEdges] = React.useState<Edge[]>([]);
  React.useEffect(() => {
    setFlowEdges((prev) =>
      mergeMirroredEdgeSelection(
        prev,
        edges.map((edge) => ({ ...toFlowEdge(edge), data: { readOnly } })),
      ),
    );
  }, [edges, readOnly]);

  const onNodesChange = React.useCallback((changes: NodeChange[]): void => {
    setFlowNodes((current) => applyNodeChanges(changes, current));
  }, []);

  const onEdgesChange = React.useCallback((changes: EdgeChange[]): void => {
    setFlowEdges((current) => applyEdgeChanges(changes, current));
  }, []);

  // Group drag carries its members: a group node has no authoritative position
  // (geometry is derived from its members), so dragging it translates every
  // member instead. We track the drag delta and move members locally each
  // frame (smooth, no Yjs churn); the final delta is persisted once on stop
  // (one moveGroup = one undo entry). Members keep their real positions.
  const groupDragRef = React.useRef<{
    id: string;
    startX: number;
    startY: number;
    lastX: number;
    lastY: number;
    childIds: string[];
  } | null>(null);

  const onNodeDragStart = React.useCallback(
    (_event: React.MouseEvent, node: Node): void => {
      if (node.type !== 'group') return;
      const childIds = (node.data as { childIds?: string[] }).childIds ?? [];
      groupDragRef.current = {
        id: node.id,
        startX: node.position.x,
        startY: node.position.y,
        lastX: node.position.x,
        lastY: node.position.y,
        childIds,
      };
    },
    [],
  );

  const onNodeDrag = React.useCallback(
    (_event: React.MouseEvent, node: Node): void => {
      const drag = groupDragRef.current;
      if (!drag || drag.id !== node.id) return;
      const dx = node.position.x - drag.lastX;
      const dy = node.position.y - drag.lastY;
      if (dx === 0 && dy === 0) return;
      drag.lastX = node.position.x;
      drag.lastY = node.position.y;
      setFlowNodes((current) =>
        current.map((flowNode) =>
          drag.childIds.includes(flowNode.id)
            ? {
              ...flowNode,
              position: {
                x: flowNode.position.x + dx,
                y: flowNode.position.y + dy,
              },
            }
            : flowNode,
        ),
      );
    },
    [],
  );

  const onNodeDragStop = React.useCallback(
    (_event: React.MouseEvent, node: Node): void => {
      const drag = groupDragRef.current;
      if (node.type === 'group' && drag && drag.id === node.id) {
        groupDragRef.current = null;
        const dx = node.position.x - drag.startX;
        const dy = node.position.y - drag.startY;
        if (dx !== 0 || dy !== 0) {
          moveGroup(projectId, spaceId, node.id, { x: dx, y: dy });
        }
        return;
      }
      // A single (non-group) node: persist its new position, then resolve
      // whether the drop changed its group membership (§7.5 drag in / out).
      setNodePosition(projectId, spaceId, node.id, node.position);
      const drop = resolveGroupDrop(
        node.id,
        nodeCenter(node),
        groupBoxesFor(flowNodes, node.id),
      );
      if (drop.action === 'add') {
        addToGroup(projectId, spaceId, drop.groupId, node.id);
      } else if (drop.action === 'remove') {
        removeFromGroup(projectId, spaceId, drop.groupId, node.id);
      }
    },
    [projectId, spaceId, flowNodes],
  );

  // Persist deletions to Yjs. ReactFlow's onDelete fires ONCE with both the
  // deleted nodes and their cascaded (connected) edges — and for a standalone
  // edge delete (select + Delete key). Persisting them in one removeElements
  // transaction makes node + edge deletion a single undo entry, so one undo
  // restores BOTH the node and its edges (the reported bug: node came back but
  // the edge did not). Without this, a deletion only left ReactFlow's local
  // buffer and reappeared on the next Yjs sync. Read-only viewers can't delete.
  const onDelete = React.useCallback(
    ({
      nodes: deletedNodes,
      edges: deletedEdges,
    }: {
      nodes: Node[];
      edges: Edge[];
    }): void => {
      if (readOnly) return;
      removeElements(
        projectId,
        spaceId,
        deletedNodes.map((node) => node.id),
        deletedEdges.map((edge) => edge.id),
      );
    },
    [projectId, spaceId, readOnly],
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

  // ---- Grouping (selection → group / ungroup) ----
  const userId = useCurrentUserStore((s) => s.user?.id) ?? '';
  const selectedIds = React.useMemo(
    () => flowNodes.filter((node) => node.selected).map((node) => node.id),
    [flowNodes],
  );
  const groupInfos = React.useMemo<NodeGroupInfo[]>(
    () =>
      flowNodes.map((node) => ({
        id: node.id,
        isGroup: node.type === 'group',
        childIds: (node.data as { childIds?: string[] }).childIds,
      })),
    [flowNodes],
  );
  const groupOffer = React.useMemo(
    () => computeGroupToolbar(selectedIds, groupInfos),
    [selectedIds, groupInfos],
  );

  // Group the loose selection into a new group node. Its stored position is
  // the members' padded top-left (real geometry is derived at render); the
  // new group is selected so its toolbar / color picker is immediately usable.
  const groupSelection = React.useCallback((): void => {
    if (readOnly || groupOffer.kind !== 'group') return;
    const members = flowNodes.filter((node) => selectedIds.includes(node.id));
    const rect = computeGroupRect(members);
    const position = rect ? { x: rect.x, y: rect.y } : { x: 0, y: 0 };
    const group = createEmptyGroup(selectedIds, position, userId);
    addNode(projectId, spaceId, group);
    setSelectAfterCreate([group.id]);
  }, [readOnly, groupOffer, flowNodes, selectedIds, userId, projectId, spaceId]);

  // Dissolve the selected group — delete the group node only; its members are
  // untouched and stay on the canvas (delete-group = release children).
  const ungroupSelection = React.useCallback((): void => {
    if (readOnly || groupOffer.kind !== 'ungroup') return;
    removeNode(projectId, spaceId, groupOffer.groupId);
  }, [readOnly, groupOffer, projectId, spaceId]);

  // Background-color picker for the selected group (only the ungroup offer has
  // a single group). Its current tint seeds the picker; a pick writes through
  // to Yjs.
  const [bgMenuOpen, setBgMenuOpen] = React.useState(false);
  const selectedGroupBg = React.useMemo<string | undefined>(() => {
    if (groupOffer.kind !== 'ungroup') return undefined;
    const group = flowNodes.find((node) => node.id === groupOffer.groupId);
    return (group?.data as { backgroundColor?: string } | undefined)
      ?.backgroundColor;
  }, [groupOffer, flowNodes]);
  const pickGroupBackground = React.useCallback(
    (color: string | undefined): void => {
      if (readOnly || groupOffer.kind !== 'ungroup') return;
      setGroupBackground(projectId, spaceId, groupOffer.groupId, color);
      setBgMenuOpen(false);
    },
    [readOnly, groupOffer, projectId, spaceId],
  );

  // Keyboard grouping — double-platform (Cmd on mac, Ctrl on windows; see
  // matchGroupShortcut). Gated like undo/redo: no-op while editing a field or
  // read-only, and only swallows the browser shortcut when the action applies.
  React.useEffect(() => {
    /**
     * Document keydown handler: route group / ungroup shortcuts.
     * @param event - The keyboard event.
     */
    const onKeyDown = (event: KeyboardEvent): void => {
      if (readOnly || isEditableTarget(document.activeElement)) return;
      const action = matchGroupShortcut(event);
      if (action === 'group' && groupOffer.kind === 'group') {
        event.preventDefault();
        groupSelection();
      } else if (action === 'ungroup' && groupOffer.kind === 'ungroup') {
        event.preventDefault();
        ungroupSelection();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [readOnly, groupOffer, groupSelection, ungroupSelection]);

  // Frontend-owned mutation surfaced to the node bodies through context: a
  // node knows its new name but not the project / space it lives in. The
  // ReactFlow wrapper pre-binds this to each node's id.
  const actions = React.useMemo<CanvasActions>(
    () => ({
      renameNode: (nodeId: string, name: string): void =>
        setNodeName(projectId, spaceId, nodeId, name),
      deleteEdge: (edgeId: string): void => {
        if (readOnly) return;
        removeEdge(projectId, spaceId, edgeId);
      },
    }),
    [projectId, spaceId, readOnly],
  );

  // Group nodes carry no authoritative size: derive each group's container
  // from its members' bounding box (+ padding) at render. Groups render
  // *behind* their members (painted first; grab them by the frame padding) and
  // dragging one moves its members instead of the (position-less) group node
  // itself (onNodeDragStart / onNodeDrag / onNodeDragStop). Members keep their
  // own real positions, so a member drag reflows the group on the next mirror.
  const renderNodes = React.useMemo<Node[]>(() => {
    const sized = applyGroupGeometry(flowNodes);
    const groups = sized.filter((node) => node.type === 'group');
    const rest = sized.filter((node) => node.type !== 'group');
    return [
      ...groups.map((node) => ({ ...node, draggable: !readOnly, zIndex: 0 })),
      ...rest,
    ];
  }, [flowNodes, readOnly]);

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
          nodes={renderNodes}
          edges={flowEdges}
          nodeTypes={FLOW_NODE_TYPES}
          edgeTypes={EDGE_TYPES}
          // Viewer backstop (#1377): a read-only viewer must not move nodes or
          // draw edges. The real boundary is the collab server (a read-only
          // connection rejects the viewer's Yjs sync-update), but gating these
          // here prevents the UI from optimistically moving a node only to have
          // the server reject it and snap it back. elementsSelectable stays on
          // so viewers can still click a node to inspect it.
          nodesDraggable={!readOnly}
          nodesConnectable={!readOnly}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeDragStart={onNodeDragStart}
          onNodeDrag={onNodeDrag}
          onNodeDragStop={onNodeDragStop}
          onDelete={onDelete}
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
            size={DOT_SIZE_PX}
            color='var(--color-canvas-grid)'
          />
          {/* Floating selection toolbar: group a fresh selection, or ungroup
              a selected group (mirrors the Cmd/Ctrl+G shortcuts). */}
          <NodeToolbar
            nodeId={selectedIds}
            isVisible={groupOffer.kind !== 'none' && !readOnly}
            position={Position.Top}
          >
            <div className='flex items-center gap-1 rounded-md border border-border bg-popover p-1 shadow-md'>
              {groupOffer.kind === 'ungroup' ? (
                <>
                  <button
                    type='button'
                    data-testid='group-toolbar-ungroup'
                    onClick={ungroupSelection}
                    className='rounded-content-xs px-2 py-1 text-xs text-popover-foreground hover:bg-accent'
                  >
                    {t('canvas.group.ungroup')}
                  </button>
                  <GroupBackgroundPicker
                    open={bgMenuOpen}
                    onOpenChange={setBgMenuOpen}
                    value={selectedGroupBg}
                    onPick={pickGroupBackground}
                  />
                </>
              ) : (
                <button
                  type='button'
                  data-testid='group-toolbar-group'
                  onClick={groupSelection}
                  className='rounded-content-xs px-2 py-1 text-xs text-popover-foreground hover:bg-accent'
                >
                  {t('canvas.group.group')}
                </button>
              )}
            </div>
          </NodeToolbar>
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
