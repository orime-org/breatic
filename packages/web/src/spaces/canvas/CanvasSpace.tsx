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

import { assetsApi } from '@web/data/api';
import {
  addEdge,
  addNode,
  addToGroup,
  moveGroup,
  removeEdge,
  removeElements,
  removeFromGroup,
  removeNode,
  runCanvasUndoBatch,
  setGroupBackground,
  setNodeContent,
  setNodeError,
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
import { matchDuplicateShortcut } from '@web/spaces/canvas/canvas-duplicate-shortcut';
import { matchGroupShortcut } from '@web/spaces/canvas/canvas-group-shortcut';
import { matchHistoryShortcut } from '@web/spaces/canvas/canvas-history-shortcut';
import {
  fileToNodeSpec,
  runMediaUpload,
} from '@web/spaces/canvas/canvas-upload';
import { extractText } from '@web/spaces/canvas/text-extract';
import {
  applyGroupGeometry,
  computeGroupRect,
} from '@web/spaces/canvas/group-geometry';
import { planDragStopAll } from '@web/spaces/canvas/drag-persist';
import {
  lockBlockedDeletion,
  lockedNodeIds,
} from '@web/spaces/canvas/group-membership';
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

  const {
    createNodeAt,
    createUploadNodeAt,
    pasteTextAt,
    pasteNodesAt,
    duplicateNodes,
  } = useNodeCreation(projectId, spaceId);

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
    (_event: React.MouseEvent, node: Node, nodes: Node[]): void => {
      // A marquee can co-drag a group AND loose nodes. The grabbed group (if
      // any) moves via groupMove; EVERY loose node still persists its position +
      // group-membership change. The old code returned right after moveGroup,
      // dropping the loose nodes so they snapped back (#6). See planDragStopAll.
      const plan = planDragStopAll(node, nodes, flowNodes, groupDragRef.current);
      if (node.type === 'group' && groupDragRef.current?.id === node.id) {
        groupDragRef.current = null;
      }
      // Commit the whole drag-stop as ONE atomic undo entry. A drag-out fires a
      // position change AND a group-membership change; a marquee fires N position
      // writes. Without batching, captureTimeout:0 makes each its own undo step,
      // so undoing a drag-out restored the dissolved group BEFORE the member's
      // position reverted — a phantom oversized empty group (#3). An empty plan
      // opens a no-op transaction (Yjs pushes no undo entry for it).
      runCanvasUndoBatch(projectId, spaceId, () => {
        if (plan.groupMove) {
          moveGroup(
            projectId,
            spaceId,
            plan.groupMove.groupId,
            plan.groupMove.delta,
          );
        }
        for (const { id, position } of plan.positions) {
          setNodePosition(projectId, spaceId, id, position);
        }
        for (const op of plan.groupOps) {
          if (op.action === 'add') {
            addToGroup(projectId, spaceId, op.groupId, op.nodeId);
          } else {
            removeFromGroup(projectId, spaceId, op.groupId, op.nodeId);
          }
        }
      });
    },
    [projectId, spaceId, flowNodes],
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
  }, [readOnly, pasteNodesAt, pasteTextAt, screenToFlowPosition, processFiles]);

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
        locked: (node.data as { locked?: boolean }).locked,
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

  // The clipboard-portable subset of the current selection (groups / annotations
  // aren't copyable, so they drop out). Shared by copy + duplicate.
  const collectSelectedClipboard = React.useCallback(
    (): ClipboardNode[] =>
      flowNodesRef.current
        .filter((node) => node.selected)
        .map(flowNodeToClipboard)
        .filter((node): node is ClipboardNode => node !== null),
    [],
  );

  // The clipboard-portable form of the right-clicked node (empty for a group /
  // non-copyable node). Shared by the node menu's copy + duplicate.
  const nodeMenuClipboard = React.useCallback((): ClipboardNode[] => {
    const node = flowNodesRef.current.find((item) => item.id === nodeMenu.nodeId);
    const clip = node ? flowNodeToClipboard(node) : null;
    return clip ? [clip] : [];
  }, [nodeMenu.nodeId]);

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

  // Duplicate clones in place (fixed offset) WITHOUT touching the clipboard; the
  // new nodes are selected once mirrored back. Shared by node + selection menus.
  const duplicateClipboard = React.useCallback(
    (clipboardNodes: ClipboardNode[]): void => {
      if (readOnly || clipboardNodes.length === 0) return;
      setSelectAfterCreate(duplicateNodes(clipboardNodes));
    },
    [readOnly, duplicateNodes],
  );

  const copySelection = React.useCallback((): void => {
    writeNodesToClipboard(collectSelectedClipboard());
  }, [writeNodesToClipboard, collectSelectedClipboard]);

  const duplicateSelection = React.useCallback((): void => {
    duplicateClipboard(collectSelectedClipboard());
  }, [duplicateClipboard, collectSelectedClipboard]);

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

  const deleteSelection = React.useCallback((): void => {
    const selected = flowNodesRef.current.filter((node) => node.selected);
    if (selected.length === 0) return;
    const selectedIds = new Set(selected.map((node) => node.id));
    const connected = flowEdges.filter(
      (edge) => selectedIds.has(edge.source) || selectedIds.has(edge.target),
    );
    commitGuardedDelete(selected, connected);
  }, [flowEdges, commitGuardedDelete]);

  // Node menu delete: the node plus every edge touching it (the same cascade
  // ReactFlow's keyboard delete performs), routed through the lock guard.
  const deleteNodeFromMenu = React.useCallback((): void => {
    const node = flowNodesRef.current.find((item) => item.id === nodeMenu.nodeId);
    if (!node) return;
    const connected = flowEdges.filter(
      (edge) =>
        edge.source === nodeMenu.nodeId || edge.target === nodeMenu.nodeId,
    );
    commitGuardedDelete([node], connected);
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
    // Locked nodes are frozen in place: any locked node (incl. a locked group as
    // a whole) and the members of a locked group render non-draggable, so they
    // can't be moved. An unlocked group still drags as a unit (carrying members).
    const frozen = lockedNodeIds(sized);
    return [
      ...groups.map((node) => ({
        ...node,
        draggable: !readOnly && !frozen.has(node.id),
        zIndex: 0,
      })),
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
          // Rename is frozen on a locked node / group (the name is on-canvas
          // content); hide it rather than offer a silent no-op.
          onRename={
            nodeMenu.locked ? undefined : () => requestRename(nodeMenu.nodeId)
          }
          onDelete={deleteNodeFromMenu}
          // Copy / duplicate are node-only (groups / annotations aren't
          // clipboard-portable).
          onCopy={
            nodeMenu.isGroup
              ? undefined
              : () => writeNodesToClipboard(nodeMenuClipboard())
          }
          onDuplicate={
            nodeMenu.isGroup
              ? undefined
              : () => duplicateClipboard(nodeMenuClipboard())
          }
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
