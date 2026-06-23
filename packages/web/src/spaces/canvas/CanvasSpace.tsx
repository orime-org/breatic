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
import { toast } from 'sonner';
import { newId } from '@breatic/shared';

import { assetsApi } from '@web/data/api';
import {
  addEdge,
  addNode,
  createGroup,
  expandGroup,
  removeEdge,
  removeElements,
  removeNode,
  resizeGroup,
  runCanvasUndoBatch,
  setGroupBackground,
  setNodeContent,
  setNodeError,
  setNodeHandling,
  setNodeLocked,
  setNodeName,
  setNodeParent,
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
import { matchDuplicateShortcut } from '@web/spaces/canvas/canvas-duplicate-shortcut';
import {
  matchGroupShortcut,
  planGroupShortcut,
} from '@web/spaces/canvas/canvas-group-shortcut';
import { matchHistoryShortcut } from '@web/spaces/canvas/canvas-history-shortcut';
import {
  fileToNodeSpec,
  fillNodeFromFile,
  runMediaUpload,
} from '@web/spaces/canvas/canvas-upload';
import { extractText } from '@web/spaces/canvas/text-extract';
import type { Modality } from '@web/spaces/canvas/types/node-view';
import { planGroupCreation } from '@web/spaces/canvas/group-creation';
import { planGroupDrag, type DragNode } from '@web/spaces/canvas/group-drag';
import {
  GROUP_MIN_SIZE,
  GROUP_PADDING,
  groupResizeBounds,
  planGroupGrowth,
  type GroupGrowth,
  type GroupGrowthInput,
  type Rect,
} from '@web/spaces/canvas/group-geometry';
import { topoSortByParent } from '@web/spaces/canvas/group-topology';
import {
  groupDeletionIds,
  lockBlockedDeletion,
  lockedNodeIds,
  selectionDeletionIds,
} from '@web/spaces/canvas/group-membership';
import { planResizeJoin } from '@web/spaces/canvas/group-reparent';
import {
  computeGroupToolbar,
  type NodeGroupInfo,
} from '@web/spaces/canvas/group-toolbar';
import { EDGE_TYPES } from '@web/spaces/canvas/edges/edge-types';
import { CanvasContextMenu } from '@web/spaces/canvas/CanvasContextMenu';
import { EdgeContextMenu } from '@web/spaces/canvas/EdgeContextMenu';
import { GroupSelectionToolbar } from '@web/spaces/canvas/GroupSelectionToolbar';
import { NodeContextMenu } from '@web/spaces/canvas/NodeContextMenu';
import { SelectionContextMenu } from '@web/spaces/canvas/SelectionContextMenu';
import {
  mergeMirroredEdgeSelection,
  mergeMirroredSelection,
} from '@web/spaces/canvas/mirror-selection';
import {
  captureClipboard,
  clipboardBoundingBox,
  cloneForPaste,
  externalParentAbs,
  parseClipboardNodes,
  pasteAnchorOffset,
  serializeNodes,
  type ClipboardNode,
} from '@web/spaces/canvas/node-clipboard';
import {
  createGroupNode,
  isCreatableNodeType,
  type CreatableNodeType,
} from '@web/spaces/canvas/node-factory';
import { FLOW_NODE_TYPES } from '@web/spaces/canvas/nodes/flow-node-types';
import { useNodeCreation } from '@web/spaces/canvas/use-node-creation';
import { useCanvasStore } from '@web/stores';
import { useCurrentUserStore } from '@web/stores/current-user';

/**
 * File-picker `accept` per modality for the empty-node double-click /
 * Upload-menu fill. Media modalities pick by MIME; a text node uploads a
 * document (txt / md / pdf / doc / xlsx) whose content is extracted locally
 * (`fillNodeFromFile` → `extractText`). Modalities absent here (3d / web) have
 * no picker, so {@link CanvasSpaceInner}'s activate handler no-ops for them.
 */
const UPLOAD_ACCEPT: Partial<Record<Modality, string>> = {
  text: '.txt,.md,.pdf,.doc,.docx,.xls,.xlsx,text/*',
  image: 'image/*',
  video: 'video/*',
  audio: 'audio/*',
};

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

/** Footprint assumed for a node ReactFlow has not measured yet (drag hit-test). */
const GROUP_DRAG_FALLBACK_W = 160;
const GROUP_DRAG_FALLBACK_H = 96;

/**
 * The bounding box of a Group's members (matched by `parentId`) in GROUP-LOCAL
 * coordinates (members store positions relative to the Group top-left), or
 * `null` when the Group is empty, plus whether every member is measured. Feeds
 * `groupResizeBounds` so each resize control gets a member-derived min. The
 * `allMeasured` flag drives the R1 guard: a member ReactFlow has not measured
 * yet would shrink the box, so the caller blocks shrinking that frame.
 * @param groupId - The Group node id (members are matched by `parentId`).
 * @param nodes - All flow nodes.
 * @returns The members' local bounding box (or `null` when none) + an all-measured flag.
 */
function groupMembersLocalBox(
  groupId: string,
  nodes: ReadonlyArray<Node>,
): { box: Rect | null; allMeasured: boolean } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let found = false;
  let allMeasured = true;
  for (const node of nodes) {
    if (node.parentId !== groupId) continue;
    found = true;
    if (node.measured?.width === undefined || node.measured?.height === undefined) {
      allMeasured = false;
    }
    const w = node.measured?.width ?? GROUP_DRAG_FALLBACK_W;
    const h = node.measured?.height ?? GROUP_DRAG_FALLBACK_H;
    minX = Math.min(minX, node.position.x);
    minY = Math.min(minY, node.position.y);
    maxX = Math.max(maxX, node.position.x + w);
    maxY = Math.max(maxY, node.position.y + h);
  }
  if (!found) return { box: null, allMeasured: true };
  return {
    box: { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
    allMeasured,
  };
}

/**
 * The Group growth needed when a duplicate drops clones into EXISTING Groups
 * (R2-A): a clone offset +24 from a source at the Group's edge can sit flush
 * against the border, so each affected Group expands to keep `GROUP_PADDING`.
 * Builds every affected Group's full member set (current members + the new
 * clones) in absolute coordinates — a clone's size is its source's measured size
 * (it is an exact copy; `clones[i]` pairs with `payload[i]`) — then defers the
 * only-up growth math to {@link planGroupGrowth}.
 * @param payload - The captured clipboard payload (same order as `clones`; carries each clone's source id).
 * @param clones - The freshly cloned wire nodes (parentId + parent-relative position).
 * @param ext - Existing Groups (outside the payload) that gained members → their absolute top-left.
 * @param allNodes - All current flow nodes (existing members + Group rects + source sizes).
 * @returns One growth per existing Group whose size must increase.
 */
function planDuplicateGroupGrowth(
  payload: ReadonlyArray<ClipboardNode>,
  clones: ReadonlyArray<{ parentId?: string; position: { x: number; y: number } }>,
  ext: ReadonlyMap<string, { x: number; y: number }>,
  allNodes: ReadonlyArray<Node>,
): GroupGrowth[] {
  if (ext.size === 0) return [];
  const byId = new Map(allNodes.map((node) => [node.id, node]));
  /**
   * A node's rendered size (measured first, then stored, then the drag fallback).
   * @param node - The flow node, or undefined when not found.
   * @returns Its width / height.
   */
  const sizeOf = (node: Node | undefined): { width: number; height: number } => ({
    width: node?.measured?.width ?? node?.width ?? GROUP_DRAG_FALLBACK_W,
    height: node?.measured?.height ?? node?.height ?? GROUP_DRAG_FALLBACK_H,
  });
  const inputs: GroupGrowthInput[] = [];
  for (const [groupId, groupAbs] of ext) {
    const groupNode = byId.get(groupId);
    if (groupNode === undefined) continue;
    const memberRects: Rect[] = [];
    for (const node of allNodes) {
      if (node.parentId !== groupId) continue;
      const size = sizeOf(node);
      memberRects.push({
        x: groupAbs.x + node.position.x,
        y: groupAbs.y + node.position.y,
        width: size.width,
        height: size.height,
      });
    }
    clones.forEach((clone, index) => {
      if (clone.parentId !== groupId) return;
      const size = sizeOf(byId.get(payload[index]?.id ?? ''));
      memberRects.push({
        x: groupAbs.x + clone.position.x,
        y: groupAbs.y + clone.position.y,
        width: size.width,
        height: size.height,
      });
    });
    inputs.push({
      groupId,
      rect: {
        x: groupNode.position.x,
        y: groupNode.position.y,
        width: groupNode.width ?? groupNode.measured?.width ?? GROUP_DRAG_FALLBACK_W,
        height:
          groupNode.height ?? groupNode.measured?.height ?? GROUP_DRAG_FALLBACK_H,
      },
      memberRects,
    });
  }
  return planGroupGrowth(inputs);
}

/**
 * Project a Yjs canvas node view into a ReactFlow node. ReactFlow's
 * `node.type` is the view `kind` (the `FLOW_NODE_TYPES` lookup key) and
 * `node.data` carries the full narrowed view for the body to render.
 * @param node - The canvas node view from the Yjs binding.
 * @returns The ReactFlow node.
 */
function toFlowNode(node: CanvasNodeView): Node {
  const flow: Node = {
    id: node.id,
    type: node.type,
    position: node.position,
    data: node.data as unknown as Record<string, unknown>,
  };
  // Group containment (group redesign): a member carries its parent
  // Group id so ReactFlow positions it relative to the Group. Only set when
  // present so top-level nodes stay unparented.
  if (node.parentId !== undefined) flow.parentId = node.parentId;
  // A Group with a stored authoritative size hands ReactFlow its width/height
  // (NodeResizer drives them) instead of deriving the box from members. Legacy
  // auto-container groups have no stored size and fall back to derived geometry.
  if (node.type === 'group') {
    const view = node.data as { width?: number; height?: number };
    if (view.width !== undefined && view.height !== undefined) {
      flow.width = view.width;
      flow.height = view.height;
    }
  }
  return flow;
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

  const { createNodeAt, createUploadNodeAt, pasteTextAt, pasteNodesAt } =
    useNodeCreation(projectId, spaceId);

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

  // Group drag carries its members natively (ReactFlow `parentId` positions
  // children relative to their Group), so there is no manual member-carry ref or
  // drag-start snapshot — onNodeDragStop alone resolves the whole result
  // (reparent + position + Group auto-expand). See planGroupDrag.
  const onNodeDragStop = React.useCallback(
    (_event: React.MouseEvent, _node: Node, nodes: Node[]): void => {
      if (readOnly) return;
      const byId = new Map(flowNodes.map((item) => [item.id, item]));
      /**
       * Resolve a node to absolute canvas coordinates (a member's stored
       * position is relative to its Group) + its rendered size — the form
       * planGroupDrag hit-tests against the Group rects.
       * @param item - The ReactFlow node.
       * @returns The node in the absolute DragNode form.
       */
      const toDragNode = (item: Node): DragNode => {
        const parent =
          item.parentId !== undefined ? byId.get(item.parentId) : undefined;
        const absPos = parent
          ? {
            x: parent.position.x + item.position.x,
            y: parent.position.y + item.position.y,
          }
          : item.position;
        return {
          id: item.id,
          type: item.type ?? '',
          parentId: item.parentId,
          absPos,
          size: {
            width: item.measured?.width ?? item.width ?? GROUP_DRAG_FALLBACK_W,
            height: item.measured?.height ?? item.height ?? GROUP_DRAG_FALLBACK_H,
          },
          // A locked Group never accepts a dragged-in node (planGroupDragStop
          // skips it); carry its lock state through so the planner can see it.
          locked: Boolean((item.data as { locked?: unknown }).locked),
        };
      };
      const ops = planGroupDrag(nodes.map(toDragNode), flowNodes.map(toDragNode));
      // Commit the whole drag-stop as ONE atomic undo entry: a reparent fires a
      // parent change AND a position change, plus any Group expansion — without
      // batching, captureTimeout:0 would split them so undo restored a
      // half-applied state. Apply reparents + positions BEFORE expansions, since
      // expandGroup reanchors members off their just-written positions.
      runCanvasUndoBatch(projectId, spaceId, () => {
        for (const r of ops.reparents) {
          setNodeParent(projectId, spaceId, r.id, r.parentId, r.position);
        }
        for (const p of ops.positions) {
          setNodePosition(projectId, spaceId, p.id, p.position);
        }
        for (const e of ops.expansions) {
          expandGroup(projectId, spaceId, e.groupId, e.position, e.width, e.height);
        }
      });
    },
    [readOnly, projectId, spaceId, flowNodes],
  );

  // Veto deletions BEFORE ReactFlow touches the local buffer: a locked group's
  // structure is frozen, so the group node, its members, AND every edge touching
  // them are protected. onBeforeDelete is the only layer that can stop removal at
  // the source — onDelete fires AFTER ReactFlow has already dropped nodes/edges
  // locally and cascaded a protected node's edges into the deletion. Read-only
  // viewers delete nothing.
  const onBeforeDelete = React.useCallback(
    async ({
      nodes: toDelete,
      edges: edgesToDelete,
    }: {
      nodes: Node[];
      edges: Edge[];
    }): Promise<boolean | { nodes: Node[]; edges: Edge[] }> => {
      if (readOnly) return false;
      const { survivors, blocked } = lockBlockedDeletion(
        toDelete,
        edgesToDelete,
        flowNodes,
      );
      // A lock vetoed part (or all) of the deletion — tell the user instead of
      // silently dropping it (the silent-fail from when lock first shipped).
      // This path covers ReactFlow-initiated deletes (keyboard Delete); the
      // right-click menu Delete shares the same `lockBlockedDeletion` guard via
      // `commitGuardedDelete`, so the lock protection + toast are one rule, not
      // duplicated per entry point.
      if (blocked) toast(t('canvas.contextMenu.lockedDeleteBlocked'));
      if (survivors.nodes.length === 0 && survivors.edges.length === 0) {
        return false;
      }
      return survivors;
    },
    [readOnly, flowNodes, t],
  );

  // Persist the (already lock-filtered, read-only-gated by onBeforeDelete)
  // deletion to Yjs in ONE removeElements transaction — node + edge deletion is a
  // single undo entry, so one undo restores BOTH (the reported bug: node came
  // back but the edge did not).
  const onDelete = React.useCallback(
    ({
      nodes: deletedNodes,
      edges: deletedEdges,
    }: {
      nodes: Node[];
      edges: Edge[];
    }): void => {
      removeElements(
        projectId,
        spaceId,
        deletedNodes.map((node) => node.id),
        deletedEdges.map((edge) => edge.id),
      );
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
    isGroup: false,
  });
  const [selectionMenu, setSelectionMenu] = React.useState({
    open: false,
    x: 0,
    y: 0,
  });
  const [edgeMenu, setEdgeMenu] = React.useState({
    open: false,
    x: 0,
    y: 0,
    edgeId: '',
  });

  // Create a node at a flow position and flag it for auto-selection once the
  // Yjs round-trip mirrors it back into the render buffer.
  const createNode = React.useCallback(
    (type: CreatableNodeType, position: { x: number; y: number }): void => {
      setSelectAfterCreate([createNodeAt(type, position)]);
    },
    [createNodeAt],
  );

  // ---- Upload (canvas-level: left button / drag-drop / file paste) ----
  // All three entries funnel here: classify each file, drop a `handling` node
  // at a staggered offset from `origin` (flow coords), then fill its content.
  // Media (image/video/audio) → presign → PUT → content URL. Everything else →
  // a text node whose content is read or extracted locally (text/* read
  // directly; pdf/docx/xlsx parsed in-browser). Both paths write every step
  // to Yjs so collaborators see the whole lifecycle, and both write a
  // fixed-English error onto the node on failure (never a toast). No file is
  // rejected. Created nodes are batch-selected once mirrored back.
  const processFiles = React.useCallback(
    (files: File[], origin: { x: number; y: number }): void => {
      if (readOnly || files.length === 0) return;
      const created: string[] = [];
      for (let i = 0; i < files.length; i += 1) {
        const file = files[i];
        const spec = fileToNodeSpec(file);
        const position = {
          x: origin.x + i * STAGGER_STEP_PX,
          y: origin.y + i * STAGGER_STEP_PX,
        };
        const nodeId = createUploadNodeAt(spec.nodeType, position);
        created.push(nodeId);
        if (spec.needsUpload) {
          void runMediaUpload(file, projectId, {
            presign: assetsApi.presign,
            putFile: assetsApi.putFile,
            onSuccess: (fileUrl) =>
              setNodeContent(projectId, spaceId, nodeId, fileUrl),
            // Fixed-English wire string — like AIGC failure messages and the
            // group default name. errorMessage is written to Yjs and rendered
            // raw to every collaborator, so it must not freeze the uploader's
            // locale into the shared doc. The filename is the locale-free part
            // telling the user which file failed.
            onFailure: () =>
              setNodeError(
                projectId,
                spaceId,
                nodeId,
                `Upload failed: ${file.name}`,
              ),
          });
        } else {
          void extractText(file)
            .then((text) => setNodeContent(projectId, spaceId, nodeId, text))
            .catch(() =>
              setNodeError(
                projectId,
                spaceId,
                nodeId,
                `Extraction failed: ${file.name}`,
              ),
            );
        }
      }
      if (created.length > 0) setSelectAfterCreate(created);
    },
    [readOnly, projectId, spaceId, createUploadNodeAt],
  );

  // Upload-button path: chrome posted picked files (the picker must open
  // synchronously inside the button click to keep user-activation, so it
  // lives in chrome and posts here). Drop them at the viewport centre; the
  // canvas owns the viewport. Always clear the mailbox afterward.
  const pendingUploadFiles = useCanvasStore((s) => s.pendingUploadFiles);
  const consumePendingUpload = useCanvasStore((s) => s.consumePendingUpload);
  React.useEffect(() => {
    if (!pendingUploadFiles) return;
    const files = pendingUploadFiles;
    const rect = containerRef.current?.getBoundingClientRect();
    if (rect && !readOnly) {
      const center = screenToFlowPosition({
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
      });
      processFiles(files, center);
    }
    consumePendingUpload();
  }, [
    pendingUploadFiles,
    readOnly,
    screenToFlowPosition,
    processFiles,
    consumePendingUpload,
  ]);

  // Drag-drop path: dropping OS files onto the canvas creates nodes at the
  // cursor. onDragOver must preventDefault (and only for file drags) so the
  // browser allows the drop; a node drag inside the canvas carries no Files.
  const onDragOver = React.useCallback(
    (event: React.DragEvent): void => {
      if (readOnly || !event.dataTransfer.types.includes('Files')) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    },
    [readOnly],
  );
  const onDrop = React.useCallback(
    (event: React.DragEvent): void => {
      if (readOnly) return;
      const files = event.dataTransfer.files;
      if (!files || files.length === 0) return;
      event.preventDefault();
      const point = screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });
      processFiles([...files], point);
    },
    [readOnly, screenToFlowPosition, processFiles],
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
      // R2: a right-click inside an editing text node or an open rename input
      // keeps the browser's native menu (copy / paste / spellcheck) — don't
      // hijack it. Every other canvas surface suppresses it (R1).
      if (isEditableTarget(event.target as Element | null)) return;
      event.preventDefault();
      if (readOnly) return;
      const locked = Boolean((node.data as { locked?: unknown }).locked);
      setNodeMenu({
        open: true,
        x: event.clientX,
        y: event.clientY,
        nodeId: node.id,
        locked,
        isGroup: node.type === 'group',
      });
    },
    [readOnly],
  );

  // Selection / edge right-click: ReactFlow leaked the browser menu on these two
  // surfaces (the reported bug). Suppress it + open the matching custom menu at
  // the cursor; viewers get neither (the readOnly gate — no mutating items).
  const onSelectionContextMenu = React.useCallback(
    (event: React.MouseEvent): void => {
      event.preventDefault();
      if (readOnly) return;
      setSelectionMenu({ open: true, x: event.clientX, y: event.clientY });
    },
    [readOnly],
  );

  const onEdgeContextMenu = React.useCallback(
    (event: React.MouseEvent, edge: Edge): void => {
      event.preventDefault();
      if (readOnly) return;
      setEdgeMenu({
        open: true,
        x: event.clientX,
        y: event.clientY,
        edgeId: edge.id,
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

      // File paste (screenshot / copied file) carries binary in
      // `clipboardData.files` — route it through the upload flow, dropped at
      // the viewport centre like a text paste. Checked first: a real file
      // paste also has these files (a plain-text paste does not).
      const files = event.clipboardData?.files;
      if (files && files.length > 0) {
        event.preventDefault();
        const rect = containerRef.current?.getBoundingClientRect();
        if (rect) {
          const center = screenToFlowPosition({
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
          });
          processFiles([...files], center);
        }
        return;
      }

      const text = event.clipboardData?.getData('text/plain') ?? '';

      const clipboardNodes = parseClipboardNodes(text);
      if (clipboardNodes && clipboardNodes.length > 0) {
        event.preventDefault();
        // Viewport-aware placement (R2-H, Figma-style): paste beside the source
        // when it's in view, else recenter on the current viewport so the paste
        // is never dropped off-screen after the canvas was scrolled away.
        const rect = containerRef.current?.getBoundingClientRect();
        let offset = { dx: PASTE_OFFSET_PX, dy: PASTE_OFFSET_PX };
        if (rect) {
          const tl = screenToFlowPosition({ x: rect.left, y: rect.top });
          const br = screenToFlowPosition({ x: rect.right, y: rect.bottom });
          offset = pasteAnchorOffset(
            clipboardBoundingBox(clipboardNodes),
            { x: tl.x, y: tl.y, width: br.x - tl.x, height: br.y - tl.y },
            PASTE_OFFSET_PX,
          );
        }
        setSelectAfterCreate(pasteNodesAt(clipboardNodes, offset));
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
  }, [readOnly, pasteNodesAt, pasteTextAt, screenToFlowPosition, processFiles]);

  React.useEffect(() => {
    /**
     * Document copy handler: serialize the selected nodes to the system
     * clipboard. No-op while read-only, editing a field, or with no selection.
     * @param event - The clipboard copy event.
     */
    const onCopy = (event: ClipboardEvent): void => {
      if (readOnly || isEditableTarget(document.activeElement)) return;
      const clipboardNodes = captureClipboard(
        flowNodesRef.current
          .filter((node) => node.selected)
          .map((node) => node.id),
        flowNodesRef.current,
      );
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
        parentId: node.parentId,
        locked: (node.data as { locked?: boolean }).locked,
      })),
    [flowNodes],
  );
  const groupOffer = React.useMemo(
    () => computeGroupToolbar(selectedIds, groupInfos),
    [selectedIds, groupInfos],
  );

  // Wrap the loose selection in a new Group (group redesign). The Group
  // stores its own width/height (the members' padded bounding box); members bind
  // back via `parentId` with positions relative to the Group. The new Group is
  // selected once it mirrors back so its toolbar is immediately usable.
  const groupSelection = React.useCallback((): void => {
    if (readOnly || groupOffer.kind !== 'group') return;
    const groupId = newId();
    const plan = planGroupCreation(flowNodes, selectedIds, groupId);
    if (!plan) return;
    const group = createGroupNode(
      groupId,
      plan.position,
      plan.width,
      plan.height,
      userId,
    );
    createGroup(projectId, spaceId, group, plan.members);
    // #1477: clear the marquee members' selection NOW so the mirror round-trip
    // window holds no stale multi-selection — otherwise ReactFlow routes a
    // right-click to the SELECTION menu instead of the Group menu. The Group
    // itself is selected once it mirrors back (setSelectAfterCreate).
    setFlowNodes(plan.nextNodes);
    setSelectAfterCreate([groupId]);
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
      // Always swallow a group / ungroup chord on the canvas so the browser's
      // native Cmd+G (find-again) can't fire — even when it doesn't apply to the
      // current selection (group mixed with loose nodes → no-op, B decision).
      const plan = planGroupShortcut(matchGroupShortcut(event), groupOffer.kind);
      if (plan.preventDefault) event.preventDefault();
      if (plan.run === 'group') groupSelection();
      else if (plan.run === 'ungroup') ungroupSelection();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [readOnly, groupOffer, groupSelection, ungroupSelection]);

  // ---- Right-click menu actions (context-menu slice) ----
  const requestRename = useCanvasStore((s) => s.requestRename);

  // Every delete entry point (keyboard, node / group / selection / edge menu)
  // funnels through this one guard so the lock protection + read-only gate can't
  // be bypassed by a new menu item (spec R3). It mirrors onBeforeDelete: lock-
  // filter, toast if anything was vetoed (R4), then persist the survivors in one
  // removeElements transaction. Reads the latest nodes through the ref so the
  // callback need not re-create on every mirror.
  const commitGuardedDelete = React.useCallback(
    (nodesToDelete: Node[], edgesToDelete: Edge[]): void => {
      if (readOnly) return;
      const { survivors, blocked } = lockBlockedDeletion(
        nodesToDelete,
        edgesToDelete,
        flowNodesRef.current,
      );
      if (blocked) toast(t('canvas.contextMenu.lockedDeleteBlocked'));
      if (survivors.nodes.length === 0 && survivors.edges.length === 0) return;
      removeElements(
        projectId,
        spaceId,
        survivors.nodes.map((node) => node.id),
        survivors.edges.map((edge) => edge.id),
      );
    },
    [readOnly, projectId, spaceId, t],
  );

  // The clipboard-portable form of the current selection — Group-aware: a
  // selected Group brings its members and a member resolves to absolute (see
  // captureClipboard). Used by the copy paths (Cmd+C / menu copy).
  const collectSelectedClipboard = React.useCallback(
    (): ClipboardNode[] =>
      captureClipboard(
        flowNodesRef.current
          .filter((node) => node.selected)
          .map((node) => node.id),
        flowNodesRef.current,
      ),
    [],
  );

  // The clipboard-portable form of the right-clicked node. Used by the node
  // menu's copy.
  const nodeMenuClipboard = React.useCallback(
    (): ClipboardNode[] =>
      captureClipboard([nodeMenu.nodeId], flowNodesRef.current),
    [nodeMenu.nodeId],
  );

  // Copy writes to the SYSTEM clipboard (same target as Cmd+C) so it round-trips
  // with paste here and elsewhere; a permission / browser failure (e.g. Firefox)
  // surfaces a toast rather than failing silently.
  const writeNodesToClipboard = React.useCallback(
    (clipboardNodes: ClipboardNode[]): void => {
      if (clipboardNodes.length === 0) return;
      void navigator.clipboard
        .writeText(serializeNodes(clipboardNodes))
        .catch(() => toast(t('canvas.contextMenu.clipboardError')));
    },
    [t],
  );

  // Duplicate clones the targets in place (fixed +24 nudge) WITHOUT touching the
  // clipboard: a Group brings its members; a lone member rejoins its existing
  // Group (externalParentAbs) and that Group auto-grows to keep 24px around the
  // new clone (R2-A); the clone of a locked source is itself unlocked (R2-F) and
  // a locked target is NOT blocked (R2-E — locked items can still be duplicated).
  // Clones + Group growth commit as ONE undo entry; the clones are selected once
  // mirrored back. Shared by node + group + selection menus + Cmd/Ctrl+D.
  const duplicateTargets = React.useCallback(
    (targetIds: ReadonlyArray<string>): void => {
      if (readOnly || targetIds.length === 0) return;
      const nodes = flowNodesRef.current;
      const payload = captureClipboard(targetIds, nodes);
      if (payload.length === 0) return;
      const ext = externalParentAbs(payload, nodes);
      const clones = cloneForPaste(
        payload,
        userId,
        { dx: PASTE_OFFSET_PX, dy: PASTE_OFFSET_PX },
        ext,
      );
      const growth = planDuplicateGroupGrowth(payload, clones, ext, nodes);
      runCanvasUndoBatch(projectId, spaceId, () => {
        for (const clone of clones) addNode(projectId, spaceId, clone);
        for (const g of growth) {
          expandGroup(projectId, spaceId, g.groupId, g.position, g.width, g.height);
        }
      });
      setSelectAfterCreate(clones.map((clone) => clone.id));
    },
    [readOnly, projectId, spaceId, userId],
  );

  const copySelection = React.useCallback((): void => {
    writeNodesToClipboard(collectSelectedClipboard());
  }, [writeNodesToClipboard, collectSelectedClipboard]);

  const duplicateSelection = React.useCallback((): void => {
    duplicateTargets(
      flowNodesRef.current
        .filter((node) => node.selected)
        .map((node) => node.id),
    );
  }, [duplicateTargets]);

  // Keyboard duplicate — double-platform (Cmd+D on mac, Ctrl+D on windows; see
  // matchDuplicateShortcut). Backs the menu's ⌘D / Ctrl+D hint so the shortcut
  // is real, not decorative. Gated like the other canvas shortcuts: no-op while
  // editing a field / node body or read-only.
  React.useEffect(() => {
    /**
     * Document keydown handler: duplicate the current selection in place.
     * @param event - The keyboard event.
     */
    const onKeyDown = (event: KeyboardEvent): void => {
      if (readOnly || isEditableTarget(document.activeElement)) return;
      if (!matchDuplicateShortcut(event)) return;
      event.preventDefault();
      duplicateSelection();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [readOnly, duplicateSelection]);

  // Selection-menu delete: cascade each selected Group to the WHOLE group (frame
  // + every member, via selectionDeletionIds) — the same cascade the single-node
  // menu uses — so deleting a selection that includes a Group removes its
  // contents, not just the frame. Plus every edge touching any deleted node,
  // routed through the lock guard.
  const deleteSelection = React.useCallback((): void => {
    const selectedIds = flowNodesRef.current
      .filter((node) => node.selected)
      .map((node) => node.id);
    if (selectedIds.length === 0) return;
    const ids = selectionDeletionIds(selectedIds, flowNodesRef.current);
    const targets = flowNodesRef.current.filter((node) => ids.has(node.id));
    const connected = flowEdges.filter(
      (edge) => ids.has(edge.source) || ids.has(edge.target),
    );
    commitGuardedDelete(targets, connected);
  }, [flowEdges, commitGuardedDelete]);

  // Node menu delete: the node — or, for a group, the WHOLE group (frame + every
  // member, via groupDeletionIds) — plus every edge touching any deleted node,
  // routed through the lock guard. Deleting a group deletes its contents too;
  // ungroup (onUngroup) is the separate action that keeps the members.
  const deleteNodeFromMenu = React.useCallback((): void => {
    const ids = groupDeletionIds(nodeMenu.nodeId, flowNodesRef.current);
    const targets = flowNodesRef.current.filter((node) => ids.has(node.id));
    if (targets.length === 0) return;
    const connected = flowEdges.filter(
      (edge) => ids.has(edge.source) || ids.has(edge.target),
    );
    commitGuardedDelete(targets, connected);
  }, [nodeMenu.nodeId, flowEdges, commitGuardedDelete]);

  const deleteEdgeFromMenu = React.useCallback((): void => {
    const edge = flowEdges.find((item) => item.id === edgeMenu.edgeId);
    if (edge) commitGuardedDelete([], [edge]);
  }, [flowEdges, edgeMenu.edgeId, commitGuardedDelete]);

  // Pane-menu Paste: reads the SYSTEM clipboard (async, needs the menu click's
  // user-activation), then mirrors the Cmd+V handler but anchored at the right-
  // click point — a marked node payload clones nodes with the first one landing
  // at the cursor, plain text makes a text node there.
  const pasteAtCursor = React.useCallback((): void => {
    if (readOnly) return;
    const point = screenToFlowPosition({ x: contextMenu.x, y: contextMenu.y });
    void navigator.clipboard
      .readText()
      .then((text) => {
        const clipboardNodes = parseClipboardNodes(text);
        if (clipboardNodes && clipboardNodes.length > 0) {
          const anchor = clipboardNodes[0].position;
          setSelectAfterCreate(
            pasteNodesAt(clipboardNodes, {
              dx: point.x - anchor.x,
              dy: point.y - anchor.y,
            }),
          );
        } else if (text.trim().length > 0) {
          setSelectAfterCreate([pasteTextAt(text, point)]);
        }
      })
      .catch(() => toast(t('canvas.contextMenu.clipboardError')));
  }, [
    readOnly,
    screenToFlowPosition,
    contextMenu.x,
    contextMenu.y,
    pasteNodesAt,
    pasteTextAt,
    t,
  ]);

  // Frontend-owned mutation surfaced to the node bodies through context: a
  // node knows its new name but not the project / space it lives in. The
  // ReactFlow wrapper pre-binds this to each node's id.
  // Empty-node double-click / Upload-menu: ONE hidden file input the canvas
  // triggers for the target node, filling THAT node with the upload (vs creating
  // a new node like the drop path). The target id is held in a ref across the
  // picker's async open; the change handler fills it.
  const uploadInputRef = React.useRef<HTMLInputElement>(null);
  const uploadTargetRef = React.useRef<string | null>(null);
  const activateNodeUpload = React.useCallback(
    (nodeId: string, modality: Modality): void => {
      if (readOnly) return;
      const accept = UPLOAD_ACCEPT[modality];
      const input = uploadInputRef.current;
      if (!accept || !input) return; // 3d / web have no picker yet
      uploadTargetRef.current = nodeId;
      input.accept = accept;
      input.value = '';
      input.click();
    },
    [readOnly],
  );
  // Node menu Upload: open the file picker for the right-clicked node and fill
  // (or replace) its content — the menu form of the empty-node double-click.
  // The node's ReactFlow `type` is its modality (text / image / video / audio /
  // ...); `activateNodeUpload` no-ops for modalities without a picker (3d / web)
  // and for read-only viewers.
  const uploadNodeFromMenu = React.useCallback((): void => {
    const node = flowNodesRef.current.find(
      (item) => item.id === nodeMenu.nodeId,
    );
    if (node?.type) activateNodeUpload(node.id, node.type as Modality);
  }, [nodeMenu.nodeId, activateNodeUpload]);
  const onUploadInputChange = React.useCallback(
    (event: React.ChangeEvent<HTMLInputElement>): void => {
      const file = event.target.files?.[0];
      const nodeId = uploadTargetRef.current;
      uploadTargetRef.current = null;
      if (!file || !nodeId) return;
      void fillNodeFromFile(nodeId, file, projectId, {
        presign: assetsApi.presign,
        putFile: assetsApi.putFile,
        extractText,
        setHandling: (id) => setNodeHandling(projectId, spaceId, id),
        setContent: (id, content) =>
          setNodeContent(projectId, spaceId, id, content),
        setError: (id, message) => setNodeError(projectId, spaceId, id, message),
      });
    },
    [projectId, spaceId],
  );

  const actions = React.useMemo<CanvasActions>(
    () => ({
      renameNode: (nodeId: string, name: string): void =>
        setNodeName(projectId, spaceId, nodeId, name),
      deleteEdge: (edgeId: string): void => {
        if (readOnly) return;
        removeEdge(projectId, spaceId, edgeId);
      },
      setNodeContent: (nodeId: string, content: string): void => {
        if (readOnly) return;
        // The RHS is the imported data-layer writer; the action key only shadows
        // the name (object keys aren't in the body's scope — no recursion). Binds
        // the text body's inline-edit commit to this project/space (#1470).
        setNodeContent(projectId, spaceId, nodeId, content);
      },
      commitGroupResize: (groupId, rect): void => {
        if (readOnly) return;
        // Bug 11: a resize that grows over a loose (top-level) node whose CENTER
        // now lands inside the Group absorbs it — the same center-in membership
        // rule the drag path uses, extended to resize. Only loose nodes join;
        // existing members are never expelled (the native clamp keeps them ≥
        // padding inside).
        const newRect = {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
        };
        const loose = flowNodesRef.current
          .filter(
            (node) =>
              node.parentId === undefined &&
              node.type !== 'group' &&
              node.id !== groupId,
          )
          .map((node) => ({
            id: node.id,
            rect: {
              x: node.position.x,
              y: node.position.y,
              width: node.measured?.width ?? node.width ?? GROUP_DRAG_FALLBACK_W,
              height:
                node.measured?.height ?? node.height ?? GROUP_DRAG_FALLBACK_H,
            },
          }));
        const joins = planResizeJoin(groupId, newRect, loose);
        // ReactFlow's native per-control clamp (GroupResizer bounds) already keeps
        // every member ≥ GROUP_PADDING inside — even on a fast release — so commit
        // the rect VERBATIM (no post-commit repair). ReactFlow reanchored the
        // members during the drag (their relative positions are tracked in the
        // render buffer); persist those so the next Yjs mirror keeps them. One
        // atomic undo entry: the Group's new size/position, its members, PLUS any
        // newly absorbed loose nodes.
        runCanvasUndoBatch(projectId, spaceId, () => {
          resizeGroup(
            projectId,
            spaceId,
            groupId,
            { x: rect.x, y: rect.y },
            rect.width,
            rect.height,
          );
          for (const child of flowNodesRef.current) {
            if (child.parentId === groupId) {
              setNodePosition(projectId, spaceId, child.id, child.position);
            }
          }
          for (const join of joins) {
            setNodeParent(projectId, spaceId, join.id, join.parentId, join.position);
          }
        });
      },
      activateNodeUpload,
    }),
    [projectId, spaceId, readOnly, activateNodeUpload],
  );

  // A Group carries its own authoritative width/height (stored in Yjs, fed via
  // toFlowNode), so the render path no longer derives geometry — it only
  // topo-sorts (parent before child) and applies the lock-freeze. Groups paint
  // at zIndex 0 so their members render above them.
  const renderNodes = React.useMemo<Node[]>(() => {
    // ReactFlow requires a Group (parent) to precede its members in the array;
    // topo-sort enforces that. A Group carries its own authoritative width/height
    // (set in toFlowNode), so there is no derived-geometry pass — it renders at
    // its stored size and ReactFlow positions members relative to it.
    const ordered = topoSortByParent(flowNodes);
    const groups = ordered.filter((node) => node.type === 'group');
    const rest = ordered.filter((node) => node.type !== 'group');
    // Locked nodes are frozen in place: any locked node (incl. a locked Group as
    // a whole) and the members of a locked Group render non-draggable. Groups
    // sit at zIndex 0 so members paint above them.
    const frozen = lockedNodeIds(ordered);
    return [
      ...groups.map((node) => {
        // Per-control resize bounds: each of the 8 controls (4 edges + 4 corners)
        // gets a member-derived min so ReactFlow's NATIVE clamp hard-stops it at
        // "members + GROUP_PADDING" (see GroupResizer). Attached to data for the
        // node wrapper to read.
        const { box, allMeasured } = groupMembersLocalBox(node.id, ordered);
        const width = node.width ?? node.measured?.width ?? GROUP_DRAG_FALLBACK_W;
        const height =
          node.height ?? node.measured?.height ?? GROUP_DRAG_FALLBACK_H;
        let bounds = groupResizeBounds(
          box,
          width,
          height,
          GROUP_PADDING,
          GROUP_MIN_SIZE,
        );
        // R1 guard: an unmeasured member would shrink `box` and yield a bound up
        // to GROUP_DRAG_FALLBACK short — block shrinking that frame (min = the
        // current size; growth is still allowed) until the member measures.
        if (!allMeasured) {
          bounds = bounds.map((b) => ({ ...b, minWidth: width, minHeight: height }));
        }
        return {
          ...node,
          data: {
            ...(node.data as Record<string, unknown>),
            groupResizeBounds: bounds,
          },
          draggable: !readOnly && !frozen.has(node.id),
          zIndex: 0,
        };
      }),
      ...rest.map((node) =>
        frozen.has(node.id) ? { ...node, draggable: false } : node,
      ),
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
        onDragOver={onDragOver}
        onDrop={onDrop}
      >
        {/* Hidden picker the canvas triggers for an empty node's double-click /
            Upload-menu fill (accept set per modality at trigger time). */}
        <input
          ref={uploadInputRef}
          type='file'
          className='hidden'
          aria-hidden='true'
          tabIndex={-1}
          data-testid='canvas-upload-input'
          onChange={onUploadInputChange}
        />
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
          onNodeDragStop={onNodeDragStop}
          onDelete={onDelete}
          onBeforeDelete={onBeforeDelete}
          onConnect={onConnect}
          onPaneContextMenu={onPaneContextMenu}
          onNodeContextMenu={onNodeContextMenu}
          onSelectionContextMenu={onSelectionContextMenu}
          onEdgeContextMenu={onEdgeContextMenu}
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
          // Double-click on the empty canvas must NOT zoom (#4): an accidental
          // zoom-in on a misclick is jarring, and the gesture is reserved for a
          // future use. Zoom stays on the viewport-toolbar buttons / Cmd-+/- /
          // ctrl-wheel / pinch — ReactFlow's default zoomOnDoubleClick is true.
          zoomOnDoubleClick={false}
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
            <GroupSelectionToolbar
              offer={groupOffer.kind === 'ungroup' ? 'ungroup' : 'group'}
              onGroup={groupSelection}
              onUngroup={ungroupSelection}
              bgOpen={bgMenuOpen}
              onBgOpenChange={setBgMenuOpen}
              bgValue={selectedGroupBg}
              onPickBg={pickGroupBackground}
            />
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
          onPaste={pasteAtCursor}
        />
        <NodeContextMenu
          open={nodeMenu.open}
          x={nodeMenu.x}
          y={nodeMenu.y}
          locked={nodeMenu.locked}
          target={nodeMenu.isGroup ? 'group' : 'node'}
          onOpenChange={(open) => setNodeMenu((prev) => ({ ...prev, open }))}
          onToggleLock={onToggleNodeLock}
          // Upload fills / replaces the node's content (node-only; its presence
          // also gates the Generate / Upload / Tools block). The menu only opens
          // for editors (onNodeContextMenu returns early when read-only), and
          // activateNodeUpload no-ops for read-only / pickerless modalities.
          onUpload={nodeMenu.isGroup ? undefined : uploadNodeFromMenu}
          // Rename is frozen on a locked node / group (the name is on-canvas
          // content); hide it rather than offer a silent no-op.
          onRename={
            nodeMenu.locked ? undefined : () => requestRename(nodeMenu.nodeId)
          }
          onDelete={deleteNodeFromMenu}
          // Copy / duplicate work for a node OR a group (R2-D): a group copies /
          // duplicates with its members (capture / clone are Group-aware).
          onCopy={() => writeNodesToClipboard(nodeMenuClipboard())}
          onDuplicate={() => duplicateTargets([nodeMenu.nodeId])}
          // Ungroup releases a group's members; a locked group is frozen.
          onUngroup={
            nodeMenu.isGroup && !nodeMenu.locked
              ? () => removeNode(projectId, spaceId, nodeMenu.nodeId)
              : undefined
          }
        />
        <SelectionContextMenu
          open={selectionMenu.open}
          x={selectionMenu.x}
          y={selectionMenu.y}
          onOpenChange={(open) =>
            setSelectionMenu((prev) => ({ ...prev, open }))
          }
          // Group is offered only for an all-loose 2+ selection (same rule as
          // the floating toolbar + Cmd/Ctrl+G).
          onGroup={groupOffer.kind === 'group' ? groupSelection : undefined}
          onCopy={copySelection}
          onDuplicate={duplicateSelection}
          onDelete={deleteSelection}
        />
        <EdgeContextMenu
          open={edgeMenu.open}
          x={edgeMenu.x}
          y={edgeMenu.y}
          onOpenChange={(open) => setEdgeMenu((prev) => ({ ...prev, open }))}
          onDelete={deleteEdgeFromMenu}
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
