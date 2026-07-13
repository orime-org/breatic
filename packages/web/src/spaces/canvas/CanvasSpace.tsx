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
  useStoreApi,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type OnConnectEnd,
  type OnConnectStart,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { LocateFixed } from 'lucide-react';
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
  setNodeHandling,
  completeNodeHandling,
  failNodeHandling,
  isNodeHandling,
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
import { FIT_VIEW_OPTIONS } from '@web/spaces/canvas/viewport-config';
import {
  matchGroupShortcut,
  planGroupShortcut,
} from '@web/spaces/canvas/canvas-group-shortcut';
import { matchHistoryShortcut } from '@web/spaces/canvas/canvas-history-shortcut';
import {
  fileToNodeSpec,
  fillNodeFromFile,
  runMediaUpload,
  computeDeletedAssetEntries,
  type UploadNodeSpec,
  type UploadedInfo,
} from '@web/spaces/canvas/canvas-upload';
import { hashFile } from '@web/data/upload/hash';
import { putFileWithRetry } from '@web/data/upload/upload-retry';
import {
  stashRetryFile,
  getRetryFile,
  clearRetryFile,
  hasRetryFile,
} from '@web/spaces/canvas/upload-retry-files';
import { extractText } from '@web/spaces/canvas/text-extract';
import {
  canConnect,
  resolveClickConnectRejection,
} from '@web/spaces/canvas/lib/connection-rules';
import {
  resolvePanelSelectionAction,
  type PanelSelectionSnapshot,
} from '@web/spaces/canvas/lib/generate-panel-selection';
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
import { useStableList } from '@web/spaces/canvas/use-stable-list';
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
import { CanvasMiniMap } from '@web/spaces/canvas/CanvasMiniMap';
import { ConnectCreateMenu } from '@web/spaces/canvas/ConnectCreateMenu';
import {
  isBlankCanvasRelease,
  resolveReleaseElement,
  resolveConnectCreateIntent,
} from '@web/spaces/canvas/lib/connect-create';
import { GeneratePanelContainer } from '@web/spaces/canvas/generate/GeneratePanelContainer';
import { EdgeContextMenu } from '@web/spaces/canvas/EdgeContextMenu';
import { GroupSelectionToolbar } from '@web/spaces/canvas/GroupSelectionToolbar';
import { NodeContextMenu } from '@web/spaces/canvas/NodeContextMenu';
import { SelectionContextMenu } from '@web/spaces/canvas/SelectionContextMenu';
import {
  mergeMirroredEdgeSelection,
  mergeMirroredSelection,
  reconcileSelection,
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
  EMPTY_NODE_SIZE,
  isCreatableNodeType,
  type CreatableNodeType,
} from '@web/spaces/canvas/node-factory';
import { FLOW_NODE_TYPES } from '@web/spaces/canvas/nodes/flow-node-types';
import { useNodeCreation } from '@web/spaces/canvas/use-node-creation';
import { useCanvasStore } from '@web/stores';
import { useCanvasGraphStore } from '@web/stores/canvas-graph';
import { useCurrentUserStore } from '@web/stores/current-user';
import { useSpaceOperationsStore } from '@web/stores/space-operations';

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

/**
 * Operation id for the drop/upload batch prefix in the per-space operation
 * registry (#1617). Registered synchronously when a multi-file drop starts so
 * the tab-close guard blocks a close during the config-fetch + node-creation
 * window, before the per-node upload operations exist. Constant (not per-drop):
 * concurrent drops share it and the reference-counted registry keeps the space
 * busy until every batch's prefix settles.
 */
const UPLOAD_BATCH_OP = 'upload-batch';

const DELETE_KEYS = ['Backspace', 'Delete'];

/**
 * Background dot grid base. Doubled from the old gap (12) + size (1) so the
 * dots read at 100% zoom the way they used to at 200% — bigger + sparser —
 * while still scaling with zoom (a frozen, non-scaling grid felt disorienting).
 */
const DOT_GAP_PX = 24;
const DOT_SIZE_PX = 2;

/**
 * Snap-to-grid step (#1663), aligned to the visible background dots
 * (`DOT_GAP_PX`) so a snapped node lands on a dot the user can actually see.
 * Module-level for a stable array reference across renders.
 */
const SNAP_GRID: [number, number] = [DOT_GAP_PX, DOT_GAP_PX];

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

// Footprint assumed for a node ReactFlow has not measured yet (drag hit-test +
// group geometry). Uses the real empty-node size (288×192) so an unmeasured
// node's center isn't mis-estimated for the one frame before it measures (the
// old 160×96 guess shifted the center ~64px and could flip a borderline
// center-in-group decision).
const GROUP_DRAG_FALLBACK_W = EMPTY_NODE_SIZE.width;
const GROUP_DRAG_FALLBACK_H = EMPTY_NODE_SIZE.height;

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
 * Node kind → localized display-name key, for the connection-rules rejection
 * toast ("Audio can't connect into Image"). An unknown (corrupt Yjs) kind
 * falls back to the raw string at the call site.
 */
const KIND_LABEL_KEY: Record<string, string> = {
  text: 'canvas.connection.kindText',
  image: 'canvas.connection.kindImage',
  audio: 'canvas.connection.kindAudio',
  video: 'canvas.connection.kindVideo',
  '3d': 'canvas.connection.kind3d',
  web: 'canvas.connection.kindWeb',
  annotation: 'canvas.connection.kindAnnotation',
  group: 'canvas.connection.kindGroup',
};

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
  // The ReactFlow render buffer lives in a dedicated plain zustand store
  // (#1647 step 4), not local state, so discrete consumers can subscribe to
  // just their slice instead of the whole component re-running on every change.
  const flowNodes = useCanvasGraphStore((s) => s.flowNodes);
  const setFlowNodes = useCanvasGraphStore((s) => s.setFlowNodes);
  const flowEdges = useCanvasGraphStore((s) => s.flowEdges);
  const setFlowEdges = useCanvasGraphStore((s) => s.setFlowEdges);
  // Clear the shared buffer BEFORE this space's first paint. A space switch
  // remounts this body (keyed on space id), but the buffer is a global store
  // that survives the remount, so it still holds the PREVIOUS space's nodes on
  // the new mount. A passive unmount cleanup runs only after the next space has
  // already painted → the new space flashes the old nodes for one frame
  // (adversarial finding, #1647). `useLayoutEffect` on mount resets before
  // paint, restoring the pre-store `useState([])` empty start; the mirror
  // effect below then fills it with this space's nodes. Also reset on unmount so
  // a closed space leaves nothing lingering in the singleton.
  React.useLayoutEffect(() => {
    useCanvasGraphStore.getState().reset();
    return () => useCanvasGraphStore.getState().reset();
  }, []);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const {
    screenToFlowPosition,
    zoomIn,
    zoomOut,
    fitView,
    zoomTo,
    setCenter,
    getInternalNode,
  } = useReactFlow();

  // ---- Zoom bridge (chrome toolbar ↔ ReactFlow) ----
  // The zoom toolbar lives in chrome, outside this ReactFlowProvider, so it
  // can't read or drive the real zoom. Mirror the live zoom into the canvas
  // store for the toolbar's read-out, and run the toolbar's commands (posted
  // through the store mailbox) against ReactFlow here, where the API exists.
  const setZoom = useCanvasStore((s) => s.setZoom);
  // Minimap visibility (single source, #1548) — toggled by the viewport
  // toolbar, consumed here to mount/unmount the map.
  const minimapVisible = useCanvasStore((s) => s.minimapVisible);
  const snapToGrid = useCanvasStore((s) => s.snapToGrid);
  const openGeneratePanel = useCanvasStore((s) => s.openGeneratePanel);
  const closeGeneratePanel = useCanvasStore((s) => s.closeGeneratePanel);
  const generatePanelNodeId = useCanvasStore((s) => s.generatePanelNodeId);
  const referencePickForNodeId = useCanvasStore(
    (s) => s.referencePickForNodeId,
  );
  const endReferencePick = useCanvasStore((s) => s.endReferencePick);
  // Banner Exit (a11y, adversarial round-1): the Exit button unmounts with
  // the banner, dropping keyboard focus to <body>. Hand focus to the panel's
  // pick trigger — still mounted, because the pick keeps the panel open. The
  // trigger is in the DOM right now (setState re-renders later), so the
  // synchronous focus lands before the banner unmounts.
  const onExitReferencePick = React.useCallback((): void => {
    endReferencePick();
    document
      .querySelector<HTMLElement>('[data-testid="generate-tool-reference"]')
      ?.focus();
  }, [endReferencePick]);
  // Pick-end focus catch-all (adversarial round-2, a11y): the Exit hand-off
  // only works when the trigger is enabled + mounted. When it is disabled (a
  // t2i switch mid-pick) or the pick ends by another path (panel X, host node
  // deleted), focus drops to <body>. Whenever a pick ENDS with focus orphaned
  // there, return it to the canvas container so keyboard users stay in
  // context. Focus already placed (the Exit hand-off succeeded) is left alone.
  const wasPickingRef = React.useRef(false);
  React.useEffect(() => {
    const wasPicking = wasPickingRef.current;
    wasPickingRef.current = referencePickForNodeId != null;
    if (
      wasPicking &&
      referencePickForNodeId == null &&
      (document.activeElement == null ||
        document.activeElement === document.body)
    ) {
      containerRef.current?.focus();
    }
  }, [referencePickForNodeId]);
  const rfZoom = useStore((s) => s.transform[2]);
  React.useEffect(() => {
    setZoom(rfZoom);
  }, [rfZoom, setZoom]);
  // Panel ⇄ selection binding (user-ratified 2026-07-11) — one state machine,
  // not one-shot effects: while the binding is not yet ESTABLISHED (host never
  // seen selected), keep asserting the host as the sole selection; once
  // established, the host losing selection closes the panel through ANY path
  // (another node clicked, empty canvas clicked, menu-create / paste
  // auto-selecting the new node, grouping…). Round-1 adversarial: a one-shot
  // open effect (keyed on the id changing) missed the canvas-remount and
  // same-host-reopen paths and left the close guard permanently disarmed on
  // an unselected host. Pick mode holds the machine; exiting the pick (or
  // reopening the panel, which clears it) re-asserts the binding. Rationale +
  // rule table live in lib/generate-panel-selection.ts.
  const rfStoreApi = useStoreApi();
  const selectOnlyNode = React.useCallback(
    (nodeId: string): void => {
      setFlowNodes((current) =>
        reconcileSelection(current, (n) => n.id === nodeId),
      );
      // "Sole selection" includes edges: a selected edge left behind would
      // keep its scissors affordance + Delete-key claim under the open panel
      // (native node clicks clear edge selection the same way).
      setFlowEdges((current) => reconcileSelection(current, () => false));
      // A native single node click also clears xyflow's marquee state; the
      // programmatic path must too, or a pre-open marquee's NodesSelection
      // rect shrinks onto the host and swallows clicks (round-2 adversarial).
      rfStoreApi.setState({ nodesSelectionActive: false });
    },
    [setFlowNodes, setFlowEdges, rfStoreApi],
  );
  const hostSelected = React.useMemo((): boolean | null => {
    if (generatePanelNodeId == null) return null;
    const host = flowNodes.find((n) => n.id === generatePanelNodeId);
    return host ? host.selected === true : null;
  }, [flowNodes, generatePanelNodeId]);
  const panelSelectionRef = React.useRef<PanelSelectionSnapshot>({
    panelNodeId: null,
    hostSelected: null,
    picking: false,
  });
  React.useEffect(() => {
    const prev = panelSelectionRef.current;
    const next = {
      panelNodeId: generatePanelNodeId,
      hostSelected,
      picking: referencePickForNodeId != null,
    };
    panelSelectionRef.current = next;
    const action = resolvePanelSelectionAction(prev, next);
    if (action === 'close') {
      closeGeneratePanel();
    } else if (action === 'select' && generatePanelNodeId != null) {
      selectOnlyNode(generatePanelNodeId);
    }
  }, [
    generatePanelNodeId,
    hostSelected,
    referencePickForNodeId,
    closeGeneratePanel,
    selectOnlyNode,
  ]);

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
    else if (command === 'fit') fitView(FIT_VIEW_OPTIONS);
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
  }, [nodes, setFlowNodes]);

  // Mirror the Yjs-observed edges into ReactFlow's render buffer the same way
  // as nodes — a LOCAL edges array + onEdgesChange. Without a local buffer,
  // ReactFlow can't track per-user edge selection: the `selected` flag never
  // reaches the scissors edge (so no scissors appears) and the delete key has
  // no selected edge to remove. Yjs stays the source of truth; the viewer
  // read-only flag rides on each edge's `data` so the scissors hides for
  // viewers, and local `selected` is carried forward across Yjs re-mirrors.
  React.useEffect(() => {
    setFlowEdges((prev) =>
      mergeMirroredEdgeSelection(
        prev,
        edges.map((edge) => ({ ...toFlowEdge(edge), data: { readOnly } })),
      ),
    );
  }, [edges, readOnly, setFlowEdges]);

  const onNodesChange = React.useCallback(
    (changes: NodeChange[]): void => {
      setFlowNodes((current) => applyNodeChanges(changes, current));
    },
    [setFlowNodes],
  );

  const onEdgesChange = React.useCallback(
    (changes: EdgeChange[]): void => {
      setFlowEdges((current) => applyEdgeChanges(changes, current));
    },
    [setFlowEdges],
  );

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

  // Activity-feed reporters (ADR 2026-07-04): fire-and-forget behind the
  // canvas write-backs. The upload handshake failure surfaces a toast (the
  // audit trail lost a verified event); the delete report stays silent —
  // the deletion itself already succeeded and re-prompting the user would
  // read as a failed delete.
  const reportUploadedAsset = React.useCallback(
    (nodeId: string, info: UploadedInfo, file: File): void => {
      void assetsApi
        .reportUploaded({
          projectId,
          kind: info.kind,
          nodeId,
          spaceId,
          // Regular path carries the stored key; a dedup hit reports the
          // hash instead (nothing was uploaded — the server re-verifies
          // the ledger row, #1609 B.2). hash is null only on the hashing
          // worker degrade, where the upload stays untracked (plan §6).
          ...(info.hash !== null && { hash: info.hash }),
          ...(info.dedup === true ? { dedup: true as const } : {}),
          ...(info.key !== undefined && { key: info.key }),
          metadata: {
            filename: file.name,
            size: file.size,
            mimeType: file.type,
          },
        })
        .catch(() => toast(t('canvas.activity.reportFailed')));
    },
    [projectId, spaceId, t],
  );
  const reportDeletedAssets = React.useCallback(
    (deletedNodes: Node[]): void => {
      // flowNodesRef still holds the deleted nodes here (Yjs removal
      // propagates async); computeDeletedAssetEntries excludes them and
      // skips URLs still referenced by a surviving node (pasted copies).
      const entries = computeDeletedAssetEntries(
        deletedNodes,
        flowNodesRef.current,
        spaceId,
      );
      if (entries.length === 0) return;
      void assetsApi.reportDeleted({ projectId, entries }).catch(() => {
        // Silent: the deletion already succeeded; a toast here would read
        // as a failed delete. The feed misses one audit entry at worst.
      });
    },
    [projectId, spaceId],
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
      reportDeletedAssets(deletedNodes);
    },
    [projectId, spaceId, reportDeletedAssets],
  );

  // Connection rules (spec §9.1): consulted live during a connection drag —
  // ReactFlow styles an invalid target and refuses the drop, so an audio /
  // video output visibly can't wire into an image input. Reads the mirror
  // via getState() (not a render closure) because ReactFlow calls this on
  // every pointer move of an in-flight drag.
  const isValidConnection = React.useCallback(
    (connection: Connection | Edge): boolean => {
      // Self-loop: xyflow's STRICT mode only checks handle types, so a drag
      // from a node's source handle onto its own target handle would show a
      // valid snap and then silently no-op at the addEdge write boundary —
      // reject it here so the gesture reads invalid while still in-flight.
      if (connection.source === connection.target) return false;
      const { flowNodes } = useCanvasGraphStore.getState();
      const sourceKind =
        flowNodes.find((n) => n.id === connection.source)?.type ?? '';
      const targetKind =
        flowNodes.find((n) => n.id === connection.target)?.type ?? '';
      return canConnect(sourceKind, targetKind);
    },
    [],
  );

  // Localized node-kind display name for the connection-rules toast; an
  // unknown (corrupt Yjs) kind falls back to the raw string.
  const kindLabel = React.useCallback(
    (kind: string): string => {
      const key = KIND_LABEL_KEY[kind];
      return key ? t(key) : kind;
    },
    [t],
  );

  // Drag-to-blank create + connect (batch-2 item 3): armed by onConnectEnd
  // when an output-stub drag releases over the blank pane.
  const [connectCreate, setConnectCreate] = React.useState({
    open: false,
    x: 0,
    y: 0,
    sourceId: '',
    sourceKind: '',
  });

  // Magnetic-handle zone gate (adversarial round-4): xyflow resolves a wire's
  // target via elementFromPoint SYNCHRONOUSLY in the same tick it starts the
  // connection (startConnection → onConnectStart → isValidHandle, all in one
  // onPointerMove). A React class toggled off connection.inProgress commits one
  // frame too late, so the first move still hit-tests the live 36px handle
  // zones and could hijack to a neighbor. onConnectStart runs synchronously
  // BEFORE that first isValidHandle, so adding the class here — which
  // elementFromPoint's own style flush applies immediately — stands every
  // handle's ::before zone down for the whole drag, with no first-frame window.
  const onConnectDragStart = React.useCallback<OnConnectStart>(() => {
    containerRef.current?.classList.add('canvas-connecting');
  }, []);
  const clearConnectingClass = React.useCallback((): void => {
    containerRef.current?.classList.remove('canvas-connecting');
  }, []);

  // A DRAG-connect refused by the rules gets a WHY (user 2026-07-10):
  // "Audio can't connect into Image". Fired once on release — never during the
  // drag (isValidConnection runs per pointer-move; toasting there would spam).
  // Click-connect has its OWN handler below: xyflow's onClickConnectEnd hands
  // over the DRAG connection state, which a pure tap-tap gesture never
  // populates (round-3 adversarial — reusing this handler there was a no-op).
  const onConnectEnd = React.useCallback<OnConnectEnd>(
    (event, state) => {
      clearConnectingClass();
      // An OUTPUT-stub drag released over BLANK canvas is not a cancel: it
      // opens the create + connect menu at the release point (batch-2 item 3).
      // The release element comes from elementFromPoint at the RELEASE
      // coordinates — event.target lies twice (adversarial round-1): a
      // touchend targets the element the touch STARTED on (the handle), and
      // mouse releases land on invisible hit layers (edge interaction
      // strokes, the NodesSelection rect) the user perceives as blank.
      const point =
        'changedTouches' in event ? event.changedTouches[0] : event;
      // elementsFromPoint (the STACK) + skip the transient connection-line
      // SVG that sits on top during the drag — elementFromPoint (singular)
      // can return that layer instead of the real target (adversarial r2).
      const releaseEl = resolveReleaseElement(
        document.elementsFromPoint(point.clientX, point.clientY),
      );
      const intent = resolveConnectCreateIntent({
        fromNodeId: state.fromNode?.id ?? null,
        fromNodeKind: state.fromNode?.type,
        fromHandleType: state.fromHandle?.type ?? null,
        toNodeId: state.toNode?.id ?? null,
        releasedOnPane: isBlankCanvasRelease(releaseEl),
        readOnly,
      });
      if (intent) {
        setConnectCreate({
          open: true,
          x: point.clientX,
          y: point.clientY,
          sourceId: intent.sourceId,
          sourceKind: intent.sourceKind,
        });
        return;
      }
      if (state.isValid !== false || !state.fromNode || !state.toNode) return;
      // A drag may start from either end — resolve which node is the source.
      const fromIsSource = state.fromHandle?.type === 'source';
      const sourceKind =
        (fromIsSource ? state.fromNode : state.toNode).type ?? '';
      const targetKind =
        (fromIsSource ? state.toNode : state.fromNode).type ?? '';
      // Only explain OUR rule rejections; an invalid drop for any other
      // ReactFlow reason keeps the default silent snap-back.
      if (canConnect(sourceKind, targetKind)) return;
      toast.error(
        t('canvas.connection.rejected', {
          source: kindLabel(sourceKind),
          target: kindLabel(targetKind),
        }),
      );
    },
    [t, kindLabel, readOnly, clearConnectingClass],
  );

  // CLICK-connect rejection toast (round-3 adversarial): reconstruct the
  // tap-tap gesture ourselves — record the armed handle on click-start, and on
  // click-end resolve the second click's node from the event target. The pure
  // resolver decides whether the pair was refused by the rules; cancels /
  // self taps / allowed pairs stay silent (a valid pair writes its edge via
  // onConnect as usual).
  const clickConnectFromRef = React.useRef<{
    nodeId: string;
    handleType: 'source' | 'target';
  } | null>(null);
  const onClickConnectStart = React.useCallback<OnConnectStart>(
    (_event, params) => {
      clickConnectFromRef.current = params.nodeId
        ? {
          nodeId: params.nodeId,
          handleType: params.handleType ?? 'source',
        }
        : null;
      // The zone stand-down is DRAG-only (adversarial round-5): the
      // click-connect path resolves each tap by a LITERAL Handle onClick (no
      // connectionRadius proximity net), so the 36px ::before zone must stay
      // live for a tap in the zone to arm / complete a connection at all —
      // disabling it broke click-connect. And its cleanup fires only on the
      // second tap, so gating here also stuck the class on an abandoned pick.
      // The round-4 hijack is drag-specific (elementFromPoint during the
      // continuous onPointerMove), so only the drag path needs the gate.
    },
    [],
  );
  const onClickConnectEnd = React.useCallback<OnConnectEnd>(
    (event) => {
      const from = clickConnectFromRef.current;
      clickConnectFromRef.current = null;
      const targetEl =
        event.target instanceof Element
          ? event.target.closest('.react-flow__node')
          : null;
      const rejection = resolveClickConnectRejection({
        from,
        toNodeId: targetEl?.getAttribute('data-id') ?? null,
        kindOf: (id) =>
          useCanvasGraphStore.getState().flowNodes.find((n) => n.id === id)
            ?.type,
      });
      if (!rejection) return;
      toast.error(
        t('canvas.connection.rejected', {
          source: kindLabel(rejection.sourceKind),
          target: kindLabel(rejection.targetKind),
        }),
      );
    },
    [t, kindLabel],
  );

  const onConnect = React.useCallback(
    (connection: Connection): void => {
      if (!connection.source || !connection.target) return;
      // Connection-rules backstop (spec §9.1). isValidConnection already
      // blocks an invalid drop in the UI, so this only fires if ReactFlow
      // hands over a connection that bypassed the drag validation — reject
      // silently rather than write a rule-breaking edge.
      const { flowNodes } = useCanvasGraphStore.getState();
      const sourceKind =
        flowNodes.find((n) => n.id === connection.source)?.type ?? '';
      const targetKind =
        flowNodes.find((n) => n.id === connection.target)?.type ?? '';
      if (!canConnect(sourceKind, targetKind)) return;
      // Edge validity (self-loop + both endpoints must exist) is enforced at
      // the addEdge write boundary — the only race-free place under collab.
      const added = addEdge(projectId, spaceId, {
        id: `${connection.source}->${connection.target}`,
        source: connection.source,
        target: connection.target,
      });
      // Surface a deleted-endpoint race like the reference-pick flow does, so a
      // drag that silently failed doesn't read as a made connection (a self-loop
      // stays silent — ReactFlow shouldn't offer one).
      if (!added && connection.source !== connection.target) {
        toast.error(t('canvas.generatePanel.referenceAddFailed'));
      }
    },
    [projectId, spaceId, t],
  );

  // Reference-pick mode (Generate panel "add reference from canvas"): while a
  // generative node is picking, each click on a compatible node wires an
  // incoming edge (clicked → target) — a connection IS a reference — and the
  // session CONTINUES (item 7 continuous select; the banner's Exit button is
  // the only way out). Clicks on the target itself, an already-wired node, or
  // a type-incompatible source are no-ops (all dimmed by the overlay).
  const onReferencePickNodeClick = React.useCallback(
    (_event: React.MouseEvent, node: Node): void => {
      // Read the pick target FRESH from the store, not the render closure: if
      // the panel switched to another node between render and this click, the
      // closure's referencePickForNodeId would wire the reference to the
      // PREVIOUS node.
      const target = useCanvasStore.getState().referencePickForNodeId;
      if (!target) return;
      // The target itself, any node ALREADY wired to it, and any
      // type-incompatible source (connection rules, spec §9.1) are dimmed +
      // non-pickable (item 7) — clicking them is a no-op so the user keeps
      // picking (continuous select until they press Exit).
      if (node.id === target) return;
      const alreadyReferenced = flowEdges.some(
        (e) => e.target === target && e.source === node.id,
      );
      if (alreadyReferenced) return;
      const targetKind =
        useCanvasGraphStore
          .getState()
          .flowNodes.find((n) => n.id === target)?.type ?? '';
      if (!canConnect(node.type ?? '', targetKind)) {
        // Dimmed by the overlay already; explain WHY on an insisting click
        // (same wording as the drag-connect rejection toast).
        toast.error(
          t('canvas.connection.rejected', {
            source: kindLabel(node.type ?? ''),
            target: kindLabel(targetKind),
          }),
        );
        return;
      }
      // Wire clicked-source → target as a reference. Self-loop + both-endpoints-
      // still-exist are enforced race-free at the addEdge write boundary (a
      // collaborator may have deleted either node between render and click).
      const added = addEdge(projectId, spaceId, {
        id: `${node.id}->${target}`,
        source: node.id,
        target,
      });
      // Couldn't wire = the node (or target) was deleted mid-pick — surface it.
      // Stay in pick mode either way; Exit is the only way out (item 7).
      if (!added) toast.error(t('canvas.generatePanel.referenceAddFailed'));
    },
    [projectId, spaceId, flowEdges, t, kindLabel],
  );

  // Node click: in reference-pick mode delegate to the pick handler. Off pick
  // mode there is nothing to do here — clicking a node moves selection
  // natively, and the selection-edge rule closes an open panel whose host
  // lost selection (no per-handler close enumeration).
  const onNodeClick = React.useCallback(
    (event: React.MouseEvent, node: Node): void => {
      if (useCanvasStore.getState().referencePickForNodeId) {
        onReferencePickNodeClick(event, node);
      }
    },
    [onReferencePickNodeClick],
  );

  // Clicking the empty canvas deselects everything (nodes AND edges — native
  // pane-click semantics); the binding machine then closes an open panel
  // (single close path — this handler never closes directly). EXCEPT during a
  // reference pick (spec §9.2): picking spans a large canvas, so a stray
  // click between nodes is a natural misclick and must not abort the session
  // (item 7: Exit is the only way out). reconcileSelection keeps the buffer
  // identity when nothing was selected, so idle misclicks re-render nothing.
  const onPaneClick = React.useCallback((): void => {
    if (useCanvasStore.getState().referencePickForNodeId != null) return;
    setFlowNodes((current) => reconcileSelection(current, () => false));
    setFlowEdges((current) => reconcileSelection(current, () => false));
    rfStoreApi.setState({ nodesSelectionActive: false });
  }, [setFlowNodes, setFlowEdges, rfStoreApi]);

  // Recenter the picking node so it stays findable while selecting references
  // across a large canvas (user 2026-07-10 item 7 locate). Pans only — keeps the
  // current zoom.
  const onLocateSource = React.useCallback((): void => {
    const id = useCanvasStore.getState().referencePickForNodeId;
    if (id == null) return;
    // A grouped member stores its position relative to its Group, so
    // `node.position` is NOT canvas-absolute — setCenter expects absolute
    // coordinates. Use the internal node's `positionAbsolute` (ReactFlow folds
    // in every parent offset), which is correct for both top-level and grouped
    // source nodes. `node.position` alone panned toward the origin for a
    // grouped source (adversarial finding 2026-07-10).
    const internal = getInternalNode(id);
    if (!internal) return;
    const abs = internal.internals.positionAbsolute;
    const w = internal.measured?.width ?? internal.width ?? 0;
    const h = internal.measured?.height ?? internal.height ?? 0;
    setCenter(abs.x + w / 2, abs.y + h / 2, {
      zoom: rfZoom,
      duration: 300,
    });
  }, [getInternalNode, setCenter, rfZoom]);

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

  // The connect-create menu's pick: create the node CENTERED on the release
  // point and wire source → new node — as ONE undo entry (one gesture, one
  // action; undoing must remove the node and its wire together).
  const onConnectCreatePick = React.useCallback(
    (type: CreatableNodeType): void => {
      // Same convert-at-pick-time convention as the right-click create menu.
      const point = screenToFlowPosition({
        x: connectCreate.x,
        y: connectCreate.y,
      });
      runCanvasUndoBatch(projectId, spaceId, () => {
        const id = createNodeAt(type, point);
        const added = addEdge(projectId, spaceId, {
          id: `${connectCreate.sourceId}->${id}`,
          source: connectCreate.sourceId,
          target: id,
        });
        // Source deleted while the menu was open (collaborator race): the node
        // still lands; surface the missing wire like every failed reference.
        if (!added) toast.error(t('canvas.generatePanel.referenceAddFailed'));
        setSelectAfterCreate([id]);
      });
    },
    [
      connectCreate.x,
      connectCreate.y,
      connectCreate.sourceId,
      screenToFlowPosition,
      createNodeAt,
      projectId,
      spaceId,
      t,
    ],
  );
  const onConnectCreateOpenChange = React.useCallback(
    (open: boolean): void => {
      setConnectCreate((prev) => ({ ...prev, open }));
    },
    [],
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
  // Track an in-flight front-end operation (upload / extraction) in the
  // per-space operation registry (#1617): register on start, unregister once the
  // work settles — which for these flows is AFTER the result is written back to
  // Yjs (the .then / .catch that call complete/failNodeHandling resolve before
  // this .finally). Closing the space tab is blocked while any operation is
  // registered, so the local write-back gets a chance to sync before detach.
  const trackOperation = React.useCallback(
    (operationId: string, work: Promise<unknown>): void => {
      const ops = useSpaceOperationsStore.getState();
      ops.register(spaceId, operationId);
      void work.finally(() => ops.unregister(spaceId, operationId));
    },
    [spaceId],
  );

  const processFiles = React.useCallback(
    (files: File[], origin: { x: number; y: number }): void => {
      if (readOnly || files.length === 0) return;
      // Register the batch SYNCHRONOUSLY (before the config-fetch await) so the
      // tab-close guard sees the space busy from the drop onward — not only once
      // the per-node uploads start after the await (#1617 pre-registration
      // window). This batch op covers the config-fetch + node-creation prefix;
      // each admitted upload tracks its own lifetime below.
      const batchWork = (async () => {
        // Upload-cap pre-check (#1609 P7): oversize media is refused ON
        // SELECTION with a toast — no node, zero network. A failed config
        // fetch skips the pre-check instead of blocking uploads (the
        // presign 413 gate stays authoritative). Session-cached after the
        // first call, so this await is normally instant.
        let maxBytes = Infinity;
        try {
          maxBytes = (await assetsApi.fetchUploadConfig()).maxUploadBytes;
        } catch {
          // Server-side 413 remains the authoritative gate.
        }
        const admitted: File[] = [];
        for (const file of files) {
          if (fileToNodeSpec(file).needsUpload && file.size > maxBytes) {
            toast(t('canvas.upload.tooLarge', { filename: file.name }));
          } else {
            admitted.push(file);
          }
        }
        const created: string[] = [];
        for (let i = 0; i < admitted.length; i += 1) {
          const file = admitted[i];
          const spec = fileToNodeSpec(file);
          const position = {
            x: origin.x + i * STAGGER_STEP_PX,
            y: origin.y + i * STAGGER_STEP_PX,
          };
          // #1580 #7: the created-handling node carries its first lease; the
          // write-backs verify it, so a superseded upload (someone re-opened
          // the node after a sweeper reclaim) cannot clobber the new owner.
          const { nodeId, lease } = createUploadNodeAt(spec.nodeType, position);
          created.push(nodeId);
          if (spec.needsUpload) {
            trackOperation(
              nodeId,
              runMediaUpload(file, projectId, {
                getUploadConfig: assetsApi.fetchUploadConfig,
                hashFile,
                presign: assetsApi.presign,
                putFile: putFileWithRetry,
                onSuccess: (fileUrl) => {
                  clearRetryFile(projectId, spaceId, nodeId);
                  if (!completeNodeHandling(projectId, spaceId, nodeId, fileUrl, lease)) {
                    toast(t('canvas.upload.ownershipLost'));
                  }
                },
                // Fixed-English wire string — like AIGC failure messages and the
                // group default name. errorMessage is written to Yjs and rendered
                // raw to every collaborator, so it must not freeze the uploader's
                // locale into the shared doc. The filename is the locale-free part
                // telling the user which file failed. The File is stashed BEFORE
                // the error lands so the error re-render already sees the Retry
                // stash (#1609 P4).
                onFailure: () => {
                  stashRetryFile(projectId, spaceId, nodeId, file);
                  failNodeHandling(
                    projectId,
                    spaceId,
                    nodeId,
                  `Upload failed: ${file.name}`,
                  lease,
                  );
                },
                onUploaded: (info) => reportUploadedAsset(nodeId, info, file),
              }),
            );
          } else {
            trackOperation(
              nodeId,
              extractText(file)
                .then((text) => {
                  if (
                    !completeNodeHandling(projectId, spaceId, nodeId, text, lease)
                  ) {
                    toast(t('canvas.upload.ownershipLost'));
                  }
                })
                .catch(() =>
                  failNodeHandling(
                    projectId,
                    spaceId,
                    nodeId,
                    `Extraction failed: ${file.name}`,
                    lease,
                  ),
                ),
            );
          }
        }
        if (created.length > 0) setSelectAfterCreate(created);
      })();
      trackOperation(UPLOAD_BATCH_OP, batchWork);
    },
    [
      readOnly,
      projectId,
      spaceId,
      createUploadNodeAt,
      t,
      reportUploadedAsset,
      trackOperation,
    ],
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
      // A reference pick owns pointer interactions until Exit (adversarial
      // round-1): the create/paste menu would mutate the pick surface and its
      // creations auto-select mid-session. Fresh store read — closures stale.
      if (useCanvasStore.getState().referencePickForNodeId) return;
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
      // Pick session gate (adversarial round-1): the node menu's Upload
      // silently no-ops behind the item-12 gate and its Delete would mutate
      // the pick surface — the pick owns node interactions until Exit.
      if (useCanvasStore.getState().referencePickForNodeId) return;
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
      // Same pick-session gate as the node / pane menus.
      if (useCanvasStore.getState().referencePickForNodeId) return;
      setSelectionMenu({ open: true, x: event.clientX, y: event.clientY });
    },
    [readOnly],
  );

  const onEdgeContextMenu = React.useCallback(
    (event: React.MouseEvent, edge: Edge): void => {
      event.preventDefault();
      if (readOnly) return;
      // Same pick-session gate — deleting an edge mid-pick mutates the rail.
      if (useCanvasStore.getState().referencePickForNodeId) return;
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
    // reconcileSelection keeps untouched nodes' references so React.memo
    // bails on the rest of the canvas (same discipline as the other
    // programmatic selection writes).
    setFlowNodes((current) =>
      reconcileSelection(current, (node) => targets.has(node.id)),
    );
    setSelectAfterCreate(null);
  }, [selectAfterCreate, nodes, setFlowNodes]);

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
  // Stable references (#1647 step 4): the Yjs mirror hands a fresh `flowNodes`
  // every doc change, so these re-derive a new array each render; `useStableList`
  // collapses identical results to the previous reference so `groupOffer` (and
  // the group toolbar it feeds) only recompute when the selection / group
  // structure actually changes — not on an unrelated position drag or data write.
  const selectedIds = useStableList(
    React.useMemo(
      () => flowNodes.filter((node) => node.selected).map((node) => node.id),
      [flowNodes],
    ),
  );
  const groupInfos = useStableList(
    React.useMemo<NodeGroupInfo[]>(
      () =>
        flowNodes.map((node) => ({
          id: node.id,
          isGroup: node.type === 'group',
          parentId: node.parentId,
          locked: (node.data as { locked?: boolean }).locked,
        })),
      [flowNodes],
    ),
    (info) =>
      `${info.id}:${info.isGroup ? 1 : 0}:${info.parentId ?? ''}:${info.locked ? 1 : 0}`,
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
    setFlowNodes(() => plan.nextNodes);
    setSelectAfterCreate([groupId]);
  }, [
    readOnly,
    groupOffer,
    flowNodes,
    selectedIds,
    userId,
    projectId,
    spaceId,
    setFlowNodes,
  ]);

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
      reportDeletedAssets(survivors.nodes);
    },
    [readOnly, projectId, spaceId, t, reportDeletedAssets],
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
          // Centre the pasted content's bounding box ON the cursor (not its
          // top-left there) — consistent with how creation centres on its drop
          // point (Bug C).
          const box = clipboardBoundingBox(clipboardNodes);
          setSelectAfterCreate(
            pasteNodesAt(clipboardNodes, {
              dx: point.x - (box.x + box.width / 2),
              dy: point.y - (box.y + box.height / 2),
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
  const uploadTargetRef = React.useRef<{
    nodeId: string;
    modality: UploadNodeSpec['nodeType'];
  } | null>(null);
  const activateNodeUpload = React.useCallback(
    (nodeId: string, modality: Modality): void => {
      if (readOnly) return;
      // A reference pick owns node interactions (batch-2 item 12): a
      // double-click on an empty node — or the node-menu Upload, both funnel
      // here — must not pop the file picker over the running pick session.
      // Read fresh from the store; the render closure can be stale.
      if (useCanvasStore.getState().referencePickForNodeId) return;
      const accept = UPLOAD_ACCEPT[modality];
      const input = uploadInputRef.current;
      if (!accept || !input) return; // 3d / web have no picker yet
      // Only modalities present in UPLOAD_ACCEPT reach here, so the narrowing
      // cast is safe; the modality rides along for the fill's type gate.
      uploadTargetRef.current = {
        nodeId,
        modality: modality as UploadNodeSpec['nodeType'],
      };
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
  // Fill an existing node from a File — shared by the picker path
  // (double-click / node-menu Upload) and the error-state Retry (#1609 P4).
  const fillUpload = React.useCallback(
    (
      nodeId: string,
      file: File,
      modality: UploadNodeSpec['nodeType'],
    ): void => {
      // Register SYNCHRONOUSLY (before the config-fetch await) by making the
      // whole flow the tracked work — otherwise the tab-close guard reads "not
      // busy" during the config round-trip and a close in that window loses the
      // write-back (#1617 pre-registration window).
      const work = (async () => {
        // Upload-cap pre-check (#1609 P7) — same semantics as processFiles.
        let maxBytes = Infinity;
        try {
          maxBytes = (await assetsApi.fetchUploadConfig()).maxUploadBytes;
        } catch {
          // Server-side 413 remains the authoritative gate.
        }
        if (fileToNodeSpec(file).needsUpload && file.size > maxBytes) {
          toast(t('canvas.upload.tooLarge', { filename: file.name }));
          return;
        }
        await fillNodeFromFile(nodeId, file, modality, projectId, {
          getUploadConfig: assetsApi.fetchUploadConfig,
          hashFile,
          presign: assetsApi.presign,
          putFile: putFileWithRetry,
          extractText,
          // Type gate: the picker's accept is advisory (macOS lets audio/*
          // select .mp4) — a file that doesn't classify to the node's modality
          // is refused with a local toast (user bug 2026-07-03).
          onTypeMismatch: () => toast(t('canvas.upload.typeMismatch')),
          // #1580 #7 busy gate: a node already handling refuses a second fill.
          isHandling: (id) => isNodeHandling(projectId, spaceId, id),
          onBusy: () => toast(t('canvas.upload.nodeBusy')),
          setHandling: (id) => setNodeHandling(projectId, spaceId, id, userId),
          setContent: (id, content, lease) => {
            clearRetryFile(projectId, spaceId, id);
            const landed = completeNodeHandling(projectId, spaceId, id, content, lease);
            if (!landed) toast(t('canvas.upload.ownershipLost'));
            return landed;
          },
          setError: (id, message, lease) => {
            // Stash media Files for the Retry button (upload failures
            // only — a text-extraction failure has nothing to re-upload).
            if (fileToNodeSpec(file).needsUpload) {
              stashRetryFile(projectId, spaceId, id, file);
            }
            return failNodeHandling(projectId, spaceId, id, message, lease);
          },
          onUploaded: (id, info) => reportUploadedAsset(id, info, file),
        });
      })();
      trackOperation(nodeId, work);
    },
    [projectId, spaceId, userId, t, reportUploadedAsset, trackOperation],
  );
  const onUploadInputChange = React.useCallback(
    (event: React.ChangeEvent<HTMLInputElement>): void => {
      const file = event.target.files?.[0];
      const target = uploadTargetRef.current;
      uploadTargetRef.current = null;
      if (!file || !target) return;
      fillUpload(target.nodeId, file, target.modality);
    },
    [fillUpload],
  );
  // Error-state Retry (#1609 P4): re-run the upload from the session
  // stash. The stash survives repeated failures (cleared only on success)
  // and a refresh drops it — the button then no longer renders.
  const retryNodeUpload = React.useCallback(
    (nodeId: string): void => {
      if (readOnly) return;
      const file = getRetryFile(projectId, spaceId, nodeId);
      if (!file) return;
      fillUpload(nodeId, file, fileToNodeSpec(file).nodeType);
    },
    [readOnly, projectId, spaceId, fillUpload],
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
      retryNodeUpload,
      hasUploadRetryFile: (nodeId: string): boolean =>
        hasRetryFile(projectId, spaceId, nodeId),
    }),
    [projectId, spaceId, readOnly, activateNodeUpload, retryNodeUpload],
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
            // A read-only viewer gets NO resize bounds, so GroupResizer renders
            // no handles — ReactFlow's NodeResizeControl works independently of
            // `nodesDraggable`, so without this a viewer could grab + drag-resize
            // a group locally (the write is blocked, but the affordance must not
            // show — same rule as nodesDraggable / nodesConnectable).
            groupResizeBounds: readOnly ? [] : bounds,
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

  // Reference-pick mode overlay (user 2026-07-10 item 7): the node whose panel
  // is picking + any node ALREADY wired to it + any type-incompatible source
  // (connection rules, spec §9.1 — e.g. audio/video can't feed an image input)
  // are dimmed + non-pickable; every other node gets a hover glow inviting
  // selection. Off pick mode this returns the same reference (no-op) so
  // nothing re-renders.
  const pickedNodes = React.useMemo<Node[]>(() => {
    if (referencePickForNodeId == null) return renderNodes;
    const alreadyReferenced = new Set(
      flowEdges
        .filter((e) => e.target === referencePickForNodeId)
        .map((e) => e.source),
    );
    const targetKind =
      renderNodes.find((n) => n.id === referencePickForNodeId)?.type ?? '';
    return renderNodes.map((node) => {
      const dimmed =
        node.id === referencePickForNodeId ||
        alreadyReferenced.has(node.id) ||
        !canConnect(node.type ?? '', targetKind);
      const pickClass = dimmed
        ? 'canvas-pick-dimmed'
        : 'canvas-pick-selectable';
      return {
        ...node,
        className: [node.className, pickClass].filter(Boolean).join(' '),
      };
    });
  }, [renderNodes, referencePickForNodeId, flowEdges]);

  // Stable menu-callback references (#1647 step 4E): the context menus are
  // React.memo'd, so their `onOpenChange` / action props must be stable
  // references to let the memo bail — a fresh inline arrow each render would
  // defeat it. The node-menu actions close over the current menu target, so they
  // re-key on `nodeMenu` (open / target change) — exactly when the menu content
  // should update. The two conditional actions (`onRename` / `onUngroup`, which
  // resolve to `undefined` when frozen) use `useMemo` since they memoize a value.
  const onContextMenuOpenChange = React.useCallback(
    (open: boolean) => setContextMenu((prev) => ({ ...prev, open })),
    [],
  );
  const onNodeMenuOpenChange = React.useCallback(
    (open: boolean) => setNodeMenu((prev) => ({ ...prev, open })),
    [],
  );
  const onSelectionMenuOpenChange = React.useCallback(
    (open: boolean) => setSelectionMenu((prev) => ({ ...prev, open })),
    [],
  );
  const onEdgeMenuOpenChange = React.useCallback(
    (open: boolean) => setEdgeMenu((prev) => ({ ...prev, open })),
    [],
  );
  const onNodeMenuRename = React.useMemo(
    () => (nodeMenu.locked ? undefined : () => requestRename(nodeMenu.nodeId)),
    [nodeMenu.locked, nodeMenu.nodeId, requestRename],
  );
  const onNodeMenuCopy = React.useCallback(
    () => writeNodesToClipboard(nodeMenuClipboard()),
    [writeNodesToClipboard, nodeMenuClipboard],
  );
  const onNodeMenuDuplicate = React.useCallback(
    () => duplicateTargets([nodeMenu.nodeId]),
    [duplicateTargets, nodeMenu.nodeId],
  );
  const onNodeMenuUngroup = React.useMemo(
    () =>
      nodeMenu.isGroup && !nodeMenu.locked
        ? () => removeNode(projectId, spaceId, nodeMenu.nodeId)
        : undefined,
    [nodeMenu.isGroup, nodeMenu.locked, nodeMenu.nodeId, projectId, spaceId],
  );

  return (
    <CanvasActionsContext.Provider value={actions}>
      <div
        ref={containerRef}
        data-testid='canvas-space'
        data-project-id={projectId}
        data-space-id={spaceId}
        data-readonly={readOnly ? 'true' : undefined}
        // Programmatically focusable (not tab-reachable) so the pick-end focus
        // catch-all can return focus here instead of dropping it on <body>.
        tabIndex={-1}
        // canvas-picking scopes the pick-mode stylesheet: it hides xyflow's
        // NodesSelection rect (see index.css) so a marquee mid-pick cannot
        // create a click-swallowing dead zone. The rect is neutralized at the
        // RENDER layer on purpose — round-3 adversarial proved that toggling
        // selectionKeyCode to disable the Shift marquee latches xyflow's
        // internal key state when the flip happens mid-keyhold (useKeyPress
        // detaches its listeners without resetting keyPressed), hijacking
        // every drag until the next Shift press. Keep xyflow's key props
        // CONSTANT; make the marquee harmless instead.
        className={`relative h-full w-full bg-canvas ${referencePickForNodeId != null ? 'canvas-picking' : ''}`}
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
          nodes={pickedNodes}
          edges={flowEdges}
          nodeTypes={FLOW_NODE_TYPES}
          edgeTypes={EDGE_TYPES}
          // Only mount the nodes / edges intersecting the viewport (#1647 step 5)
          // so a heavy space stays smooth on pan / zoom. Enabled built-in with NO
          // custom guard rail: the historic offscreen-edge bug (xyflow #4516) is
          // fixed in our v12.10.2, so groups + edges are verified in real-browser
          // smoke rather than pre-guarded (a guard rail is added only if smoke
          // shows breakage). NOTE: this does not shrink the INITIAL mount (all
          // nodes render once); it helps pan / zoom after load (xyflow #3883).
          onlyRenderVisibleElements
          // Snap-to-grid (#1663): when the toolbar toggle is on, ReactFlow rounds
          // dragged node positions to SNAP_GRID (aligned to the visible background
          // dots). Read from the canvas store — single source mirroring the
          // minimap (#1548); the toggle was previously a dead local useState that
          // never reached the canvas.
          snapToGrid={snapToGrid}
          snapGrid={SNAP_GRID}
          // Viewer backstop (#1377): a read-only viewer must not move nodes or
          // draw edges. The real boundary is the collab server (a read-only
          // connection rejects the viewer's Yjs sync-update), but gating these
          // here prevents the UI from optimistically moving a node only to have
          // the server reject it and snap it back. elementsSelectable stays on
          // so viewers can still click a node to inspect it.
          nodesDraggable={!readOnly}
          // A reference pick owns ALL connect gestures (adversarial round-1
          // HIGH): live handles let two candidate hot-zone clicks arm xyflow
          // click-connect and silently write a candidate-to-candidate edge
          // mid-pick. Plain boolean store prop — safe to flip, unlike the
          // key-code props (see web-frontend-traps).
          nodesConnectable={!readOnly && referencePickForNodeId == null}
          // No node selection during a reference pick (user 2026-07-12 P2c):
          // clicking a candidate wires a reference (onNodeClick → addEdge), it
          // must not ALSO xyflow-select the node — a click on a type-incompatible
          // (dimmed) node still turned its border the selected violet, reading as
          // if the incompatible pick had taken. onNodeClick still fires with
          // selection off, so the pick + rejection-toast paths are untouched.
          // Off pick this stays the default (true) so viewers can click-inspect.
          elementsSelectable={referencePickForNodeId == null}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeDragStop={onNodeDragStop}
          onDelete={onDelete}
          onBeforeDelete={onBeforeDelete}
          onConnect={onConnect}
          onConnectStart={onConnectDragStart}
          onConnectEnd={onConnectEnd}
          onClickConnectStart={onClickConnectStart}
          onClickConnectEnd={onClickConnectEnd}
          isValidConnection={isValidConnection}
          onPaneContextMenu={onPaneContextMenu}
          onNodeContextMenu={onNodeContextMenu}
          onNodeClick={onNodeClick}
          onPaneClick={onPaneClick}
          onSelectionContextMenu={onSelectionContextMenu}
          onEdgeContextMenu={onEdgeContextMenu}
          deleteKeyCode={DELETE_KEYS}
          proOptions={{ hideAttribution: true }}
          fitView
          // Clamp the open / fit-to-window auto-zoom to 10%–100% (#1547) so a
          // sparse space doesn't zoom in to the 800% global ceiling; the manual
          // zoom presets still use the full global range below.
          fitViewOptions={FIT_VIEW_OPTIONS}
          // Canvas zoom pinned to 10%–800% (the viewport toolbar's ZOOM_MIN /
          // ZOOM_MAX use the same range); overrides ReactFlow's default 0.1–4
          // ceiling so wheel / pinch can't exceed 800%.
          minZoom={0.1}
          maxZoom={8}
          // Figma-like interaction: left-button drag marquee-selects (not
          // pans); two-finger trackpad scroll pans the canvas freely; pinch
          // zooms. With panOnScroll on, a plain wheel / two-finger scroll pans
          // and a ctrl-wheel / pinch zooms (zoomOnPinch, default) — ReactFlow
          // routes the two automatically, so zoomOnScroll stays at its default.
          // Drag-marquee is disabled during a reference pick (round-1
          // adversarial dead zone). The Shift marquee path stays ENABLED on
          // purpose: gating selectionKeyCode dynamically latches xyflow's
          // useKeyPress state when the flip happens mid-Shift-hold (round-3
          // adversarial — listeners detach without resetting keyPressed,
          // hijacking every drag afterwards). A Shift marquee mid-pick is
          // harmless instead: the machine holds, and the canvas-picking CSS
          // hides the NodesSelection rect so no dead zone forms.
          selectionOnDrag={referencePickForNodeId == null}
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
          {/* Bird's-eye minimap (#1548) — toolbar-toggled via the canvas
              store; safe for read-only viewers (viewport navigation only). */}
          {minimapVisible ? <CanvasMiniMap /> : null}
          {/* Floating selection toolbar: group a fresh selection, or ungroup
              a selected group (mirrors the Cmd/Ctrl+G shortcuts). */}
          <NodeToolbar
            nodeId={selectedIds}
            // Hidden during a reference pick (adversarial round-1): floating
            // chrome over the pick surface swallows candidate clicks and its
            // group/ungroup actions mutate mid-session — same concealment
            // rule as the left menu / viewport toolbar (item 13).
            isVisible={
              groupOffer.kind !== 'none' &&
              !readOnly &&
              referencePickForNodeId == null
            }
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
          {/* Generate panel: floats below its node via NodeToolbar (no viewport
              change on open); shows nothing until a node's panel is opened. */}
          <GeneratePanelContainer
            nodes={nodes}
            edges={edges}
            projectId={projectId}
            spaceId={spaceId}
          />
        </ReactFlow>
        {referencePickForNodeId ? (
          <div
            data-testid='reference-pick-banner'
            // Palette violet (the status-selected identity — same hue as the
            // pick glow) instead of neutral card chrome: the banner is the
            // mode indicator for an exclusive session and must read as one
            // (user 2026-07-11 item 11). The stock `-bg` token is a 14% tint
            // over TRANSPARENT (built for group surfaces); a floating banner
            // needs a SOLID surface, so the tint is mixed into the popover
            // base instead.
            style={{
              backgroundColor:
                'color-mix(in srgb, var(--color-palette-violet) 14%, var(--color-popover))',
              borderColor: 'var(--color-palette-violet-border)',
            }}
            className='absolute left-1/2 top-4 z-10 flex -translate-x-1/2 items-center gap-3 rounded-md border px-4 py-2 text-sm text-foreground shadow-md'
          >
            <span>{t('canvas.generatePanel.selectFromCanvas')}</span>
            <button
              type='button'
              data-testid='reference-pick-locate'
              aria-label={t('canvas.generatePanel.locateSource')}
              onClick={onLocateSource}
              className='flex h-6 w-6 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground'
            >
              <LocateFixed className='h-4 w-4' aria-hidden='true' />
            </button>
            <button
              type='button'
              data-testid='reference-pick-exit'
              onClick={onExitReferencePick}
              className='rounded-sm px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground'
            >
              {t('canvas.generatePanel.exitSelect')}
            </button>
          </div>
        ) : null}
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
          onOpenChange={onContextMenuOpenChange}
          onPick={onContextMenuPick}
          onPaste={pasteAtCursor}
        />
        <ConnectCreateMenu
          open={connectCreate.open}
          x={connectCreate.x}
          y={connectCreate.y}
          sourceKind={connectCreate.sourceKind}
          onOpenChange={onConnectCreateOpenChange}
          onPick={onConnectCreatePick}
        />
        <NodeContextMenu
          open={nodeMenu.open}
          x={nodeMenu.x}
          y={nodeMenu.y}
          locked={nodeMenu.locked}
          target={nodeMenu.isGroup ? 'group' : 'node'}
          onOpenChange={onNodeMenuOpenChange}
          onToggleLock={onToggleNodeLock}
          // Upload fills / replaces the node's content (node-only; its presence
          // also gates the Generate / Upload / Tools block). The menu only opens
          // for editors (onNodeContextMenu returns early when read-only), and
          // activateNodeUpload no-ops for read-only / pickerless modalities.
          onUpload={nodeMenu.isGroup ? undefined : uploadNodeFromMenu}
          // Generate is offered only on an editable image node (the AIGC
          // "generate into self" flow) — never on groups, locked nodes, or
          // for read-only viewers; absent = a disabled placeholder. Lock is
          // read from the LIVE node (not the menu's captured value) so a node
          // locked after the menu opened no longer offers Generate.
          onGenerate={(() => {
            const genNode = nodes.find((n) => n.id === nodeMenu.nodeId);
            const genLocked = Boolean(
              (genNode?.data as { locked?: unknown } | undefined)?.locked,
            );
            return !nodeMenu.isGroup &&
              !genLocked &&
              !readOnly &&
              genNode?.type === 'image'
              ? () => {
                // Open + assert in one gesture: the machine's fresh-binding
                // assert covers id CHANGES, but a same-host reopen (store id
                // unchanged, e.g. re-choosing Generate with the panel already
                // open after Cmd-adding a co-selection) is invisible to it —
                // the action layer asserts unconditionally; both writes are
                // idempotent.
                openGeneratePanel(nodeMenu.nodeId);
                selectOnlyNode(nodeMenu.nodeId);
              }
              : undefined;
          })()}
          // Rename is frozen on a locked node / group (the name is on-canvas
          // content); hide it rather than offer a silent no-op.
          onRename={onNodeMenuRename}
          onDelete={deleteNodeFromMenu}
          // Copy / duplicate work for a node OR a group (R2-D): a group copies /
          // duplicates with its members (capture / clone are Group-aware).
          onCopy={onNodeMenuCopy}
          onDuplicate={onNodeMenuDuplicate}
          // Ungroup releases a group's members; a locked group is frozen.
          onUngroup={onNodeMenuUngroup}
        />
        <SelectionContextMenu
          open={selectionMenu.open}
          x={selectionMenu.x}
          y={selectionMenu.y}
          onOpenChange={onSelectionMenuOpenChange}
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
          onOpenChange={onEdgeMenuOpenChange}
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
