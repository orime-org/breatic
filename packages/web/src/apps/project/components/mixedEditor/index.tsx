import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDispatch } from 'react-redux';
import { nanoid } from 'nanoid';
import {
  Background,
  BackgroundVariant,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type Node,
  type NodeTypes,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useMixedEditorStore } from '@/hooks/useMixedEditorStore';
import { useYjsStore } from '@/hooks/useYjsProjectStore';
import {
  resetMixedEditor,
  resetMixedEditorNodes,
  resetMixedEditorEdges,
} from '@/store/modules/mixedEditor';
import { useCanvasUI } from '@/hooks/useCanvasUI';
import { useCanvasData } from '@/contexts/CanvasDataContext';
import { captureCanvasPickCaretRange } from '@/components/base/agent/AgentInput';
import Loading from '@/components/loading';
import EmptyState from './ui/EmptyState';
import UndoRedoToolbar from '../canvas/common/UndoRedoToolbar';
import ImageNode from './node/imageNode/ImageNode';
import SidePanel from './node/imageNode/SidePanel';
import AudioNode from './node/audioNode';
import VideoNode from './node/videoNode/videoNode';
import GroupNode from './common/GroupNode';
import StitchPlaceholderNode from './node/imageNode/stitch/StitchPlaceholderNode';
import {
  StitchPlaceholderPanel,
  stitchPlaceholderDefaultCols,
  stitchPlaceholderDefaultHeight,
  stitchPlaceholderDefaultRows,
  stitchPlaceholderDefaultWidth,
} from './node/imageNode/stitch/StitchPlaceholderPanel';
import StitchModeBanner from './node/imageNode/stitch/StitchModeBanner';
import AgentPickModeBanner from './node/imageNode/pick/AgentPickModeBanner';
import BlankPlaceholderNode from './node/imageNode/blank/BlankPlaceholderNode';
import {
  BlankPlaceholderPanel,
  blankPlaceholderDefaultHeight,
  blankPlaceholderDefaultWidth,
} from './node/imageNode/blank/BlankPlaceholderPanel';
import GroupToolbarPanel from './common/GroupToolbarPanel';
import NodeContextMenu from './common/NodeContextMenu';
import {
  createEditorImageNodeData,
  createEditorAudioNodeData,
  createEditorVideoNodeData,
  imageEditorAudioNodeType,
  imageEditorImageNodeType,
  imageEditorVideoNodeType,
  type ImageFlowNodeData,
} from './types';

type EditorInnerProps = {
  nodeId: string;
  hotkeysDisabled?: boolean;
};

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

const getAgentImagePickOverlayAnchorFromClick = (
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
    if (el.getAttribute('data-agent-video-viewport') === nodeId) {
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

const EditorInner: React.FC<EditorInnerProps> = ({ nodeId, hotkeysDisabled = false }) => {
  const hotkeysDisabledRef = useRef(hotkeysDisabled);
  hotkeysDisabledRef.current = hotkeysDisabled;
  const [contextMenu, setContextMenu] = useState<{
    left: number;
    top: number;
    contextNodeId: string | null;
    clientX: number;
    clientY: number;
  } | null>(null);
  const [minimapOpen, setMinimapOpen] = useState(false);
  const [gridPreviewPos, setGridPreviewPos] = useState<{ x: number; y: number } | null>(null);
  const [blankPreviewPos, setBlankPreviewPos] = useState<{ x: number; y: number } | null>(null);
  const [stitchEditingNodeId, setStitchEditingNodeId] = useState<string | null>(null);
  const [agentCanvasPickEditingNodeId, setAgentCanvasPickEditingNodeId] = useState<string | null>(null);
  const dispatch = useDispatch();
  const { workflowId } = useCanvasUI();
  const { nodes: canvasNodes } = useCanvasData();

  /** Clears local slice when there is no workflowId; with workflowId the main Yjs doc repopulates—no reset here. */
  useEffect(() => {
    if (workflowId) return;
    dispatch(resetMixedEditorNodes());
    dispatch(resetMixedEditorEdges());
    dispatch(resetMixedEditor());
    return () => {
      dispatch(resetMixedEditorNodes());
      dispatch(resetMixedEditorEdges());
      dispatch(resetMixedEditor());
    };
  }, [dispatch, workflowId]);

  const {
    nodes,
    edges,
    setNodes,
    activeTool,
    expandViewportLocked,
    setActiveTool,
    onNodesChange,
    onEdgesChange,
    updateNode,
    importImagesFromFiles,
    importAudiosFromFiles,
    importVideosFromFiles,
    favoriteAssets,
    toggleFavoriteAsset,
  } = useMixedEditorStore();
  const panelCanvasNode = canvasNodes.find((n) => n.id === nodeId);
  const panelCanvasNodeType = String(panelCanvasNode?.type ?? '');
  const mixedEditorMediaType: 'image' | 'video' | 'audio' =
    panelCanvasNodeType === '1003' ? 'video' : panelCanvasNodeType === '1004' ? 'audio' : 'image';
  const hasBootstrappedFromSourceRef = useRef(false);
  const flowInteractionRootRef = useRef<HTMLDivElement>(null);
  const { getIntersectingNodes, getNodes, screenToFlowPosition, getZoom } = useReactFlow();
  const closeContextMenu = () => setContextMenu(null);
  /**
   * Match `canvas/index.tsx`: `panOnScroll` + `zoomOnPinch` (no `zoomOnScroll`).
   * Disabled only while Expand locks the viewport; not tied to sidebar tool.
   */
  const flowWheelPanAndPinchEnabled = !expandViewportLocked;
  const previewZoom = getZoom();
  const stitchEditMode = stitchEditingNodeId != null;

  const agentCanvasPickEditMode = agentCanvasPickEditingNodeId != null;

  const handleMouseMoveCapture = (e: React.MouseEvent<HTMLDivElement>) => {
    if (activeTool === 'crop') {
      setGridPreviewPos({ x: e.clientX, y: e.clientY });
    } else if (activeTool === 'blank') {
      setBlankPreviewPos({ x: e.clientX, y: e.clientY });
    }
  };

  const handleMouseLeave = () => {
    if (activeTool === 'crop') setGridPreviewPos(null);
    if (activeTool === 'blank') setBlankPreviewPos(null);
  };

  const handleMouseDownCapture = (e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement | null;
    if (target?.closest('[data-image-editor-context-menu="true"]')) return;
    closeContextMenu();
  };

  const handleNodeContextMenu = (e: React.MouseEvent, node: Node) => {
    e.preventDefault();
    setContextMenu({
      left: e.clientX,
      top: e.clientY,
      contextNodeId: node.id,
      clientX: e.clientX,
      clientY: e.clientY,
    });
  };

  const handlePaneContextMenu = (e: MouseEvent | React.MouseEvent) => {
    e.preventDefault();
    if (activeTool === 'crop' || activeTool === 'blank') {
      setGridPreviewPos(null);
      setBlankPreviewPos(null);
      setActiveTool('select');
      closeContextMenu();
      return;
    }
    setContextMenu({
      left: e.clientX,
      top: e.clientY,
      contextNodeId: null,
      clientX: e.clientX,
      clientY: e.clientY,
    });
  };

  const handleNodeClick = (e: React.MouseEvent, node: Node) => {
    console.warn('[ImageEditor] node click', { id: node.id, type: node.type, data: node.data });
    closeContextMenu();

    if (agentCanvasPickEditingNodeId) {
      const sourceNode = nodes.find((n) => n.id === agentCanvasPickEditingNodeId);
      const sourceData = sourceNode?.data as Partial<ImageFlowNodeData> | undefined;
      const consumeFrom = sourceData?.pickState?.consumeFrom;
      const isVideoErasePickMode = consumeFrom === 'videoErase';
      const videoEraseTool = sourceData?.pickState?.eraseMaskTool ?? 'selection';
      if (isVideoErasePickMode) {
        if (node.type !== imageEditorVideoNodeType) return;
        if (videoEraseTool !== 'selection') return;
      } else if (node.type !== imageEditorImageNodeType) {
        return;
      }
      const isMentionPickMode = consumeFrom === 'quickEditMention' || consumeFrom === 'chatRecordPanelMention';
      if (isMentionPickMode) {
        if (node.id === agentCanvasPickEditingNodeId) return;
        const alreadyLinked = edges.some((edge) => edge.source === node.id && edge.target === agentCanvasPickEditingNodeId);
        if (alreadyLinked) return;
      }
      const targetEl = e.target as HTMLElement | null;
      const hitViewport = isVideoErasePickMode
        ? Boolean(targetEl?.closest(`[data-agent-video-viewport="${node.id}"]`))
        : Boolean(targetEl?.closest(`[data-agent-image-viewport="${node.id}"]`));
      if (!hitViewport) return;
      const d = node.data as ImageFlowNodeData | undefined;
      const legacy = (node.data as unknown as { src?: string } | undefined)?.src;
      const imageSrc = String(d?.content ?? legacy ?? '');
      if (!imageSrc) return;
      const nameFromUrl = imageSrc.split('/').pop()?.split('?')[0] || (isVideoErasePickMode ? 'video' : 'image');
      const overlayAnchor = getAgentImagePickOverlayAnchorFromClick(e, node.id);
      const composerFocused = Boolean(sourceData?.pickState?.composerFocused);
      if (!composerFocused && consumeFrom !== 'videoErase') return;
      const prevPendingList = sourceData?.pickState?.pendingList ?? [];
      const placeholderId = nanoid();
      if (consumeFrom !== 'videoErase') {
        captureCanvasPickCaretRange(placeholderId, agentCanvasPickEditingNodeId);
      }
      const nextPending = {
        targetNodeId: node.id,
        placeholderId,
        content: imageSrc,
        name: nameFromUrl,
        ...(overlayAnchor ? { overlayAnchor } : {}),
      };
      updateNode(agentCanvasPickEditingNodeId, {
        data: {
          pickState: {
            pendingList: consumeFrom === 'videoErase' ? [nextPending] : [...prevPendingList, nextPending],
            ...(consumeFrom === 'videoErase' ? { resultBoxes: null } : {}),
          },
        },
      });
      return;
    }

    if (node.type !== imageEditorImageNodeType) return;
    const d = node.data as ImageFlowNodeData | undefined;
    const legacy = (node.data as unknown as { src?: string } | undefined)?.src;
    const imageSrc = String(d?.content ?? legacy ?? '');
    if (!imageSrc) return;

    const stitchNode = nodes.find((n) => {
      if (n.type !== 'stitchPlaceholderNode') return false;
      if (n.selected) return true;
      const stitchData = (n.data ?? {}) as { selectedCellIndex?: number | null };
      return stitchData.selectedCellIndex != null;
    });
    if (!stitchNode) return;

    const stitchData = (stitchNode.data ?? {}) as {
      selectedCellIndex?: number | null;
      cellImages?: Record<string, string>;
    };
    const targetIndex = stitchData.selectedCellIndex;
    if (targetIndex == null) return;
    const nextCellImages = {
      ...(stitchData.cellImages ?? {}),
      [String(targetIndex)]: imageSrc,
    };
    updateNode(stitchNode.id, { selected: true, data: { cellImages: nextCellImages } });
  };

  const handlePaneClick = (e: MouseEvent | React.MouseEvent) => {
    closeContextMenu();
    const p = screenToFlowPosition({ x: e.clientX, y: e.clientY });
    if (activeTool === 'crop') {
      const gridNode: Node = {
        id: `grid-flow-${nanoid(12)}`,
        type: 'stitchPlaceholderNode',
        position: {
          x: p.x - stitchPlaceholderDefaultWidth / 2,
          y: p.y - stitchPlaceholderDefaultHeight / 2,
        },
        selected: true,
        style: { width: stitchPlaceholderDefaultWidth, height: stitchPlaceholderDefaultHeight },
        data: { rows: stitchPlaceholderDefaultRows, cols: stitchPlaceholderDefaultCols },
      };
      onNodesChange([{ type: 'add', item: gridNode }]);
      console.warn('[ImageEditor] placed stitch placeholder node', gridNode);
      setGridPreviewPos(null);
      setActiveTool('select');
      return;
    }
    if (activeTool === 'blank') {
      const blankNode: Node = {
        id: `blank-flow-${nanoid(12)}`,
        type: 'blankPlaceholderNode',
        position: {
          x: p.x - blankPlaceholderDefaultWidth / 2,
          y: p.y - blankPlaceholderDefaultHeight / 2,
        },
        selected: true,
        style: { width: blankPlaceholderDefaultWidth, height: blankPlaceholderDefaultHeight },
        data: {},
      };
      onNodesChange([{ type: 'add', item: blankNode }]);
      console.warn('[ImageEditor] placed blank placeholder node', blankNode);
      setBlankPreviewPos(null);
      setActiveTool('select');
    }
  };

  const handleToggleMinimap = () => {
    setMinimapOpen((v) => !v);
  };

  const handlePasteFromClipboard = useCallback(async () => {
    try {
      const raw = await navigator.clipboard.readText();
      const parsed = JSON.parse(raw) as { nodes?: Node[]; edges?: Edge[] };
      if (!parsed.nodes?.length) return;

      type PastedNode = Node & {
        parentId?: string;
        parentNode?: string;
        style?: { width?: number; height?: number };
        zIndex?: number;
      };

      const pastedNodes = parsed.nodes as PastedNode[];
      const idMap = new Map<string, string>();
      pastedNodes.forEach((n) => idMap.set(n.id, `image-flow-${nanoid(12)}`));

      const nodeMap = new Map<string, PastedNode>();
      pastedNodes.forEach((n) => nodeMap.set(n.id, n));
      const allNodesBeforePaste = getNodes() as PastedNode[];
      const allNodesById = new Map<string, PastedNode>();
      allNodesBeforePaste.forEach((n) => allNodesById.set(n.id, n));

      const getOriginalAbs = (node: PastedNode): { x: number; y: number } => {
        const rawParentId = node.parentId ?? node.parentNode;
        if (!rawParentId) return { x: node.position.x, y: node.position.y };

        const parentInClipboard = nodeMap.get(rawParentId);
        if (parentInClipboard && parentInClipboard.type === 'group') {
          const style = (parentInClipboard.style ?? {}) as { width?: number; height?: number };
          const w = Number(style.width) || 0;
          const h = Number(style.height) || 0;
          if (w && h) {
            return {
              x: parentInClipboard.position.x + node.position.x,
              y: parentInClipboard.position.y + node.position.y,
            };
          }
        }

        const parentInCanvas = allNodesById.get(rawParentId);
        if (parentInCanvas && parentInCanvas.type === 'group') {
          const style = (parentInCanvas.style ?? {}) as { width?: number; height?: number };
          const w = Number(style.width) || 0;
          const h = Number(style.height) || 0;
          if (w && h) {
            return {
              x: parentInCanvas.position.x + node.position.x,
              y: parentInCanvas.position.y + node.position.y,
            };
          }
        }

        return { x: node.position.x, y: node.position.y };
      };

      const originalAbsById = new Map<string, { x: number; y: number }>();
      pastedNodes.forEach((n) => originalAbsById.set(n.id, getOriginalAbs(n)));

      const pasteOffset = { x: 50, y: 50 };
      const newAbsByOldId = new Map<string, { x: number; y: number }>();
      pastedNodes.forEach((n) => {
        const orig = originalAbsById.get(n.id)!;
        newAbsByOldId.set(n.id, { x: orig.x + pasteOffset.x, y: orig.y + pasteOffset.y });
      });

      const oldIds = new Set(pastedNodes.map((n) => n.id));
      const maxZ = allNodesBeforePaste.reduce((m, n) => Math.max(m, n.zIndex ?? 0), 0);
      const allUnselected = nodes.map((n) => ({ ...n, selected: false }));
      const newNodes = pastedNodes.map((node) => {
        const oldId = node.id;
        const newId = idMap.get(oldId)!;
        const targetAbs = newAbsByOldId.get(oldId)!;
        const rawParentId = node.parentId ?? node.parentNode;

        let nextParentId: string | undefined;
        let positionForFlow = { x: targetAbs.x, y: targetAbs.y };

        if (rawParentId && oldIds.has(rawParentId)) {
          const parentOld = nodeMap.get(rawParentId);
          const parentNewId = idMap.get(rawParentId);
          const parentAbs = newAbsByOldId.get(rawParentId);
          if (parentOld && parentNewId && parentAbs && parentOld.type === 'group') {
            nextParentId = parentNewId;
            positionForFlow = { x: targetAbs.x - parentAbs.x, y: targetAbs.y - parentAbs.y };
          }
        }

        const result: PastedNode = {
          ...node,
          id: newId,
          selected: true,
          position: positionForFlow,
          zIndex: maxZ + 1,
        };

        if (nextParentId) {
          result.parentId = nextParentId;
          result.parentNode = nextParentId;
        } else {
          delete result.parentId;
          delete result.parentNode;
        }
        return result as Node;
      });

      setNodes([...allUnselected, ...newNodes]);

      const pastedEdges: Edge[] = [];
      parsed.edges?.forEach((e) => {
        const source = idMap.get(e.source);
        const target = idMap.get(e.target);
        if (!source || !target) return;
        pastedEdges.push({
          ...e,
          id: `e-${source}-${target}-${Date.now()}-${nanoid(4)}`,
          source,
          target,
          selected: false,
        });
      });
      if (pastedEdges.length) {
        onEdgesChange(pastedEdges.map((e) => ({ type: 'add' as const, item: e })));
      }
    } catch {
      // ignore invalid clipboard content
    }
  }, [getNodes, nodes, onEdgesChange, setNodes]);

  const handleCopySelectionToClipboard = useCallback(async (): Promise<boolean> => {
    const allNodes = getNodes();
    const selectedNodes = allNodes.filter((n) => n.selected);
    const selectedNodeIds = new Set(selectedNodes.map((n) => n.id));
    const selectedEdges = edges.filter(
      (e) => e.selected || (selectedNodeIds.has(e.source) && selectedNodeIds.has(e.target)),
    );
    if (!selectedNodes.length && !selectedEdges.length) return false;
    try {
      await navigator.clipboard.writeText(
        JSON.stringify({
          nodes: selectedNodes,
          edges: selectedEdges,
        }),
      );
      return true;
    } catch {
      return false;
    }
  }, [edges, getNodes]);

  const handleDeleteSelection = useCallback(() => {
    const allNodes = getNodes();
    const selectedNodes = allNodes.filter((n) => n.selected);
    const selectedNodeIds = new Set(selectedNodes.map((n) => n.id));
    const edgeIdsToRemove = new Set<string>();
    for (const edge of edges) {
      if (edge.selected || selectedNodeIds.has(edge.source) || selectedNodeIds.has(edge.target)) {
        edgeIdsToRemove.add(edge.id);
      }
    }

    if (edgeIdsToRemove.size > 0) {
      onEdgesChange(Array.from(edgeIdsToRemove).map((id) => ({ type: 'remove' as const, id })));
    }
    if (selectedNodes.length > 0) {
      onNodesChange(selectedNodes.map((node) => ({ type: 'remove' as const, id: node.id })));
    }
  }, [edges, getNodes, onEdgesChange, onNodesChange]);

  useEffect(() => {
    if (activeTool !== 'crop') setGridPreviewPos(null);
    if (activeTool !== 'blank') setBlankPreviewPos(null);
  }, [activeTool]);

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

  const { yjsUndo, yjsRedo, yjsCanUndo, yjsCanRedo, yjsEnabled, yjsLoading } = useYjsStore({
    id: nodeId,
    enabled: !!nodeId,
  });

  useEffect(() => {
    if (hasBootstrappedFromSourceRef.current) return;
    if (yjsLoading) return;
    if ((nodes?.length ?? 0) > 0) {
      hasBootstrappedFromSourceRef.current = true;
      return;
    }
    const sourceContent = typeof panelCanvasNode?.data?.content === 'string' ? panelCanvasNode.data.content : '';
    if (!sourceContent) {
      hasBootstrappedFromSourceRef.current = true;
      return;
    }
    let sourceName: string = mixedEditorMediaType;
    if (typeof panelCanvasNode?.data?.name === 'string' && panelCanvasNode.data.name.trim()) {
      sourceName = panelCanvasNode.data.name.trim();
    }
    let seededNodeType: Node['type'] = imageEditorImageNodeType;
    if (mixedEditorMediaType === 'video') {
      seededNodeType = imageEditorVideoNodeType;
    } else if (mixedEditorMediaType === 'audio') {
      seededNodeType = imageEditorAudioNodeType;
    }
    let seededNodeData = createEditorImageNodeData(sourceName, sourceContent);
    if (mixedEditorMediaType === 'video') {
      seededNodeData = createEditorVideoNodeData(sourceName, sourceContent);
    } else if (mixedEditorMediaType === 'audio') {
      seededNodeData = createEditorAudioNodeData(sourceName, sourceContent);
    }
    const seededNode: Node = {
      id: `${mixedEditorMediaType}-flow-${nanoid(12)}`,
      type: seededNodeType,
      position: { x: 120, y: 80 },
      selected: true,
      style: mixedEditorMediaType === 'audio' ? { width: 300, height: 250 } : { width: 260, height: 160 },
      data: seededNodeData,
    };
    setNodes([seededNode], { history: 'skip' });
    hasBootstrappedFromSourceRef.current = true;
  }, [mixedEditorMediaType, nodeId, nodes, panelCanvasNode, setNodes, yjsLoading]);

  useEffect(() => {
    const isTypingTarget = (target: EventTarget | null) => {
      if (!(target instanceof HTMLElement)) return false;
      const tag = target.tagName.toLowerCase();
      return tag === 'input' || tag === 'textarea' || target.isContentEditable;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (hotkeysDisabledRef.current) return;
      if (isTypingTarget(event.target)) return;
      const key = event.key.toLowerCase();
      if (key === 'backspace' || key === 'delete') {
        event.preventDefault();
        handleDeleteSelection();
        return;
      }
      if (!(event.ctrlKey || event.metaKey)) return;

      if (key === 'c') {
        event.preventDefault();
        void handleCopySelectionToClipboard();
        return;
      }
      if (key === 'x') {
        event.preventDefault();
        void (async () => {
          const copied = await handleCopySelectionToClipboard();
          if (copied) handleDeleteSelection();
        })();
        return;
      }
      if (key === 'z' && event.shiftKey) {
        event.preventDefault();
        if (yjsCanRedo) yjsRedo();
        return;
      }
      if (key === 'z') {
        event.preventDefault();
        if (yjsCanUndo) yjsUndo();
        return;
      }
      if (key === 'v') {
        event.preventDefault();
        void handlePasteFromClipboard();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleCopySelectionToClipboard, handleDeleteSelection, handlePasteFromClipboard, yjsCanRedo, yjsCanUndo, yjsRedo, yjsUndo]);

  const nodeTypes = useMemo<NodeTypes>(
    () => ({
      [imageEditorImageNodeType]: ImageNode,
      [imageEditorVideoNodeType]: VideoNode,
      [imageEditorAudioNodeType]: AudioNode,
      group: GroupNode,
      stitchPlaceholderNode: StitchPlaceholderNode,
      blankPlaceholderNode: BlankPlaceholderNode,
    }),
    [],
  );

  const flowNodes = useMemo(() => {
    if (agentCanvasPickEditMode && agentCanvasPickEditingNodeId) {
      const mapPickModeNode = (node: Node): Node => {
        const isActivePickSource = node.id === agentCanvasPickEditingNodeId;
        const d = node.data as Partial<ImageFlowNodeData> | undefined;
        const legacy = (node.data as unknown as { src?: string } | undefined)?.src;
        const imageSrc = String(d?.content ?? legacy ?? '');
        const isSelectableImageTarget = node.type === imageEditorImageNodeType && Boolean(imageSrc);
        const sourceNode = nodes.find((n) => n.id === agentCanvasPickEditingNodeId);
        const sourceConsume = (sourceNode?.data as Partial<ImageFlowNodeData> | undefined)?.pickState?.consumeFrom;
        /** Video erase: only the video node is bright; other nodes (incl. pick targets) are dimmed but images stay clickable. */
        const onlySourceBright = sourceConsume === 'videoErase';
        const isHighlighted = onlySourceBright ? isActivePickSource : isActivePickSource || isSelectableImageTarget;
        const isInteractive = onlySourceBright ? isActivePickSource : isActivePickSource || isSelectableImageTarget;
        const pointerEvents: React.CSSProperties['pointerEvents'] = isInteractive ? 'auto' : 'none';
        const cursor: React.CSSProperties['cursor'] = isInteractive
          ? isSelectableImageTarget
            ? 'pointer'
            : 'default'
          : 'not-allowed';
        const pickRing =
          !onlySourceBright && isSelectableImageTarget ? '0 0 0 2px rgba(151, 160, 255, 0.35)' : undefined;
        return {
          ...node,
          selected: isActivePickSource,
          selectable: isActivePickSource,
          draggable: false,
          focusable: isInteractive,
          style: {
            ...(node.style ?? {}),
            pointerEvents,
            cursor,
            opacity: isHighlighted ? 1 : 0.28,
            filter: isHighlighted ? 'none' : 'saturate(0.2) brightness(0.6)',
            transition: 'opacity 160ms ease, filter 160ms ease, box-shadow 200ms ease',
            boxShadow: pickRing ?? (node.style as { boxShadow?: string } | undefined)?.boxShadow,
          },
        };
      };
      return nodes.map(mapPickModeNode);
    }
    if (!stitchEditMode) return nodes;
    return nodes.map((node) => {
      const isActiveStitch = node.id === stitchEditingNodeId;
      const isSelectableImageTarget = node.type === imageEditorImageNodeType;
      const isHighlighted = isActiveStitch || isSelectableImageTarget;
      const pointerEvents: React.CSSProperties['pointerEvents'] = isHighlighted ? 'auto' : 'none';
      const cursor: React.CSSProperties['cursor'] = isHighlighted
        ? (isSelectableImageTarget ? 'pointer' : 'default')
        : 'not-allowed';
      return {
        ...node,
        // In stitch edit mode only the grid node stays selected so other nodes do not show their toolbars.
        selected: isActiveStitch,
        selectable: isActiveStitch,
        draggable: false,
        focusable: isHighlighted,
        style: {
          ...(node.style ?? {}),
          // Dimmed nodes are non-interactive; the canvas container supplies the disabled cursor.
          pointerEvents,
          cursor,
          opacity: isHighlighted ? 1 : 0.28,
          filter: isHighlighted ? 'none' : 'saturate(0.2) brightness(0.6)',
          transition: 'opacity 160ms ease, filter 160ms ease',
          boxShadow: isSelectableImageTarget ? '0 0 0 2px rgba(151, 160, 255, 0.35)' : (node.style as { boxShadow?: string } | undefined)?.boxShadow,
        },
      };
    });
  }, [agentCanvasPickEditMode, agentCanvasPickEditingNodeId, nodes, stitchEditMode, stitchEditingNodeId]);

  return (
    <div
      ref={flowInteractionRootRef}
      className='relative h-full w-full overflow-hidden bg-background-default-secondary'
      style={{ cursor: stitchEditMode ? 'not-allowed' : 'default' }}
      onMouseMoveCapture={handleMouseMoveCapture}
      onMouseLeave={handleMouseLeave}
      onMouseDownCapture={handleMouseDownCapture}
    >
      <SidePanel
        nodeId={nodeId}
        mediaType={mixedEditorMediaType}
        hidden={stitchEditMode}
        activeTool={activeTool}
        setActiveTool={setActiveTool}
        nodes={nodes}
        setNodes={setNodes}
        importImagesFromFiles={importImagesFromFiles}
        importAudiosFromFiles={importAudiosFromFiles}
        importVideosFromFiles={importVideosFromFiles}
        favoriteAssets={favoriteAssets}
        toggleFavoriteAsset={toggleFavoriteAsset}
        flowInteractionRootRef={flowInteractionRootRef}
        screenToFlowPosition={screenToFlowPosition}
      />
      <div id='image-editor-bottom-toolbar-portal' className='pointer-events-none absolute inset-x-0 bottom-6 z-10 flex justify-center' />
      {(stitchEditMode || agentCanvasPickEditMode) && <div className='pointer-events-none absolute inset-0 z-0 bg-black/35' />}
      <StitchModeBanner
        nodes={nodes}
        stitchEditingNodeId={stitchEditingNodeId}
        setStitchEditingNodeId={setStitchEditingNodeId}
        updateNode={updateNode}
      />
      <AgentPickModeBanner
        nodes={nodes}
        agentCanvasPickEditingNodeId={agentCanvasPickEditingNodeId}
        setAgentCanvasPickEditingNodeId={setAgentCanvasPickEditingNodeId}
        updateNode={updateNode}
      />
      <ReactFlow
        className='relative z-[1] origin-[0px_0px] backface-hidden antialiased'
        nodes={flowNodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onNodeDragStop={onNodeDragStop}
        onEdgesChange={onEdgesChange}
        onNodeContextMenu={handleNodeContextMenu}
        onNodeClick={handleNodeClick}
        onPaneContextMenu={handlePaneContextMenu}
        onPaneClick={handlePaneClick}
        nodeTypes={nodeTypes}
        defaultViewport={{ x: 0, y: 0, zoom: 0.5 }}
        minZoom={0.2}
        maxZoom={2}
        panOnDrag={[1]}
        panOnScroll={flowWheelPanAndPinchEnabled}
        zoomOnScroll={false}
        zoomOnPinch={flowWheelPanAndPinchEnabled}
        selectionOnDrag={!stitchEditMode && !agentCanvasPickEditMode}
        selectNodesOnDrag={false}
        elevateNodesOnSelect={false}
        disableKeyboardA11y
        zoomOnDoubleClick={false}
        onlyRenderVisibleElements
        style={{ contain: 'layout style paint' }}
        proOptions={{ hideAttribution: true }}
      >
        {minimapOpen && <MiniMap position='bottom-right' />}
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
        <GroupToolbarPanel />
      </ReactFlow>
      {yjsEnabled && (
        <UndoRedoToolbar
          yjsUndo={yjsUndo}
          yjsRedo={yjsRedo}
          yjsCanUndo={yjsCanUndo}
          yjsCanRedo={yjsCanRedo}
          minimapOpen={minimapOpen}
          onToggleMinimap={handleToggleMinimap}
          className='right-3 bottom-3 left-auto z-20'
        />
      )}
      <NodeContextMenu
        open={!!contextMenu}
        left={contextMenu?.left ?? 0}
        top={contextMenu?.top ?? 0}
        contextNodeId={contextMenu?.contextNodeId ?? null}
        clientX={contextMenu?.clientX ?? 0}
        clientY={contextMenu?.clientY ?? 0}
        onClose={closeContextMenu}
        yjsUndo={yjsEnabled ? yjsUndo : undefined}
        yjsRedo={yjsEnabled ? yjsRedo : undefined}
        yjsCanUndo={yjsEnabled && yjsCanUndo}
        yjsCanRedo={yjsEnabled && yjsCanRedo}
      />

      {activeTool === 'crop' && gridPreviewPos && (
        <div
          className='pointer-events-none fixed z-20'
          style={{
            left: gridPreviewPos.x,
            top: gridPreviewPos.y,
            width: stitchPlaceholderDefaultWidth * previewZoom,
            height: stitchPlaceholderDefaultHeight * previewZoom,
            transform: 'translate(-50%, -50%)',
            opacity: 0.7,
          }}
        >
          <StitchPlaceholderPanel rows={stitchPlaceholderDefaultRows} cols={stitchPlaceholderDefaultCols} />
        </div>
      )}
      {activeTool === 'blank' && blankPreviewPos && (
        <div
          className='pointer-events-none fixed z-20'
          style={{
            left: blankPreviewPos.x,
            top: blankPreviewPos.y,
            width: blankPlaceholderDefaultWidth * previewZoom,
            height: blankPlaceholderDefaultHeight * previewZoom,
            transform: 'translate(-50%, -50%)',
            opacity: 0.7,
          }}
        >
          <BlankPlaceholderPanel />
        </div>
      )}

      {yjsLoading && (
        <div className='absolute inset-0 z-30'>
          <Loading inline width='100%' height='100%' text='Loading...' />
        </div>
      )}

      {(nodes?.length ?? 0) === 0 && <EmptyState />}
    </div>
  );
};

export type EditorProps = {
  nodeId: string;
  hotkeysDisabled?: boolean;
};

const Editor: React.FC<EditorProps> = ({ nodeId, hotkeysDisabled }) => (
  <ReactFlowProvider>
    <EditorInner nodeId={nodeId} hotkeysDisabled={hotkeysDisabled} />
  </ReactFlowProvider>
);

export default Editor;
