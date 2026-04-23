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
  type NodeChange,
  type NodeTypes,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useMixedEditorData } from '@/contexts/MixedEditorDataContext';
import { useMixedEditorActions } from '@/hooks/useMixedEditorActions';
import { useMixedEditorUI } from '@/hooks/useMixedEditorUI';
import { useCanvasData } from '@/contexts/CanvasDataContext';
import { useCanvasUI } from '@/hooks/useCanvasUI';
import { useUpstreamExternalFileList, type UpstreamExternalFileItem } from '@/hooks/useUpstreamExternalFileList';
import type { AgentComposerUploadItem } from '@/components/base/agent/AgentComposerTabs';
import { getProjectCanvasViewportApi, type CanvasWorkflowNodeData } from '@/apps/project/components/canvas/types';
import { message } from '@/components/base/message';
import Loading from '@/components/loading';
import EmptyState from './ui/EmptyState';
import RightToolbar from './ui/RightToolbar';
import UndoRedoToolbar from '../canvas/common/UndoRedoToolbar';
import ImageNode from './node/imageNode/ImageNode';
import VideoNode from './node/videoNode/videoNode';
import AudioNode from './node/audioNode';
import GroupNode from './common/GroupNode';
import StitchPlaceholderNode from './node/imageNode/stitch/StitchPlaceholderNode';
import {
  StitchPlaceholderPanel,
  stitchPlaceholderDefaultCols,
  stitchPlaceholderDefaultHeight,
  stitchPlaceholderDefaultRows,
  stitchPlaceholderDefaultWidth,
} from './node/imageNode/stitch/StitchPlaceholderPanel';
import BlankPlaceholderNode from './node/imageNode/blank/BlankPlaceholderNode';
import {
  BlankPlaceholderPanel,
  blankPlaceholderDefaultHeight,
  blankPlaceholderDefaultWidth,
} from './node/imageNode/blank/BlankPlaceholderPanel';
import GroupToolbarPanel from './common/GroupToolbarPanel';
import NodeContextMenu from './common/NodeContextMenu';
import {
  createEditorAudioNodeData,
  createEditorImageNodeData,
  createEditorVideoNodeData,
  imageEditorAudioNodeType,
  imageEditorImageNodeType,
  imageEditorVideoNodeType,
  type ImageEditorRightSidePanelId,
  type ImageFlowNodeData,
} from './types';
import { captureCanvasPickCaretRange } from '@/components/base/agent/AgentInput';
import type { MediaResourceListItem } from './ui/MediaResourceListPanel';

/** Default tile size when placing a resource onto the image editor flow (see `ImageNode` defaults). */
const imageEditorPlaceNodeWidth = 260;
const imageEditorPlaceNodeHeight = 160;
/** Match `useMixedEditorActions` defaults for pasted / side-panel audio tiles. */
const audioEditorPlaceNodeWidth = 300;
const audioEditorPlaceNodeHeight = 250;

type EditorFlowMediaKind = 'image' | 'video' | 'audio';

/** Side-panel filters, history node type, and centered-place defaults per canvas workflow kind. */
function editorFlowKindConfig(kind: EditorFlowMediaKind) {
  switch (kind) {
    case 'video':
      return {
        historyNodeType: imageEditorVideoNodeType,
        attachMediaType: 'video' as const,
        emptyAddWarning: 'Nothing to add to the video editor',
        placeWidth: imageEditorPlaceNodeWidth,
        placeHeight: imageEditorPlaceNodeHeight,
        flowPrefix: 'video-flow',
        flowNodeType: imageEditorVideoNodeType,
        defaultAssetName: 'video',
        createNodeData: createEditorVideoNodeData,
      };
    case 'audio':
      return {
        historyNodeType: imageEditorAudioNodeType,
        attachMediaType: 'audio' as const,
        emptyAddWarning: 'Nothing to add to the audio editor',
        placeWidth: audioEditorPlaceNodeWidth,
        placeHeight: audioEditorPlaceNodeHeight,
        flowPrefix: 'audio-flow',
        flowNodeType: imageEditorAudioNodeType,
        defaultAssetName: 'audio',
        createNodeData: createEditorAudioNodeData,
      };
    default:
      return {
        historyNodeType: imageEditorImageNodeType,
        attachMediaType: 'image' as const,
        emptyAddWarning: 'Nothing to add to the image editor',
        placeWidth: imageEditorPlaceNodeWidth,
        placeHeight: imageEditorPlaceNodeHeight,
        flowPrefix: 'image-flow',
        flowNodeType: imageEditorImageNodeType,
        defaultAssetName: 'image',
        createNodeData: createEditorImageNodeData,
      };
  }
}

/**
 * Whether a side-panel row can become a `2002` image tile.
 *
 * @param item - Row from a side panel list (image-only)
 * @returns True when the editor can place this resource
 */
function canPlaceMediaItemOnEditorFlow(_editorKind: 'image' | 'video' | 'audio', item: MediaResourceListItem): boolean {
  return Boolean(item.previewUrl?.trim());
}

function canvasImageAttachToListItem(item: AgentComposerUploadItem): MediaResourceListItem {
  return {
    id: item.id,
    previewUrl: item.previewUrl ?? '',
    name: item.name,
  };
}

function canvasUpstreamImageToListItem(item: UpstreamExternalFileItem): MediaResourceListItem {
  return {
    id: item.uid,
    previewUrl: item.content ?? '',
    name: item.name,
  };
}

type ImageEditorInnerProps = {
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

const ImageEditorInner: React.FC<ImageEditorInnerProps> = ({ nodeId, hotkeysDisabled = false }) => {
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
  const { nodes: projectNodes, edges: projectEdges } = useCanvasData();
  const { workflowId } = useCanvasUI();
  /** Main workflow canvas node id for this editor panel (see `project/index.tsx` `panelNode.id`). */
  const projectCanvasTargetNodeId = nodeId;
  const projectCanvasUpstream = useUpstreamExternalFileList(
    projectNodes,
    projectEdges,
    projectCanvasTargetNodeId,
  );

  // Data read — comes from MixedEditorDataProvider (installed in
  // apps/project/index.tsx at project level). Nodes live in the
  // per-node Yjs editor doc, observed into React state via context.
  const { nodes, edges, loading: yjsLoading, applyLocalNodeChanges } = useMixedEditorData();
  const {
    setNodes,
    onNodesChange,
    onEdgesChange,
    updateNode,
    importImagesFromFiles,
    importVideosFromFiles,
    importAudiosFromFiles,
    undo: yjsUndo,
    redo: yjsRedo,
    canUndo: yjsCanUndo,
    canRedo: yjsCanRedo,
  } = useMixedEditorActions();
  const {
    activeTool,
    setActiveTool,
    expandViewportLocked,
    favoriteAssets,
    toggleFavoriteAsset,
  } = useMixedEditorUI();
  /** `true` when this editor's Yjs doc has completed its initial sync. */
  const yjsEnabled = !yjsLoading;
  const flowInteractionRootRef = useRef<HTMLDivElement>(null);
  const { getIntersectingNodes, getNodes, screenToFlowPosition, getZoom } = useReactFlow();

  const projectCanvasWorkflowNodeType = useMemo(() => {
    const canvasNode = projectNodes.find((n) => n.id === projectCanvasTargetNodeId);
    return String(canvasNode?.type ?? '');
  }, [projectNodes, projectCanvasTargetNodeId]);

  const editorFlowMediaKind = useMemo((): 'image' | 'video' | 'audio' => {
    if (projectCanvasWorkflowNodeType === '1003') return 'video';
    if (projectCanvasWorkflowNodeType === '1004') return 'audio';
    return 'image';
  }, [projectCanvasWorkflowNodeType]);

  const rightToolbarUploadAccept = editorFlowMediaKind === 'video' ? 'video/*' : editorFlowMediaKind === 'audio' ? 'audio/*' : 'image/*';
  const closeContextMenu = () => setContextMenu(null);
  /**
   * Match `canvas/index.tsx`: `panOnScroll` + `zoomOnPinch` (no `zoomOnScroll`).
   * Disabled only while Expand locks the viewport; not tied to sidebar tool.
   */
  const flowWheelPanAndPinchEnabled = !expandViewportLocked;
  const previewZoom = getZoom();
  const activeStitchNode = useMemo(
    () => (stitchEditingNodeId ? nodes.find((n) => n.id === stitchEditingNodeId && n.type === 'stitchPlaceholderNode') ?? null : null),
    [nodes, stitchEditingNodeId],
  );
  const stitchEditMode = activeStitchNode != null;

  useEffect(() => {
    const source = nodes.find(
      (n) => (n.data as Partial<ImageFlowNodeData> | undefined)?.pickState?.fromCanvas === true,
    );
    if (source && agentCanvasPickEditingNodeId !== source.id) {
      setAgentCanvasPickEditingNodeId(source.id);
      return;
    }
    if (!agentCanvasPickEditingNodeId) return;
    const editing = nodes.find((n) => n.id === agentCanvasPickEditingNodeId);
    const stillPicking =
      editing &&
      (editing.data as Partial<ImageFlowNodeData> | undefined)?.pickState?.fromCanvas === true;
    if (!stillPicking) {
      setAgentCanvasPickEditingNodeId(null);
    }
  }, [nodes, agentCanvasPickEditingNodeId]);

  const agentCanvasPickEditMode = agentCanvasPickEditingNodeId != null;

  const exitAgentCanvasPickMode = useCallback(() => {
    if (!agentCanvasPickEditingNodeId) return;
    const list = nodes;
    updateNode(agentCanvasPickEditingNodeId, { data: { pickState: null } }, { history: 'skip' });
    for (const n of list) {
      const boxes = (n.data as Partial<ImageFlowNodeData> | undefined)?.pickState?.resultBoxes;
      if (boxes?.length) {
        updateNode(n.id, { data: { pickState: null } }, { history: 'skip' });
      }
    }
  }, [agentCanvasPickEditingNodeId, nodes, updateNode]);

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

  const handleUpload = useCallback(
    (file: File) => {
      const el = flowInteractionRootRef.current;
      const runImport = () => {
        if (editorFlowMediaKind === 'video') {
          void importVideosFromFiles([file]);
        } else if (editorFlowMediaKind === 'audio') {
          void importAudiosFromFiles([file]);
        } else {
          void importImagesFromFiles([file]);
        }
      };
      if (!el) {
        runImport();
        return;
      }
      const rect = el.getBoundingClientRect();
      const viewportCenterFlow = screenToFlowPosition({
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
      });
      if (editorFlowMediaKind === 'video') {
        void importVideosFromFiles([file], { viewportCenterFlow });
      } else if (editorFlowMediaKind === 'audio') {
        void importAudiosFromFiles([file], { viewportCenterFlow });
      } else {
        void importImagesFromFiles([file], { viewportCenterFlow });
      }
    },
    [editorFlowMediaKind, importAudiosFromFiles, importImagesFromFiles, importVideosFromFiles, screenToFlowPosition],
  );

  const imageEditorSidePanelItems = useMemo((): Partial<
    Record<ImageEditorRightSidePanelId, MediaResourceListItem[]>
  > => {
    const flowCfg = editorFlowKindConfig(editorFlowMediaKind);
    const history: MediaResourceListItem[] = nodes
      .filter((n) => n.type === flowCfg.historyNodeType)
      .map((n) => {
        const d = n.data as ImageFlowNodeData;
        return {
          id: n.id,
          name: d.name,
          previewUrl: d.content,
        };
      });

    const canvasNode = projectNodes.find((n) => n.id === projectCanvasTargetNodeId);
    const canvasData = canvasNode?.data as Partial<CanvasWorkflowNodeData> | undefined;
    const rawAttach = canvasData?.attach;
    const canvasAttach = (Array.isArray(rawAttach) ? rawAttach : []) as AgentComposerUploadItem[];
    const canvasTypedAttach = canvasAttach.filter((u) => u.type === flowCfg.attachMediaType);
    const upstreamTyped = projectCanvasUpstream.filter((u) => u.type === flowCfg.attachMediaType);

    const assets: MediaResourceListItem[] = favoriteAssets.map((f) => ({
      id: f.id,
      previewUrl: f.previewUrl,
      name: f.name,
    }));

    return {
      history,
      assets,
      attach: canvasTypedAttach.map(canvasImageAttachToListItem),
      link: upstreamTyped.map(canvasUpstreamImageToListItem),
    };
  }, [editorFlowMediaKind, nodes, projectCanvasTargetNodeId, projectNodes, projectCanvasUpstream, favoriteAssets]);

  /**
   * Adds a new image tile on this image editor React Flow, centered like {@link handleUpload}.
   */
  const addMediaItemToImageEditorFlowAtCenter = useCallback(
    (item: MediaResourceListItem) => {
      const flowCfg = editorFlowKindConfig(editorFlowMediaKind);
      if (!canPlaceMediaItemOnEditorFlow(editorFlowMediaKind, item)) {
        message.warning(flowCfg.emptyAddWarning);
        return;
      }
      const content = item.previewUrl.trim();
      const el = flowInteractionRootRef.current;
      let viewportCenterFlow: { x: number; y: number };
      if (el) {
        const rect = el.getBoundingClientRect();
        viewportCenterFlow = screenToFlowPosition({
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
        });
      } else {
        viewportCenterFlow = { x: 120, y: 80 };
      }

      const w = flowCfg.placeWidth;
      const h = flowCfg.placeHeight;
      const newId = `${flowCfg.flowPrefix}-${nanoid(12)}`;
      const displayName = item.name?.trim() || flowCfg.defaultAssetName;
      const data = flowCfg.createNodeData(displayName, content);
      const newNode: Node = {
        id: newId,
        type: flowCfg.flowNodeType,
        position: {
          x: viewportCenterFlow.x - w / 2,
          y: viewportCenterFlow.y - h / 2,
        },
        selected: true,
        style: { width: w, height: h },
        data,
      };
      setNodes([...nodes.map((n) => ({ ...n, selected: false })), newNode]);
    },
    [editorFlowMediaKind, nodes, screenToFlowPosition, setNodes],
  );

  const handleSidePanelItemAdd = useCallback(
    (panel: ImageEditorRightSidePanelId, item: MediaResourceListItem) => {
      if (panel === 'history' || panel === 'attach' || panel === 'link' || panel === 'assets') {
        addMediaItemToImageEditorFlowAtCenter(item);
      }
    },
    [addMediaItemToImageEditorFlowAtCenter],
  );

  const isSidePanelItemFavorited = useCallback(
    (panel: ImageEditorRightSidePanelId, item: MediaResourceListItem) => {
      if (panel === 'assets') {
        return favoriteAssets.some((f) => f.id === item.id);
      }
      return favoriteAssets.some(
        (f) => f.sourcePanel === panel && f.sourceItemId === item.id,
      );
    },
    [favoriteAssets],
  );

  const handleSidePanelItemFavoriteClick = useCallback(
    (panel: ImageEditorRightSidePanelId, item: MediaResourceListItem) => {
      toggleFavoriteAsset({ panel, item });
    },
    [toggleFavoriteAsset],
  );

  const handleUpstreamPanelOpen = useCallback(() => {
    const api = getProjectCanvasViewportApi();
    if (!api) return;
    const targetId = projectCanvasTargetNodeId;
    api.centerOnFirstNodeId([targetId], true);
  }, [projectCanvasTargetNodeId]);

  const handleSidePanelItemDownload = useCallback(
    async (panel: ImageEditorRightSidePanelId, item: MediaResourceListItem) => {
      if (panel !== 'history' && panel !== 'attach' && panel !== 'link' && panel !== 'assets') return;
      const url = item.previewUrl;
      if (!url) {
        message.warning('No content to download');
        return;
      }
      try {
        const res = await fetch(url, { mode: 'cors' });
        if (!res.ok) throw new Error(res.statusText);
        const blob = await res.blob();
        const fromUrl = url.split('?')[0].match(/\.([a-z0-9]+)$/i)?.[1];
        const ext = fromUrl && fromUrl.length <= 5 ? fromUrl : 'jpg';
        const base = (item.name ?? `asset-${Date.now()}`).replace(/[<>:"/\\|?*]/g, '_');
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = base.includes('.') ? base : `${base}.${ext}`;
        a.click();
        URL.revokeObjectURL(a.href);
      } catch (err) {
        console.error('Download failed:', err);
        message.warning('Download failed');
      }
    },
    [],
  );

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

  const handleNodeClick = (e: React.MouseEvent, node: Node) => {
    console.warn('[ImageEditor] node click', { id: node.id, type: node.type, data: node.data });
    closeContextMenu();

    if (agentCanvasPickEditingNodeId) {
      const sourceNode = nodes.find((n) => n.id === agentCanvasPickEditingNodeId);
      const sourceData = sourceNode?.data as Partial<ImageFlowNodeData> | undefined;
      const consumeFrom = sourceData?.pickState?.consumeFrom;
      const isVideoErasePickMode = consumeFrom === 'videoErase';
      const videoEraseMaskTool = sourceData?.pickState?.eraseMaskTool;
      const isMentionPickMode = consumeFrom === 'quickEditMention' || consumeFrom === 'chatRecordPanelMention';
      if (isVideoErasePickMode) {
        if (node.type !== imageEditorVideoNodeType || node.id !== agentCanvasPickEditingNodeId) return;
        // Rectangle/circle erase creates pending items in drag-end logic.
        // Guard here to avoid double pending entries (and duplicated "Identifying..." overlays).
        if (videoEraseMaskTool && videoEraseMaskTool !== 'selection') return;
      } else if (node.type !== imageEditorImageNodeType) {
        return;
      }
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
      const mediaSrc = String(d?.content ?? legacy ?? '');
      if (!mediaSrc) return;
      const nameFromUrl = mediaSrc.split('/').pop()?.split('?')[0] || (isVideoErasePickMode ? 'video' : 'image');
      const overlayAnchor = getAgentImagePickOverlayAnchorFromClick(e, node.id);
      const composerFocused = Boolean(sourceData?.pickState?.composerFocused);
      if (!composerFocused) return;
      const prevPendingList = sourceData?.pickState?.pendingList ?? [];
      const placeholderId = nanoid();
      captureCanvasPickCaretRange(placeholderId, agentCanvasPickEditingNodeId);
      const nextPending = {
        targetNodeId: node.id,
        placeholderId,
        content: mediaSrc,
        name: nameFromUrl,
        ...(overlayAnchor ? { overlayAnchor } : {}),
      };
      updateNode(agentCanvasPickEditingNodeId, {
        data: {
          pickState: {
            pendingList: [...prevPendingList, nextPending],
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
      const d = (n.data ?? {}) as { selectedCellIndex?: number | null };
      return d.selectedCellIndex != null;
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

  const exitStitchEditMode = useCallback(() => {
    if (!activeStitchNode) return;
    setStitchEditingNodeId(null);
    updateNode(activeStitchNode.id, { selected: true, data: { selectedCellIndex: null } });
  }, [activeStitchNode, updateNode]);

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

  /**
   * Route ReactFlow node changes into two buckets:
   *   - `select` / `dimensions` → local overlay (UI-only, per-tab, not
   *     shared via Yjs — matches canvas behaviour in `canvas/index.tsx`).
   *   - `position` / `remove`   → Yjs writes (collaborative + undoable).
   *
   * Without this split, controlled-mode ReactFlow never echoes the
   * `selected: true` flag back to our nodes array, so toolbar-visibility
   * predicates that read `node.selected` stay permanently false.
   */
  const handleNodesChange = useCallback(
    (changes: NodeChange[]) => {
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
    [applyLocalNodeChanges, onNodesChange],
  );

  useEffect(() => {
    if (activeTool !== 'crop') setGridPreviewPos(null);
    if (activeTool !== 'blank') setBlankPreviewPos(null);
  }, [activeTool]);

  useEffect(() => {
    const selectedStitchNode = nodes.find((n) => n.type === 'stitchPlaceholderNode' && n.selected);
    const selectedStitchData = (selectedStitchNode?.data ?? {}) as { selectedCellIndex?: number | null };
    const selectedCellIndex = selectedStitchData.selectedCellIndex ?? null;
    if (selectedStitchNode && selectedCellIndex != null && stitchEditingNodeId !== selectedStitchNode.id) {
      setStitchEditingNodeId(selectedStitchNode.id);
      return;
    }
    if (!stitchEditingNodeId) return;
    const editingNode = nodes.find((n) => n.id === stitchEditingNodeId && n.type === 'stitchPlaceholderNode');
    if (!editingNode) {
      setStitchEditingNodeId(null);
      return;
    }
    const editingData = (editingNode.data ?? {}) as { selectedCellIndex?: number | null };
    if (editingData.selectedCellIndex == null) {
      setStitchEditingNodeId(null);
    }
  }, [nodes, stitchEditingNodeId]);

  useEffect(() => {
    if (!stitchEditMode) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      exitStitchEditMode();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [exitStitchEditMode, stitchEditMode]);

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

  // Yjs connection, auth, and undo/redo are owned by the
  // MixedEditorDataProvider installed in apps/project/index.tsx —
  // destructured above via useMixedEditorData / useMixedEditorActions.
  // Nothing else to wire here.

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
        const isHighlighted = isActivePickSource || isSelectableImageTarget;
        const pointerEvents: React.CSSProperties['pointerEvents'] = isHighlighted ? 'auto' : 'none';
        const cursor: React.CSSProperties['cursor'] = isHighlighted
          ? isSelectableImageTarget
            ? 'pointer'
            : 'default'
          : 'not-allowed';
        const pickRing = isSelectableImageTarget ? '0 0 0 2px rgba(151, 160, 255, 0.35)' : undefined;
        return {
          ...node,
          selected: isActivePickSource,
          selectable: isActivePickSource,
          draggable: false,
          focusable: isHighlighted,
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
      {!stitchEditMode && (
        <div className='pointer-events-none absolute inset-y-0 right-3 z-10 flex h-full min-h-0 justify-end'>
          <RightToolbar
            activeTool={activeTool}
            onToolChange={setActiveTool}
            onUpload={handleUpload}
            uploadAccept={rightToolbarUploadAccept}
            sidePanelItems={imageEditorSidePanelItems}
            onSidePanelItemAddClick={handleSidePanelItemAdd}
            onSidePanelItemDownloadClick={handleSidePanelItemDownload}
            isSidePanelItemFavorited={isSidePanelItemFavorited}
            onSidePanelItemFavoriteClick={handleSidePanelItemFavoriteClick}
            onUpstreamPanelOpen={handleUpstreamPanelOpen}
          />
        </div>
      )}
      <div id='image-editor-bottom-toolbar-portal' className='pointer-events-none absolute inset-x-0 bottom-6 z-10 flex justify-center' />
      {(stitchEditMode || agentCanvasPickEditMode) && <div className='pointer-events-none absolute inset-0 z-0 bg-black/35' />}
      {stitchEditMode && (
        <div className='pointer-events-none absolute inset-x-0 top-3 z-20 flex justify-center'>
          <button
            type='button'
            className='pointer-events-auto inline-flex h-9 items-center gap-2 rounded-md border border-white/40 bg-black/50 px-3 text-xs font-medium text-white backdrop-blur-sm hover:bg-black/65'
            onClick={exitStitchEditMode}
          >
            <span>Click here or press</span>
            <span className='rounded border border-white/55 px-1 text-[10px]'>ESC</span>
            <span>to exit</span>
          </button>
        </div>
      )}
      {agentCanvasPickEditMode && (
        <div className='pointer-events-none absolute inset-x-0 top-3 z-20 flex justify-center'>
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
        className='relative z-[1] origin-[0px_0px] backface-hidden antialiased'
        nodes={flowNodes}
        edges={edges}
        onNodesChange={handleNodesChange}
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
        {yjsEnabled && (
          <UndoRedoToolbar
            yjsUndo={yjsUndo}
            yjsRedo={yjsRedo}
            yjsCanUndo={yjsCanUndo}
            yjsCanRedo={yjsCanRedo}
            minimapOpen={minimapOpen}
            onToggleMinimap={handleToggleMinimap}
            className='right-3 bottom-3 left-auto'
          />
        )}
        <GroupToolbarPanel />
      </ReactFlow>
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

export type ImageEditorProps = {
  nodeId: string;
  hotkeysDisabled?: boolean;
};

const ImageEditor: React.FC<ImageEditorProps> = ({ nodeId, hotkeysDisabled }) => (
  <ReactFlowProvider>
    <ImageEditorInner nodeId={nodeId} hotkeysDisabled={hotkeysDisabled} />
  </ReactFlowProvider>
);

export default ImageEditor;
