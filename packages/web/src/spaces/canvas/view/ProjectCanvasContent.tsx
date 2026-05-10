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
import UndoRedoToolbar from '@/spaces/canvas/common/UndoRedoToolbar';
import NodeContextMenu from '@/spaces/canvas/common/NodeContextMenu';
import ConnectEndCommandMenu from '@/spaces/canvas/common/ConnectEndCommandMenu';
import ConnectEndAnchorNode, {
  connectEndAnchorSourceHandleId,
  connectEndAnchorTargetHandleId,
} from '@/spaces/canvas/common/ConnectEndAnchorNode';
import CanvasCommentComposer from '@/spaces/canvas/common/CanvasCommentComposer';
import CommentMarkerNode from '@/spaces/canvas/common/CommentMarkerNode';
import { LeftFloatingMenu } from '@/features/canvas-left-menu';
import { BottomToolbar, useMiniTool } from '@/features/mini-tools';
import {
  AnnotationNode,
  AnnotationComposer,
  ANNOTATION_NODE_TYPE,
} from '@/features/annotation';
import { executeImage } from '@/data/api/mini-tools';
import { useActiveCanvasSpace } from '@/domain/space/ActiveCanvasSpaceContext';
import CanvasRightOverlayPanel from '@/spaces/canvas/view/CanvasRightOverlayPanel';
import ProjectCanvasViewportRegistrar from '@/spaces/canvas/view/ProjectCanvasViewportRegistrar';
import { captureCanvasPickCaretRange } from '@/features/chat/components/AgentInput';
import { useCanvasData } from '@/spaces/canvas/contexts/CanvasDataContext';
import { useCanvasActions } from '@/spaces/canvas/hooks/useCanvasActions';
import { useCanvasUI } from '@/spaces/canvas/contexts/CanvasUIContext';
import { type UseProjectSpacesResult } from '@/domain/space/useProjectSpaces';
import {
  type PickPending,
  type CanvasWorkflowNodeData,
} from '@/spaces/canvas/types';
import {
  getGroupBounds,
  getLockedGroupIds,
  getProjectImageNodeContentUrl,
  getNodeContentForMention,
  getAgentCanvasPickOverlayAnchorFromClick,
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
  const [agentCanvasPickEditingNodeId, setAgentCanvasPickEditingNodeId] = useState<string | null>(null);
  const { getIntersectingNodes, getNodes, screenToFlowPosition } = useReactFlow();
  const nodesRef = useRef(nodes);
  const edgesRef = useRef(edges);
  const lastInputPanelAnchorRef = useRef<{ x: number; y: number } | null>(null);
  const [minimapOpen, setMinimapOpen] = useState(false);
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

  useEffect(() => {
    const source = nodes.find(
      (n) => (n.data as Partial<CanvasWorkflowNodeData> | undefined)?.pickState?.fromCanvas === true,
    );
    if (source && agentCanvasPickEditingNodeId !== source.id) {
      setAgentCanvasPickEditingNodeId(source.id);
      return;
    }
    if (!agentCanvasPickEditingNodeId) return;
    const editing = nodes.find((n) => n.id === agentCanvasPickEditingNodeId);
    const stillPicking =
      editing && (editing.data as Partial<CanvasWorkflowNodeData> | undefined)?.pickState?.fromCanvas === true;
    if (!stillPicking) {
      setAgentCanvasPickEditingNodeId(null);
    }
  }, [nodes, agentCanvasPickEditingNodeId]);

  const agentCanvasPickEditMode = agentCanvasPickEditingNodeId != null;

  const isMentionPickMode = useMemo(() => {
    if (!agentCanvasPickEditingNodeId) return false;
    const source = nodes.find((n) => n.id === agentCanvasPickEditingNodeId);
    const consumeFrom = (source?.data as Partial<CanvasWorkflowNodeData> | undefined)?.pickState?.consumeFrom;
    return consumeFrom === 'chatRecordPanelMention' || consumeFrom === 'nodeComposerMention';
  }, [agentCanvasPickEditingNodeId, nodes]);

  const exitAgentCanvasPickMode = useCallback(() => {
    if (!agentCanvasPickEditingNodeId) return;
    const sourceId = agentCanvasPickEditingNodeId;
    const list = nodesRef.current;
    updateNode(sourceId, { data: { pickState: null } }, { history: 'skip' });
    for (const n of list) {
      const boxes = (n.data as Partial<CanvasWorkflowNodeData> | undefined)?.pickState?.resultBoxes;
      if (boxes?.length) {
        updateNode(n.id, { data: { pickState: null } }, { history: 'skip' });
      }
    }
  }, [agentCanvasPickEditingNodeId, updateNode]);

  useEffect(() => {
    if (!agentCanvasPickEditMode) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      exitAgentCanvasPickMode();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [agentCanvasPickEditMode, exitAgentCanvasPickMode]);

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
    if (lockedGroupIdsForSelectable.size === 0) return nodes;
    return nodes.map((n: Node) => {
      const isLockedGroup = n.type === 'group' && (n.data as { locked?: boolean })?.locked === true;
      const isInsideLockedGroup = n.parentId && lockedGroupIdsForSelectable.has(n.parentId);
      if (isLockedGroup || isInsideLockedGroup) return { ...n, selectable: false };
      return n;
    });
  }, [nodes, lockedGroupIdsForSelectable]);

  /** Set of node ids already connected as upstream sources of the pick-source node (for mention mode). */
  const existingMentionUpstreamIds = useMemo(() => {
    if (!isMentionPickMode || !agentCanvasPickEditingNodeId) return new Set<string>();
    return new Set(edges.filter((e) => e.target === agentCanvasPickEditingNodeId).map((e) => e.source));
  }, [isMentionPickMode, agentCanvasPickEditingNodeId, edges]);

  const reactFlowNodes = useMemo(() => {
    if (!agentCanvasPickEditMode || !agentCanvasPickEditingNodeId) {
      if (tempConnectNodes.length === 0) return nodesWithSelectable;
      return [...nodesWithSelectable, ...tempConnectNodes];
    }
    const mapPickModeNode = (node: Node): Node => {
      const isActivePickSource = node.id === agentCanvasPickEditingNodeId;
      const contentUrl = node.type === '1002' ? getProjectImageNodeContentUrl(node) : null;
      const alreadyLinked = isMentionPickMode && existingMentionUpstreamIds.has(node.id);
      const isSelectableImageTarget = isMentionPickMode
        ? Boolean(getNodeContentForMention(node)) && !isActivePickSource && !alreadyLinked
        : node.type === '1002' && Boolean(contentUrl);
      const isHighlighted = isActivePickSource || isSelectableImageTarget;
      const pointerEvents: React.CSSProperties['pointerEvents'] = isHighlighted ? 'auto' : 'none';
      const cursor: React.CSSProperties['cursor'] = isHighlighted
        ? isSelectableImageTarget
          ? 'pointer'
          : 'default'
        : 'not-allowed';
      const pickRing = isSelectableImageTarget ? '0 0 0 2px rgba(151, 160, 255, 0.35)' : undefined;
      // In mention mode the source node is highlighted but not "selected" so its toolbar stays hidden.
      const showAsSelected = isActivePickSource && !isMentionPickMode;
      return {
        ...node,
        selected: showAsSelected,
        selectable: showAsSelected,
        draggable: false,
        focusable: isHighlighted,
        style: {
          ...(node.style ?? {}),
          pointerEvents,
          cursor,
          opacity: isHighlighted ? 1 : alreadyLinked ? 0.4 : 0.28,
          filter: isHighlighted ? 'none' : 'saturate(0.2) brightness(0.6)',
          transition: 'opacity 160ms ease, filter 160ms ease, box-shadow 200ms ease',
          boxShadow: pickRing ?? (node.style as { boxShadow?: string } | undefined)?.boxShadow,
        },
      };
    };
    return [...nodesWithSelectable.map(mapPickModeNode), ...tempConnectNodes.map(mapPickModeNode)];
  }, [
    agentCanvasPickEditMode,
    agentCanvasPickEditingNodeId,
    isMentionPickMode,
    existingMentionUpstreamIds,
    nodesWithSelectable,
    tempConnectNodes,
  ]);

  const handleNodesChange = useCallback(
    (changes: NodeChange[]) => {
      // Split: select/dimensions → local state only, position/remove → Yjs
      const localChanges: NodeChange[] = [];
      const yjsChanges: NodeChange[] = [];
      for (const c of changes) {
        if (c.type === 'select' || c.type === 'dimensions') {
          if (!(agentCanvasPickEditingNodeId && c.type === 'select')) {
            localChanges.push(c);
          }
        } else {
          yjsChanges.push(c);
        }
      }
      if (localChanges.length) applyLocalNodeChanges(localChanges);
      if (yjsChanges.length) onNodesChange(yjsChanges);
    },
    [agentCanvasPickEditingNodeId, onNodesChange, applyLocalNodeChanges],
  );

  const onNodeClick = (e: React.MouseEvent, node: Node) => {
    if (agentCanvasPickEditingNodeId) {
      if (node.parentId && lockedGroupIdsForSelectable.has(node.parentId)) return;
      if (isMentionPickMode) {
        // Mention mode: all node types with content are valid targets (except the source itself or already-linked nodes).
        const sourceId = agentCanvasPickEditingNodeId;
        if (node.id === sourceId) return;
        if (existingMentionUpstreamIds.has(node.id)) return;
        const nodeContent = getNodeContentForMention(node);
        if (!nodeContent) return;
        const sourceNode = nodes.find((n) => n.id === sourceId);
        const sourceData = sourceNode?.data as Partial<CanvasWorkflowNodeData> | undefined;
        if (!sourceData?.pickState?.composerFocused) return;
        const prevPendingList: PickPending[] = sourceData.pickState?.pendingList ?? [];
        const placeholderId = nanoid();
        captureCanvasPickCaretRange(placeholderId, sourceId);
        const nextPending: PickPending = {
          targetNodeId: node.id,
          placeholderId,
          content: nodeContent.content,
          name: nodeContent.name,
          resourceType: nodeContent.resourceType,
        };
        updateNode(sourceId, {
          data: { pickState: { pendingList: [...prevPendingList, nextPending] } },
        });
        return;
      }
      if (node.type === '1002') {
        const targetEl = e.target as HTMLElement | null;
        const hitImageViewport = Boolean(targetEl?.closest(`[data-agent-image-viewport="${node.id}"]`));
        if (!hitImageViewport) return;
        const url = getProjectImageNodeContentUrl(node);
        if (url) {
          const nameFromUrl = url.split('/').pop()?.split('?')[0] || 'image';
          const sourceId = agentCanvasPickEditingNodeId;
          const overlayAnchor = getAgentCanvasPickOverlayAnchorFromClick(e, node.id);
          const sourceNode = nodes.find((n) => n.id === sourceId);
          const sourceData = sourceNode?.data as Partial<CanvasWorkflowNodeData> | undefined;
          const composerFocused = Boolean(sourceData?.pickState?.composerFocused);
          if (!composerFocused) return;
          const prevPendingList: PickPending[] = sourceData?.pickState?.pendingList ?? [];
          const placeholderId = nanoid();
          captureCanvasPickCaretRange(placeholderId, sourceId);
          const nextPending: PickPending = {
            targetNodeId: node.id,
            placeholderId,
            content: url,
            name: nameFromUrl,
            ...(overlayAnchor ? { overlayAnchor } : {}),
          };
          updateNode(sourceId, {
            data: {
              pickState: {
                pendingList: [...prevPendingList, nextPending],
              },
            },
          });
        }
      }
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
      if (!canvasCommentMode || agentCanvasPickEditMode) return;
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
    [agentCanvasPickEditMode, canvasCommentMode, openCanvasCommentComposer, screenToFlowPosition],
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
   * Mini-tool Apply handler. Three steps in one user action:
   *   1. Spawn a new sibling asset node (idle, with operation +
   *      operationParams stamped) at +360px right of the source so
   *      the layout doesn't overlap.
   *   2. Connect source → sibling with a non-primary edge so the
   *      lineage is visible on the canvas (matches mockup §10.13).
   *   3. POST `/api/v1/mini-tools/image` with target_node_id =
   *      sibling. The Worker drives state transitions
   *      (idle → handling → idle/error) via NodeStateUpdateEvent
   *      → Hocuspocus → Yjs, so the frontend doesn't manually flip
   *      `state` here.
   *
   * F4-framework only handles Category B (backend) tools. Picking a
   * Category A tool today still calls this handler — the request
   * will 4xx since the server schema covers Category B only — which
   * is fine: F4-categoryA will route Category A through an in-browser
   * canvas op instead of going to the network.
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

      const targetNodeId = createDataNode({
        type: '1002',
        sourceNodeId: nodeId,
        position: {
          x: sourceNode.position.x + 360,
          y: sourceNode.position.y + 80,
        },
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
      style={{ cursor: agentCanvasPickEditMode ? 'not-allowed' : 'default' }}
    >
      {agentCanvasPickEditMode && <div className='pointer-events-none absolute inset-0 z-0 bg-black/35' />}
      {agentCanvasPickEditMode && (
        <div className='pointer-events-none absolute inset-x-0 top-3 z-[20] flex justify-center'>
          <button
            type='button'
            className='pointer-events-auto inline-flex h-9 items-center gap-2 rounded-md border border-white/40 bg-black/50 px-3 text-xs font-medium text-white backdrop-blur-sm hover:bg-black/65'
            onClick={exitAgentCanvasPickMode}
          >
            <span>{t('canvas.pickMode.clickHereOrPress', 'Click here or press')}</span>
            <span className='rounded border border-white/55 px-1 text-[10px]'>ESC</span>
            <span>{t('canvas.pickMode.toExit', 'to exit')}</span>
          </button>
        </div>
      )}
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
        selectionOnDrag={!agentCanvasPickEditMode}
        panOnDrag={reactFlowPanOnDrag}
        panOnScroll
        zoomOnScroll={false}
        zoomOnPinch
        zoomOnDoubleClick={false}
        elevateNodesOnSelect={false}
        disableKeyboardA11y={true}
        minZoom={0.2}
        maxZoom={2}
        proOptions={reactFlowProOptions}
        className='relative z-[1] origin-[0px_0px] backface-hidden antialiased'
        style={reactFlowStyle}
        onlyRenderVisibleElements={true}
        nodesDraggable={!agentCanvasPickEditMode}
        nodesConnectable={!agentCanvasPickEditMode}
        elementsSelectable={!agentCanvasPickEditMode}
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
        <UndoRedoToolbar
          yjsUndo={yjsAny.undo}
          yjsRedo={yjsAny.redo}
          yjsCanUndo={yjsAny.canUndo}
          yjsCanRedo={yjsAny.canRedo}
          minimapOpen={minimapOpen}
          onToggleMinimap={() => setMinimapOpen((v) => !v)}
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
