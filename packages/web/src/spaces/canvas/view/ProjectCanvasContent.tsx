/**
 * ProjectCanvasContent — the actual ReactFlow surface for one canvas
 * Space. Lives inside `ReactFlowProvider` and reads canvas state from
 * `useCanvasData` / `useCanvasActions` / `useCanvasUI`.
 *
 * Responsibilities:
 *   - Render ReactFlow with all node types, edges, viewport handlers
 *   - Mode glue:
 *       agentCanvasPickEditMode (mention/pick from canvas)
 *       canvasCommentMode (drop a comment marker on click)
 *       connectEnd menu (drag connection out → command menu)
 *   - Group node enter/leave on drag stop
 *   - Edge collaborative selection highlights (yjs.edgeSelections)
 *   - Right overlay panel + comment composer overlays
 *
 * Pulled out of `spaces/canvas/index.tsx` (PR-Y1) so the shell can stay
 * thin (<100 lines). Pure helpers + ReactFlow static config live in
 * `./canvas-helpers.ts`; the viewport-API registrar lives in
 * `./ProjectCanvasViewportRegistrar.tsx`.
 *
 * Internal hook decomposition (useAgentCanvasPickMode /
 * useConnectEndMenu / useNodeDragGroup / useCanvasCommentMode) is
 * deferred — those are independent refactors with their own PRs.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { nanoid } from 'nanoid';
import {
  addEdge,
  Background,
  BackgroundVariant,
  ReactFlow,
  reconnectEdge,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
  type NodeTypes,
  type OnConnectEnd,
} from '@xyflow/react';
import TextNode from '@/spaces/canvas/nodes/text-node/TextNode';
import ImageNode from '@/spaces/canvas/nodes/image-node/ImageNode';
import VideoNode from '@/spaces/canvas/nodes/video-node/VideoNode';
import AudioNode from '@/spaces/canvas/nodes/audio-node/AudioNode';
import GenerativeNode from '@/spaces/canvas/nodes/generative-node/GenerativeNode';
import CustomEdge from '@/spaces/canvas/common/Edge';
import GroupNode from '@/spaces/canvas/common/GroupNode';
import ClipboardPasteHandler from '@/spaces/canvas/common/ClipboardPasteHandler';
import HotkeysHandler from '@/spaces/canvas/common/HotkeysHandler';
import GroupToolbarPanel from '@/spaces/canvas/common/GroupToolbarPanel';
import CustomMiniMap from '@/spaces/canvas/common/CustomMiniMap';
import { ViewportToolbar } from '@/features/viewport-toolbar';
import NodeContextMenu from '@/spaces/canvas/common/NodeContextMenu';
import ConnectEndCommandMenu from '@/spaces/canvas/common/ConnectEndCommandMenu';
import ConnectEndAnchorNode, {
  connectEndAnchorSourceHandleId,
  connectEndAnchorTargetHandleId,
} from '@/spaces/canvas/common/ConnectEndAnchorNode';
import CanvasCommentComposer from '@/spaces/canvas/common/CanvasCommentComposer';
import CommentMarkerNode from '@/spaces/canvas/common/CommentMarkerNode';
import { LeftFloatingMenu } from '@/features/canvas-left-menu';
import {
  BottomToolbar,
  findToolSchema,
  runCategoryAOp,
  useMiniTool,
} from '@/features/mini-tools';
import { uploadOne } from '@/features/upload';
import { useChipsPick } from '@/features/chat/contexts/ChipsPickContext';
// B.2 — pickState integration (agentCanvasPickEditingNodeId / mention
// mode / canvas-pick recognized boxes) is gone. v13 chip pick goes
// through ChipsPickContext above; recognized boxes were a v12 demo
// affordance the spec dropped.
import {
  AnnotationNode,
  AnnotationComposer,
  ANNOTATION_NODE_TYPE,
} from '@/features/annotation';
import { executeImage } from '@/data/api/mini-tools';
import { useActiveCanvasSpace } from '@/domain/space/ActiveCanvasSpaceContext';
import CanvasRightOverlayPanel from '@/spaces/canvas/view/CanvasRightOverlayPanel';
import ProjectCanvasViewportRegistrar from '@/spaces/canvas/view/ProjectCanvasViewportRegistrar';
import { useCanvasData } from '@/spaces/canvas/contexts/CanvasDataContext';
import { useCanvasActions } from '@/spaces/canvas/hooks/useCanvasActions';
import { useCanvasUI } from '@/spaces/canvas/contexts/CanvasUIContext';
import { type UseProjectSpacesResult } from '@/domain/space/useProjectSpaces';
import { type CanvasWorkflowNodeData } from '@/spaces/canvas/types';
import {
  getGroupBounds,
  getLockedGroupIds,
  connectEndHandles,
  generateConnectEndNodeId,
  defaultNodeWidthByType,
  reactFlowDefaultViewport,
  reactFlowPanOnDrag,
  reactFlowProOptions,
  reactFlowStyle,
  type ContextMenuState,
  type ConnectEndMenuState,
} from '@/spaces/canvas/view/canvas-helpers';

const nodeTypes: NodeTypes = {
  '1001': TextNode,
  '1002': ImageNode,
  '1003': VideoNode,
  '1004': AudioNode,
  generative: GenerativeNode,
  group: GroupNode,
  connectEndAnchor: ConnectEndAnchorNode,
  commentMarker: CommentMarkerNode as unknown as NodeTypes[string],
  [ANNOTATION_NODE_TYPE]: AnnotationNode,
};

const edgeTypes = {
  default: CustomEdge,
};

export type ProjectCanvasContentProps = {
  yjs: UseProjectSpacesResult;
  hotkeysDisabled?: boolean;
};

const ProjectCanvasContent: React.FC<ProjectCanvasContentProps> = ({ yjs, hotkeysDisabled = false }) => {
  const { t } = useTranslation();
  const { nodes, edges, applyLocalNodeChanges } = useCanvasData();
  const {
    onNodesChange,
    onEdgesChange,
    onConnect: onConnectStore,
    addNode,
    setEdges,
    updateNode,
    createDataNode,
  } = useCanvasActions();
  const { clear: clearMiniTool } = useMiniTool();
  // B.1 chips pick: when ChatPanel asks for a node selection, the
  // next `onNodeClick` should hand the id back via this context
  // (instead of falling through to v12 pickState branches).
  const chipsPick = useChipsPick();
  const activeMgr = useActiveCanvasSpace();
  const {
    canvasOverlayPanel,
    closeCanvasOverlayPanel,
    canvasCommentMode,
    canvasCommentComposer,
    setCanvasCommentMode,
    openCanvasCommentComposer,
    closeCanvasCommentComposer,
  } = useCanvasUI();
  const { getIntersectingNodes, getNodes, screenToFlowPosition } = useReactFlow();
  const nodesRef = useRef(nodes);
  const edgesRef = useRef(edges);
  const lastInputPanelAnchorRef = useRef<{ x: number; y: number } | null>(null);
  const [minimapOpen, setMinimapOpen] = useState(false);
  /**
   * Snap-to-grid is local UI state — it's a per-user editor
   * preference, not a collaborative property of the canvas
   * (other collaborators don't need to see "snap is on for me").
   * 16 px grid matches the v13 mockup; ReactFlow reads
   * `snapToGrid` + `snapGrid` props below.
   */
  const [snapEnabled, setSnapEnabled] = useState(false);
  const [contextMenu, setContextMenu] = useState<ContextMenuState>(null);
  const [connectEndMenu, setConnectEndMenu] = useState<ConnectEndMenuState>(null);
  const [tempConnectNodes, setTempConnectNodes] = useState<Node[]>([]);
  const [tempConnectEdges, setTempConnectEdges] = useState<Edge[]>([]);

  /** Keep the latest node snapshot for callbacks. */
  useEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);

  /** Keep the latest edge snapshot for callbacks. */
  useEffect(() => {
    edgesRef.current = edges;
  }, [edges]);

  /** Handle edge reconnect with latest edge snapshot (avoid stale closure). */
  const onReconnect = useCallback(
    (oldEdge: Edge, newConnection: Connection) => {
      const nextEdges = reconnectEdge(oldEdge, newConnection, edgesRef.current);
      setEdges(nextEdges);
    },
    [setEdges],
  );

  /** When a connect drag ends on empty space, create a temp anchor and open command menu. */
  const onConnectEnd: OnConnectEnd = (event, connectionState) => {
    if (connectionState.isValid) return;
    const fromNodeId = connectionState.fromNode?.id;
    const fromHandle = connectionState.fromHandle;
    const fromHandleId =
      fromHandle != null && typeof fromHandle === 'object' && 'id' in fromHandle
        ? String((fromHandle as { id: string }).id)
        : '';
    if (!fromNodeId || !fromHandleId) return;
    const target = 'changedTouches' in event ? (event as TouchEvent).target : (event as MouseEvent).target;
    if (target && (target as Element).closest?.('[data-connect-handle-area]')) return;
    const { clientX, clientY } =
      'changedTouches' in event ? (event as TouchEvent).changedTouches[0] : (event as MouseEvent);
    const position = screenToFlowPosition({ x: clientX, y: clientY });
    const tempAnchorNodeId = `connectEndAnchor-${Date.now()}`;
    const anchorNode: Node = {
      id: tempAnchorNodeId,
      type: 'connectEndAnchor',
      position,
      data: {},
      style: { width: 1, height: 1 },
    };

    const isFromInput = fromHandle?.type === 'target';
    if (isFromInput) {
      const tempEdge = {
        id: `e-connectEnd-${tempAnchorNodeId}-${fromNodeId}`,
        source: tempAnchorNodeId,
        target: fromNodeId,
        sourceHandle: connectEndAnchorSourceHandleId,
        targetHandle: fromHandleId,
      };
      setTempConnectNodes([anchorNode]);
      setTempConnectEdges(addEdge(tempEdge as Connection, []));
      setConnectEndMenu({
        clientX,
        clientY,
        tempAnchorNodeId,
        isFromInput: true,
        toNodeId: fromNodeId,
        toHandleId: fromHandleId,
      });
    } else {
      const tempEdge = {
        id: `e-connectEnd-${fromNodeId}-${tempAnchorNodeId}`,
        source: fromNodeId,
        target: tempAnchorNodeId,
        sourceHandle: fromHandleId,
        targetHandle: connectEndAnchorTargetHandleId,
      };
      setTempConnectNodes([anchorNode]);
      setTempConnectEdges(addEdge(tempEdge as Connection, []));
      setConnectEndMenu({
        clientX,
        clientY,
        tempAnchorNodeId,
        isFromInput: false,
        fromNodeId,
        fromHandleId,
      });
    }
  };

  /** Close connect-end menu and clear temporary anchor/edge. */
  const onConnectEndMenuClose = () => {
    if (connectEndMenu?.tempAnchorNodeId) {
      setTempConnectNodes([]);
      setTempConnectEdges([]);
    }
    setConnectEndMenu(null);
  };

  /** Sync command-menu position back to temporary anchor coordinates. */
  const onPanelPositionChange = (x: number, y: number, isFromInput: boolean) => {
    if (!connectEndMenu?.tempAnchorNodeId) return;
    if (isFromInput) lastInputPanelAnchorRef.current = { x, y };
    const flowPos = screenToFlowPosition({ x, y });
    const position = isFromInput ? { x: flowPos.x - 1, y: flowPos.y - 0.5 } : { x: flowPos.x, y: flowPos.y - 0.5 };
    updateNode(connectEndMenu.tempAnchorNodeId, { position });
  };

  /** Create a new node and edge after selecting node type in command menu. */
  const handleConnectEndSelect = (nodeType: string) => {
    if (!connectEndMenu) return;
    const { clientX, clientY, isFromInput, fromNodeId, fromHandleId, toNodeId, toHandleId } = connectEndMenu;
    if (isFromInput && (!toNodeId || !toHandleId)) return;
    if (!isFromInput && (!fromNodeId || !fromHandleId)) return;
    const anchor = isFromInput ? lastInputPanelAnchorRef.current : null;
    const screenX = anchor?.x ?? clientX;
    const screenY = anchor?.y ?? clientY;
    if (isFromInput) lastInputPanelAnchorRef.current = null;
    const flowPos = screenToFlowPosition({ x: screenX, y: screenY });
    const defaultWidth = defaultNodeWidthByType[nodeType] ?? 300;
    const position = isFromInput ? { x: flowPos.x - defaultWidth, y: flowPos.y } : { x: flowPos.x, y: flowPos.y };
    const currentNodes = nodesRef.current;
    const maxZIndex = currentNodes.reduce((max, n) => Math.max(max, (n as Node & { zIndex?: number }).zIndex ?? 0), 0);
    const newNodeId = generateConnectEndNodeId(nodeType);
    const handles = connectEndHandles[nodeType];
    const newNode: Node & { zIndex?: number } = {
      id: newNodeId,
      type: nodeType,
      position,
      selected: true,
      zIndex: maxZIndex + 1,
      data: { handles: handles ?? {} },
    };

    const sourceHandle = handles?.source?.[0];
    const sourceHandleId = sourceHandle ? `${sourceHandle.handleType}_0_${sourceHandle.number}` : '';
    const targetHandle = handles?.target?.[0];
    const targetHandleId = targetHandle ? `${targetHandle.handleType}_0_${targetHandle.number}` : '';

    const newEdge = isFromInput
      ? {
        id: `e-${newNodeId}-${toNodeId}-${Date.now()}`,
        source: newNodeId,
        target: toNodeId,
        sourceHandle: sourceHandleId,
        targetHandle: toHandleId,
      }
      : {
        id: `e-${fromNodeId}-${newNodeId}-${Date.now()}`,
        source: fromNodeId,
        target: newNodeId,
        sourceHandle: fromHandleId,
        targetHandle: targetHandleId,
      };

    const nextEdges = edgesRef.current.concat(newEdge as Edge);
    addNode(newNode, { select: true });
    setEdges(nextEdges);
    setTempConnectNodes([]);
    setTempConnectEdges([]);
    setConnectEndMenu(null);
  };

  /** On drag end, handle enter/leave group logic (supports multi-select drag). */
  const onNodeDragStop = (_: React.MouseEvent, node: Node) => {
    const allNodes = getNodes();
    const selectedNodes = allNodes.filter((n) => n.selected);
    const nodesToProcess = selectedNodes.length > 0 && selectedNodes.some((n) => n.id === node.id) ? selectedNodes : [node];
    for (const currentNode of nodesToProcess) {
      const parent = currentNode.parentId ? allNodes.find((n) => n.id === currentNode.parentId) : null;
      const intersectingNodes = getIntersectingNodes(currentNode);
      const intersectionIds = intersectingNodes.map((n) => n.id);
      if (parent && parent.type === 'group') {
        if (!intersectionIds.includes(parent.id)) {
          const bounds = getGroupBounds(parent);
          if (bounds) {
            updateNode(currentNode.id, {
              parentId: undefined,
              extent: undefined,
              position: {
                x: bounds.left + currentNode.position.x,
                y: bounds.top + currentNode.position.y,
              },
            });
          }
        }
        continue;
      }
      if (!currentNode.parentId && currentNode.type !== 'group') {
        const candidateGroups = intersectingNodes.filter((n) => n.type === 'group');
        for (const group of candidateGroups) {
          const bounds = getGroupBounds(group);
          if (bounds) {
            updateNode(currentNode.id, {
              parentId: group.id,
              extent: undefined,
              position: {
                x: currentNode.position.x - bounds.left,
                y: currentNode.position.y - bounds.top,
              },
            });
          }
          break;
        }
      }
    }
  };

  const lockedGroupIdsForSelectable = useMemo(() => getLockedGroupIds(nodes), [nodes]);
  const nodesWithSelectable = useMemo(() => {
    // Compute lock state once per node and apply two effects:
    //   - Group-locking still cascades selection-blocking to
    //     descendants (legacy behavior).
    //   - Per-node `data.locked` adds a subtle dashed amber outline
    //     so users can see what's locked without right-clicking
    //     each one. The outline is rendered via ReactFlow's node
    //     style rather than the per-node component to keep the
    //     visual single-sourced (every modality's *Node.tsx would
    //     otherwise need its own lock indicator).
    const anyLockedGroup = lockedGroupIdsForSelectable.size > 0;
    return nodes.map((n: Node) => {
      const isLockedGroup =
        n.type === 'group' &&
        (n.data as { locked?: boolean })?.locked === true;
      const isInsideLockedGroup =
        n.parentId !== undefined && lockedGroupIdsForSelectable.has(n.parentId);
      const isSelfLocked =
        (n.data as { locked?: boolean })?.locked === true;
      // Group-locked descendants stay non-selectable to match
      // legacy UX (selection inside a locked group is moot).
      const nextSelectable = isLockedGroup || isInsideLockedGroup ? false : undefined;
      // Highlight per-node locks visually. Locked groups already
      // have their own lock chrome via GroupNode; only highlight
      // non-group locked nodes here to avoid double indication.
      const lockOutlineStyle =
        isSelfLocked && n.type !== 'group'
          ? {
              outline: '2px dashed rgb(245, 158, 11)',
              outlineOffset: '4px',
              borderRadius: '8px',
            }
          : undefined;
      if (
        nextSelectable === undefined &&
        !lockOutlineStyle &&
        !anyLockedGroup
      ) {
        return n;
      }
      const next: Node = { ...n };
      if (nextSelectable === false) next.selectable = false;
      if (lockOutlineStyle) {
        next.style = { ...(n.style ?? {}), ...lockOutlineStyle };
      }
      return next;
    });
  }, [nodes, lockedGroupIdsForSelectable]);

  const reactFlowNodes = useMemo(() => {
    if (tempConnectNodes.length === 0) return nodesWithSelectable;
    return [...nodesWithSelectable, ...tempConnectNodes];
  }, [nodesWithSelectable, tempConnectNodes]);

  const handleNodesChange = useCallback(
    (changes: NodeChange[]) => {
      // Split: select/dimensions → local state only, position/remove → Yjs
      const localChanges: NodeChange[] = [];
      const yjsChanges: NodeChange[] = [];
      for (const c of changes) {
        if (c.type === 'select' || c.type === 'dimensions') {
          localChanges.push(c);
        } else {
          yjsChanges.push(c);
        }
      }
      if (localChanges.length) applyLocalNodeChanges(localChanges);
      if (yjsChanges.length) onNodesChange(yjsChanges);
    },
    [onNodesChange, applyLocalNodeChanges],
  );

  const onNodeClick = (e: React.MouseEvent, node: Node) => {
    // B.1 chip pick — handled before any v12 pickState branches so
    // chip-from-canvas is fully decoupled from the legacy
    // canvas-pick-into-editor flow (#135 will retire that). Locked
    // groups + their descendants are still off-limits to keep
    // accidental chip targets from a non-interactive surface.
    if (chipsPick.pickMode) {
      if (node.parentId && lockedGroupIdsForSelectable.has(node.parentId)) return;
      e.stopPropagation();
      chipsPick.pickNode(node.id);
      return;
    }
    if (node.parentId && lockedGroupIdsForSelectable.has(node.parentId)) return;
    const isLockedGroup = node.type === 'group' && (node.data as { locked?: boolean })?.locked === true;
    if (isLockedGroup) {
      onNodesChange(nodes.map((n: Node) => ({ type: 'select' as const, id: n.id, selected: n.id === node.id })));
    }
  };

  /** Open context menu on node right-click (ignore nodes in locked groups). */
  const onNodeContextMenu = (e: React.MouseEvent, node: Node) => {
    e.preventDefault();
    const isLockedGroup = node.type === 'group' && (node.data as { locked?: boolean })?.locked === true;
    const isInsideLockedGroup = node.parentId && lockedGroupIdsForSelectable.has(node.parentId);
    if (isLockedGroup || isInsideLockedGroup) return;
    setContextMenu({
      left: e.clientX,
      top: e.clientY,
      contextNodeId: node.id,
      clientX: e.clientX,
      clientY: e.clientY,
    });
  };

  /** Open context menu on pane right-click. */
  const onPaneContextMenu = (e: React.MouseEvent | MouseEvent) => {
    e.preventDefault();
    setContextMenu({
      left: e.clientX,
      top: e.clientY,
      contextNodeId: null,
      clientX: e.clientX,
      clientY: e.clientY,
    });
  };

  const onPaneClick = useCallback(
    (event: React.MouseEvent) => {
      if (!canvasCommentMode) return;
      const flowPosition = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      openCanvasCommentComposer({
        clientX: event.clientX + 12,
        clientY: event.clientY + 12,
        flowX: flowPosition.x,
        flowY: flowPosition.y,
      });
      setContextMenu(null);
      setConnectEndMenu(null);
    },
    [canvasCommentMode, openCanvasCommentComposer, screenToFlowPosition],
  );

  const handleCommentComposerSend = useCallback(
    (text: string) => {
      if (!canvasCommentComposer.open) return;
      const flowX = canvasCommentComposer.flowX;
      const flowY = canvasCommentComposer.flowY;
      if (typeof flowX !== 'number' || typeof flowY !== 'number') return;
      const maxZIndex = nodesRef.current.reduce(
        (max, node) => Math.max(max, (node as Node & { zIndex?: number }).zIndex ?? 0),
        0,
      );
      const id = `comment-${Date.now()}-${nanoid(5)}`;
      const markerSize = defaultNodeWidthByType.commentMarker ?? 44;
      const markerNode: Node & { zIndex?: number } = {
        id,
        type: 'commentMarker',
        position: { x: flowX - markerSize / 2, y: flowY - markerSize / 2 },
        selected: true,
        zIndex: maxZIndex + 1,
        draggable: true,
        data: {
          username: 'm',
          text,
        },
        style: {
          width: markerSize,
          height: markerSize,
        },
      };
      addNode(markerNode, { select: true });
      closeCanvasCommentComposer();
      setCanvasCommentMode(false);
    },
    [addNode, canvasCommentComposer, closeCanvasCommentComposer, setCanvasCommentMode],
  );

  /** Overlay edge highlight styles from Yjs collaborative selections. */
  const edgesWithHighlight = useMemo(() => {
    const selections = (yjs as unknown as { edgeSelections?: Map<string, { color: string }> })?.edgeSelections;
    if (!selections || selections.size === 0) return edges;
    return edges.map((edge: Edge) => {
      const selection = selections.get(edge.id);
      if (!selection) return edge;
      return {
        ...edge,
        style: {
          ...edge.style,
          stroke: selection.color,
          strokeWidth: 3,
        },
      };
    });
  }, [edges, yjs]);

  const reactFlowEdges = useMemo(() => {
    if (tempConnectEdges.length === 0) return edgesWithHighlight;
    return [...edgesWithHighlight, ...tempConnectEdges];
  }, [edgesWithHighlight, tempConnectEdges]);

  const yjsAny = yjs as unknown as {
    undo?: () => void;
    redo?: () => void;
    canUndo?: boolean;
    canRedo?: boolean;
  };

  /**
   * Mini-tool Apply handler. Routes on tool category:
   *
   *   - **Category A (frontend, instant)** — load the source image
   *     into a canvas, apply the pixel transform in-browser, upload
   *     the resulting blob through the canonical `uploadOne` so the
   *     URL written to Yjs is durable (presigned + permanent), then
   *     `createDataNode` a sibling with `content = newFileUrl`. State
   *     starts at `idle` — there is no `handling` phase because the
   *     work is already done by the time we touch Yjs.
   *
   *   - **Category B (backend, async)** — `createDataNode` a sibling
   *     stamped with `operation + operationParams`, connect source
   *     → sibling with a non-primary edge, then POST to the matching
   *     `/api/v1/mini-tools/*` endpoint. The Worker drives state
   *     transitions (idle → handling → idle/error) via
   *     NodeStateUpdateEvent → Hocuspocus → Yjs, so the frontend
   *     doesn't manually flip `state` here.
   *
   * Both paths spawn a fresh sibling node at `+360 right, +80 down`
   * of the source so the layout doesn't overlap. The source node is
   * never mutated — every Apply produces a new asset (spec invariant
   * §3.3 "源节点不变").
   */
  const handleMiniToolApply = useCallback(
    ({
      nodeId,
      toolId,
      values,
    }: {
      nodeId: string;
      toolId: string;
      values: Record<string, unknown>;
    }) => {
      if (!activeMgr) return;
      const sourceNode = nodesRef.current.find((n) => n.id === nodeId);
      if (!sourceNode) return;
      const sourceData = sourceNode.data as { content?: string } | undefined;
      const imageUrl = sourceData?.content;
      if (!imageUrl) return;

      const schema = findToolSchema(toolId);
      if (!schema) {
        console.error('[mini-tool] unknown toolId', toolId);
        return;
      }

      const siblingPosition = {
        x: sourceNode.position.x + 360,
        y: sourceNode.position.y + 80,
      };

      if (schema.category === 'A') {
        // Category A: do the work in the browser, then write a fully-
        // baked sibling node. No worker dispatch; idle from the start.
        // The sibling + edge are created only after the op + upload
        // succeed so a failed Apply doesn't litter the canvas with a
        // dangling placeholder node.
        const projectId = activeMgr.projectId;
        void (async () => {
          try {
            const res = await fetch(imageUrl, { mode: 'cors' });
            if (!res.ok) throw new Error(`fetch ${imageUrl}: ${res.status}`);
            const sourceBlob = await res.blob();

            const resultBlob = await runCategoryAOp(schema.id, sourceBlob, values);

            const filename = `${schema.id}-${Date.now()}.png`;
            const file = new File([resultBlob], filename, { type: 'image/png' });
            const uploaded = await uploadOne(file, { projectId });

            const newTargetNodeId = createDataNode({
              type: '1002',
              sourceNodeId: nodeId,
              position: siblingPosition,
              data: {
                name: schema.menuLabel || toolId,
                content: uploaded.fileUrl,
                operation: toolId,
                operationParams: values,
                ...(uploaded.width !== undefined ? { width: uploaded.width } : {}),
                ...(uploaded.height !== undefined ? { height: uploaded.height } : {}),
              },
            });
            setEdges([
              ...edgesRef.current,
              {
                id: `e-${nodeId}-${newTargetNodeId}`,
                source: nodeId,
                target: newTargetNodeId,
                sourceHandle: 'Image_0_0',
                targetHandle: 'Image_0_0',
              },
            ]);
          } catch (err) {
            console.error('[mini-tool] Category A op failed', err);
          }
        })();
        clearMiniTool();
        return;
      }

      // Category B (backend AIGC).
      const targetNodeId = createDataNode({
        type: '1002',
        sourceNodeId: nodeId,
        position: siblingPosition,
        data: {
          name: toolId,
          operation: toolId,
          operationParams: values,
        },
      });

      const edgeId = `e-${nodeId}-${targetNodeId}`;
      setEdges([
        ...edgesRef.current,
        {
          id: edgeId,
          source: nodeId,
          target: targetNodeId,
          sourceHandle: 'Image_0_0',
          targetHandle: 'Image_0_0',
        },
      ]);

      void executeImage({
        tool: toolId,
        image: imageUrl,
        project_id: activeMgr.projectId,
        space_id: activeMgr.spaceId,
        target_node_id: targetNodeId,
        node_ids: [targetNodeId],
        ...values,
      }).catch((err) => {
        // F4-framework: console for dev. Toast UI lands when the
        // canvas-level error surface is unified (F8 ViewportToolbar
        // is one candidate spot for a global mini-tool toast).
        console.error('[mini-tool] executeImage failed', err);
      });

      clearMiniTool();
    },
    [activeMgr, createDataNode, setEdges, clearMiniTool],
  );

  return (
    <div
      data-project-canvas-flow-root
      className='relative h-full w-full bg-background-default-secondary'
    >
      <ReactFlow
        nodes={reactFlowNodes}
        edges={reactFlowEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={handleNodesChange}
        onNodeDragStop={onNodeDragStop}
        onEdgesChange={onEdgesChange}
        onConnect={onConnectStore}
        onConnectEnd={onConnectEnd}
        onReconnect={onReconnect}
        onNodeClick={onNodeClick}
        onNodeContextMenu={onNodeContextMenu}
        onPaneClick={onPaneClick}
        onPaneContextMenu={onPaneContextMenu}
        defaultViewport={reactFlowDefaultViewport}
        selectionOnDrag
        panOnDrag={reactFlowPanOnDrag}
        panOnScroll
        zoomOnScroll={false}
        zoomOnPinch
        zoomOnDoubleClick={false}
        elevateNodesOnSelect={false}
        disableKeyboardA11y={true}
        minZoom={0.2}
        maxZoom={2}
        snapToGrid={snapEnabled}
        snapGrid={[16, 16]}
        proOptions={reactFlowProOptions}
        className='relative z-[1] origin-[0px_0px] backface-hidden antialiased'
        style={reactFlowStyle}
        onlyRenderVisibleElements={true}
        nodesDraggable
        nodesConnectable
        elementsSelectable
        selectNodesOnDrag={false}
        connectionRadius={20}
      >
        <ProjectCanvasViewportRegistrar />
        <Background color='#d0d0d0' variant={BackgroundVariant.Dots} gap={20} size={1} />
        <ClipboardPasteHandler />
        <HotkeysHandler
          yjsUndo={yjsAny.undo}
          yjsRedo={yjsAny.redo}
          yjsCanUndo={yjsAny.canUndo}
          yjsCanRedo={yjsAny.canRedo}
          disabled={hotkeysDisabled}
        />
        <LeftFloatingMenu />
        <GroupToolbarPanel />
        {minimapOpen && <CustomMiniMap />}
        <ViewportToolbar
          showMiniMap={minimapOpen}
          onToggleMiniMap={() => setMinimapOpen((v) => !v)}
          snapEnabled={snapEnabled}
          onToggleSnap={() => setSnapEnabled((v) => !v)}
        />
        <NodeContextMenu
          open={!!contextMenu}
          left={contextMenu?.left ?? 0}
          top={contextMenu?.top ?? 0}
          contextNodeId={contextMenu?.contextNodeId ?? null}
          clientX={contextMenu?.clientX ?? 0}
          clientY={contextMenu?.clientY ?? 0}
          onClose={() => setContextMenu(null)}
          yjsUndo={yjsAny.undo}
          yjsRedo={yjsAny.redo}
          yjsCanUndo={yjsAny.canUndo}
          yjsCanRedo={yjsAny.canRedo}
        />
        <ConnectEndCommandMenu
          open={!!connectEndMenu}
          left={connectEndMenu?.clientX ?? 0}
          top={connectEndMenu?.clientY ?? 0}
          anchorSide={connectEndMenu?.isFromInput ? 'input' : 'output'}
          onSelect={handleConnectEndSelect}
          onClose={onConnectEndMenuClose}
          onPanelPositionChange={onPanelPositionChange}
        />
      </ReactFlow>

      <BottomToolbar onApply={handleMiniToolApply} />
      <AnnotationComposer />
      {canvasOverlayPanel.open && (
        <div className='absolute top-[10px] right-[10px] bottom-[10px] z-10 pointer-events-auto'>
          <CanvasRightOverlayPanel onClose={closeCanvasOverlayPanel} />
        </div>
      )}
      {canvasCommentComposer.open && (
        <CanvasCommentComposer
          x={canvasCommentComposer.clientX ?? 0}
          y={canvasCommentComposer.clientY ?? 0}
          onCancel={closeCanvasCommentComposer}
          onSend={handleCommentComposerSend}
        />
      )}
      {/* Canvas-level Loading overlay removed intentionally: the global
          Suspense fallback (router) already shows a loader during code-
          split chunk load, and Yjs sync completes fast enough that a
          second overlay just creates visual duplication and flicker. */}
    </div>
  );
};

export default ProjectCanvasContent;
