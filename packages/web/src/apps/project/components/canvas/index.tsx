import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { nanoid } from 'nanoid';
import {
  addEdge,
  Background,
  BackgroundVariant,
  ReactFlow,
  ReactFlowProvider,
  reconnectEdge,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
  type NodeTypes,
  type OnConnectEnd,
} from '@xyflow/react';
import TextNode from './dataNode/textNode/TextNode';
import ImageNode from './dataNode/imageNode/ImageNode';
import VideoNode from './dataNode/videoNode/VideoNode';
import AudioNode from './dataNode/audioNode/AudioNode';
import CustomEdge from './common/Edge';
import GroupNode from './common/GroupNode';
import ClipboardPasteHandler from './common/ClipboardPasteHandler';
import HotkeysHandler from './common/HotkeysHandler';
import NodeLibraryPanel from './ui/NodeLibraryPanel';
import GroupToolbarPanel from './common/GroupToolbarPanel';
import CustomMiniMap from './common/CustomMiniMap';
import UndoRedoToolbar from './common/UndoRedoToolbar';
import NodeContextMenu from './common/NodeContextMenu';
import { CanvasToastStack } from './ui/CanvasToastStack';
import ConnectEndCommandMenu from './common/ConnectEndCommandMenu';
import ConnectEndAnchorNode, {
  connectEndAnchorSourceHandleId,
  connectEndAnchorTargetHandleId,
} from './common/ConnectEndAnchorNode';
import CanvasCommentComposer from './common/CanvasCommentComposer';
import CommentMarkerNode from './common/CommentMarkerNode';
import CanvasRightOverlayPanel from './ui/CanvasRightOverlayPanel';
import { captureCanvasPickCaretRange } from '@/components/base/agent/AgentInput';
import { useCanvasData } from '@/contexts/CanvasDataContext';
import { useCanvasActions } from '@/hooks/useCanvasActions';
import { useCanvasUI } from '@/hooks/useCanvasUI';
import { type UseYjsStoreResult } from '@/hooks/useYjsProjectStore';
import {
  type PickPending,
  type CanvasWorkflowNodeData,
  type ResourceType,
  type ProjectCanvasViewportApi,
  getProjectCanvasPaneClientCenter,
  setProjectCanvasViewportApi,
} from '@/apps/project/components/canvas/types';

type ContextMenuState = {
  left: number;
  top: number;
  contextNodeId: string | null;
  clientX: number;
  clientY: number;
} | null;

type ConnectEndMenuState = {
  clientX: number;
  clientY: number;
  tempAnchorNodeId: string;
  isFromInput: boolean;
  fromNodeId?: string;
  fromHandleId?: string;
  toNodeId?: string;
  toHandleId?: string;
} | null;

/** Get group-node bounds (top-left + size), or null when invalid. */
const getGroupBounds = (groupNode: Node) => {
  if (groupNode.type !== 'group') return null;
  const style = groupNode.style;
  const w = Number(style?.width) || 0;
  const h = Number(style?.height) || 0;
  if (w <= 0 || h <= 0) return null;
  return {
    left: groupNode.position.x,
    top: groupNode.position.y,
    width: w,
    height: h,
  };
};

/** Collect ids of locked group nodes. */
const getLockedGroupIds = (nodes: Node[]): Set<string> => {
  const set = new Set<string>();
  nodes.forEach((n: Node) => {
    if (n.type === 'group' && (n.data as { locked?: boolean })?.locked === true) {
      set.add(n.id);
    }
  });
  return set;
};

/** Current output URL for project canvas image nodes (1002), or null.
 * Canvas-native schema: reads data.content directly.
 */
const getProjectImageNodeContentUrl = (node: Node): string | null => {
  if (node.type !== '1002') return null;
  const data = node.data as Partial<CanvasWorkflowNodeData>;
  return data.content ?? null;
};

/** Extract pickable content from any canvas node for mention mode (all node types). */
const getNodeContentForMention = (node: Node): { content: string; name: string; resourceType: ResourceType } | null => {
  const data = node.data as Partial<CanvasWorkflowNodeData> | undefined;
  const name = typeof data?.name === 'string' && data.name.trim() ? data.name : '';
  if (node.type === '1002') {
    const url = data?.content ?? null;
    if (!url) return null;
    return { content: url, name: name || 'image', resourceType: 'image' };
  }
  if (node.type === '1003') {
    // Video URL — read from data.content (canvas-native schema).
    const url = data?.content ?? null;
    if (!url) return null;
    return { content: url, name: name || 'video', resourceType: 'video' };
  }
  if (node.type === '1004') {
    // Audio URL — read from data.content (canvas-native schema).
    const url = data?.content ?? null;
    if (!url) return null;
    return { content: url, name: name || 'audio', resourceType: 'audio' };
  }
  if (node.type === '1001') {
    // TODO PR-C+: text content lives in the Yjs `prompt` Y.XmlFragment, not in
    // `data.content`. Extracting plain text for mention mode requires accessing
    // the TipTap document. Return null until that path is implemented.
    return null;
  }
  return null;
};

/**
 * Compute click position percentage in the target image viewport (`data-agent-image-viewport`).
 * Falls back to the react-flow node shell (`data-id`) if viewport element is missing.
 * @param e - node click event
 * @param nodeId - clicked node id
 * @returns percentage in range 0-100, or undefined when no anchor element is found
 */
const getAgentCanvasPickOverlayAnchorFromClick = (
  e: React.MouseEvent,
  nodeId: string,
): { xPct: number; yPct: number } | undefined => {
  const pctInRect = (clientX: number, clientY: number, rect: DOMRect) => {
    if (rect.width <= 0 || rect.height <= 0) return undefined;
    const xPct = Math.min(100, Math.max(0, ((clientX - rect.left) / rect.width) * 100));
    const yPct = Math.min(100, Math.max(0, ((clientY - rect.top) / rect.height) * 100));
    return { xPct, yPct };
  };

  let el: HTMLElement | null = e.target as HTMLElement;
  while (el) {
    if (el.getAttribute('data-agent-image-viewport') === nodeId) {
      const hit = pctInRect(e.clientX, e.clientY, el.getBoundingClientRect());
      if (hit) return hit;
      break;
    }
    el = el.parentElement;
  }

  el = e.target as HTMLElement;
  while (el) {
    if (el.getAttribute('data-id') === nodeId) {
      return pctInRect(e.clientX, e.clientY, el.getBoundingClientRect());
    }
    el = el.parentElement;
  }
  return undefined;
};

const connectEndHandles: Record<
  string,
  { target?: { handleType: string; number: number }[]; source?: { handleType: string; number: number }[] }
> = {
  '1001': { target: [{ handleType: 'Text', number: 0 }], source: [{ handleType: 'Text', number: 0 }] },
  '1002': { target: [{ handleType: 'Image', number: 0 }], source: [{ handleType: 'Image', number: 0 }] },
  '1003': { target: [{ handleType: 'Video', number: 0 }], source: [{ handleType: 'Video', number: 0 }] },
  '1004': { target: [{ handleType: 'Audio', number: 0 }], source: [{ handleType: 'Audio', number: 0 }] },
};

const generateConnectEndNodeId = (nodeType: string): string => `${nodeType}-${Date.now()}-${nanoid(5)}`;

const defaultNodeWidthByType: Record<string, number> = {
  '1001': 300,
  '1002': 300,
  '1003': 300,
  '1004': 472,
  commentMarker: 44,
};

const nodeTypes: NodeTypes = {
  '1001': TextNode,
  '1002': ImageNode,
  '1003': VideoNode,
  '1004': AudioNode,
  group: GroupNode,
  connectEndAnchor: ConnectEndAnchorNode,
  commentMarker: CommentMarkerNode as unknown as NodeTypes[string],
};

const edgeTypes = {
  default: CustomEdge,
};

const reactFlowDefaultViewport = { x: 0, y: 0, zoom: 0.5 } as const;
const reactFlowPanOnDrag: [number] = [1];
const reactFlowProOptions = { hideAttribution: true } as const;
const reactFlowStyle = { contain: 'layout style paint' } as const;

/** Registers the viewport API (see `getProjectCanvasViewportApi`) for the image editor sibling panel. */
const ProjectCanvasViewportRegistrar: React.FC = () => {
  const { screenToFlowPosition, setCenter, getZoom, getNodes, setNodes } = useReactFlow();
  useLayoutEffect(() => {
    const api: ProjectCanvasViewportApi = {
      getViewportCenterFlow: () => {
        const c = getProjectCanvasPaneClientCenter();
        if (!c) return { x: 200, y: 200 };
        return screenToFlowPosition(c);
      },
      centerOnFirstNodeId: (nodeIds: string[], select = false) => {
        if (nodeIds.length === 0) return;
        const idSet = new Set(nodeIds);
        const target = getNodes().find((n) => idSet.has(n.id));
        if (!target) return;
        if (select) {
          setNodes((prev) => prev.map((n) => ({ ...n, selected: n.id === target.id })));
        }
        const style = (target.style ?? {}) as { width?: number; height?: number };
        const nodeWidth = target.width ?? style.width ?? defaultNodeWidthByType[target.type ?? '1001'] ?? 300;
        const nodeHeight = target.height ?? style.height ?? 250;
        void setCenter(target.position.x + nodeWidth / 2, target.position.y + nodeHeight / 2, {
          zoom: getZoom(),
          duration: 400,
        });
      },
    };
    setProjectCanvasViewportApi(api);
    return () => setProjectCanvasViewportApi(null);
  }, [screenToFlowPosition, setCenter, getZoom, getNodes, setNodes]);
  return null;
};

type ProjectCanvasContentProps = {
  yjs: UseYjsStoreResult;
  hotkeysDisabled?: boolean;
};

const ProjectCanvasContent: React.FC<ProjectCanvasContentProps> = ({ yjs, hotkeysDisabled = false }) => {
  const { nodes, edges, applyLocalNodeChanges } = useCanvasData();
  const {
    onNodesChange,
    onEdgesChange,
    onConnect: onConnectStore,
    addNode,
    setEdges,
    updateNode,
  } = useCanvasActions();
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
    const selections = yjs?.edgeSelections;
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
  }, [edges, yjs?.edgeSelections]);

  const reactFlowEdges = useMemo(() => {
    if (tempConnectEdges.length === 0) return edgesWithHighlight;
    return [...edgesWithHighlight, ...tempConnectEdges];
  }, [edgesWithHighlight, tempConnectEdges]);

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
            <span>Click here or press</span>
            <span className='rounded border border-white/55 px-1 text-[10px]'>ESC</span>
            <span>to exit</span>
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
          yjsUndo={yjs?.undo}
          yjsRedo={yjs?.redo}
          yjsCanUndo={yjs?.canUndo}
          yjsCanRedo={yjs?.canRedo}
          disabled={hotkeysDisabled}
        />
        <NodeLibraryPanel />
        <GroupToolbarPanel />
        {minimapOpen && <CustomMiniMap />}
        <UndoRedoToolbar
          yjsUndo={yjs?.undo}
          yjsRedo={yjs?.redo}
          yjsCanUndo={yjs?.canUndo}
          yjsCanRedo={yjs?.canRedo}
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
          yjsUndo={yjs?.undo}
          yjsRedo={yjs?.redo}
          yjsCanUndo={yjs?.canUndo}
          yjsCanRedo={yjs?.canRedo}
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

type ProjectCanvasProps = {
  yjs: UseYjsStoreResult;
  hotkeysDisabled?: boolean;
};

/** Public ProjectCanvas entry: provides ReactFlow context only to the canvas subtree. */
const ProjectCanvas: React.FC<ProjectCanvasProps> = ({ yjs, hotkeysDisabled }) => (
  <ReactFlowProvider>
    <ProjectCanvasContent yjs={yjs} hotkeysDisabled={hotkeysDisabled} />
    <CanvasToastStack />
  </ReactFlowProvider>
);

export default ProjectCanvas;
