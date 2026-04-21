import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { NodeResizer, NodeToolbar as FlowNodeToolbar, Position, useReactFlow, type Node, type NodeProps } from '@xyflow/react';
import { nanoid } from 'nanoid';
import Loading from '@/components/loading';
import { message } from '@/components/base/message';
import { Icon } from '@/components/base/icon';
import Video, { type VideoPlaybackSnapshot, type VideoRef } from '@/apps/project/components/canvas/common/Video';
import { useMixedEditorStore } from '@/hooks/useMixedEditorStore';
import { useCanvasData } from '@/contexts/CanvasDataContext';
import { useCanvasActions } from '@/hooks/useCanvasActions';
import { getVideoMetaFromUrl } from '@/utils/mediaUtils';
import { cutVideoWithFfmpeg } from '@/utils/videoCutWithFfmpeg';
import { speedVideoWithFfmpeg } from '@/utils/videoSpeedWithFfmpeg';
import { type CanvasWorkflowNodeData, getProjectCanvasViewportApi } from '@/apps/project/components/canvas/types';
import NodeHeader from '../../common/NodeHeader';
import type { ImageEditorPickResultBox, ImageFlowNodeData } from '../../types';
import { imageEditorVideoNodeType } from '../../types';
import Toolbar, { type VideoInterpolateTarget, type VideoUpscaleTarget } from './Toolbar';
import PlaybackPanel from './playback/PlaybackPanel';
import BottomToolbar from './BottomToolbar';
import CutBottomToolbar from './cut/CutBottomToolbar';
import SpeedBottomToolbar from './speed/SpeedBottomToolbar';
import EraseBottomToolbar from './erase/EraseBottomToolbar';
import TrackedBoxesOverlay from './erase/TrackedBoxesOverlay';
import type { VideoEraseMaskTool } from './erase/EraseBottomToolbar';
import type { EraseTrackingBox, EraseTrackingPhase, EraseTrackingSegment, EraseTrackingStatus } from './erase/EraseTrackingPanel';
import { useVideoEraseInteractions } from './erase/useVideoEraseInteractions';
import type { TimelineCutMarker } from './playback/PlaybackPanel';

const videoFlowMinWidth = 120;
const videoFlowMinHeight = 80;

const canvasWorkflowVideoNodeType = '1003';
const canvasVideoNodeFallbackWidth = 300;
const canvasVideoNodeFallbackHeight = 250;
const newCanvasVideoGap = 40;
const workflowCanvasVideoDefaultWidth = 300;
const workflowCanvasVideoDefaultHeight = 250;
const videoErasePickResultDefault = { wPct: 26, hPct: 26 };
const VIDEO_ERASE_FRAME_MATCH_TOLERANCE_SEC = 0.12;
const TRACKING_TARGET_WINDOW_COUNT = 14;
const TRACKING_MIN_WINDOW_SEC = 0.6;
const TRACKING_MAX_WINDOW_SEC = 3;

const resolveTrackingStatusAtTime = (
  segments: EraseTrackingSegment[],
  currentTimeSec: number,
): EraseTrackingStatus | null => {
  if (segments.length === 0) return null;
  const segment = segments.find((item) => currentTimeSec >= item.startSec && currentTimeSec <= item.endSec);
  return segment?.status ?? segments[segments.length - 1]?.status ?? null;
};

const toTrackingBoxes = (boxes: ImageEditorPickResultBox[]): EraseTrackingBox[] =>
  boxes.map((box) => ({
    cxPct: box.cxPct,
    cyPct: box.cyPct,
    wPct: box.wPct,
    hPct: box.hPct,
    maskShape: box.maskShape,
    placeholderId: box.placeholderId,
  }));

const buildTrackingSegments = (
  durationSec: number,
  anchorSec: number,
  trackedBoxes: EraseTrackingBox[],
): EraseTrackingSegment[] => {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return [];
  const duration = Math.max(0, durationSec);
  const anchor = Math.min(duration, Math.max(0, anchorSec));
  const windowSec = Math.max(
    TRACKING_MIN_WINDOW_SEC,
    Math.min(TRACKING_MAX_WINDOW_SEC, duration / TRACKING_TARGET_WINDOW_COUNT),
  );
  const totalWindows = Math.max(1, Math.ceil(duration / windowSec));
  const segments: EraseTrackingSegment[] = [];
  for (let i = 0; i < totalWindows; i += 1) {
    const start = i * windowSec;
    const end = i === totalWindows - 1 ? duration : Math.min(duration, (i + 1) * windowSec);
    const center = (start + end) / 2;
    const distanceNorm = duration > 0 ? Math.abs(center - anchor) / duration : 0;
    const baseConfidence = 1 - distanceNorm * 1.45;
    const temporalWave = 0.18 * Math.sin(center * 1.7) + 0.1 * Math.cos(center * 0.9 + anchor * 0.5);
    const confidence = Math.min(1, Math.max(0, baseConfidence + temporalWave));
    const status: EraseTrackingStatus = confidence >= 0.66 ? 'confirm' : confidence >= 0.38 ? 'unclear' : 'lost';
    const boxesForSegment = status === 'lost' ? [] : trackedBoxes;
    const prev = segments[segments.length - 1];
    if (prev && prev.status === status) {
      prev.endSec = end;
      if (status !== 'lost') prev.boxes = boxesForSegment;
      continue;
    }
    segments.push({ startSec: start, endSec: end, status, boxes: boxesForSegment });
  }
  return segments;
};

function computeWorkflowCanvasVideoDisplaySize(
  naturalWidth: number,
  naturalHeight: number,
): { width: number; height: number } {
  if (naturalWidth <= 0 || naturalHeight <= 0) {
    return { width: workflowCanvasVideoDefaultWidth, height: workflowCanvasVideoDefaultHeight };
  }
  const isLandscape = naturalWidth >= naturalHeight;
  if (isLandscape) {
    const h = Math.max(
      Math.round(workflowCanvasVideoDefaultWidth * (naturalHeight / naturalWidth)),
      workflowCanvasVideoDefaultHeight,
    );
    const w = Math.round(h * (naturalWidth / naturalHeight));
    return { width: w, height: h };
  }
  return {
    width: workflowCanvasVideoDefaultWidth,
    height: Math.round(workflowCanvasVideoDefaultWidth * (naturalHeight / naturalWidth)),
  };
}

function projectCanvasNodeBounds(n: Node): { left: number; top: number; right: number; bottom: number } {
  const st = (n.style ?? {}) as { width?: number; height?: number };
  const w = typeof st.width === 'number' ? st.width : canvasVideoNodeFallbackWidth;
  const h = typeof st.height === 'number' ? st.height : canvasVideoNodeFallbackHeight;
  return {
    left: n.position.x,
    top: n.position.y,
    right: n.position.x + w,
    bottom: n.position.y + h,
  };
}

function suggestNewProjectCanvasVideoPosition(canvasNodes: Node[]): { x: number; y: number } {
  if (canvasNodes.length === 0) return { x: 120, y: 80 };

  const selected = canvasNodes.filter((n) => n.selected);
  const focusNodes = selected.length > 0 ? selected : canvasNodes;

  let minTop = Infinity;
  let maxRight = -Infinity;
  for (const n of focusNodes) {
    const b = projectCanvasNodeBounds(n);
    minTop = Math.min(minTop, b.top);
    maxRight = Math.max(maxRight, b.right);
  }

  if (selected.length > 0) {
    return { x: maxRight + newCanvasVideoGap, y: minTop };
  }

  let globalMaxRight = -Infinity;
  let globalY = 80;
  for (const n of canvasNodes) {
    const b = projectCanvasNodeBounds(n);
    if (b.right > globalMaxRight) {
      globalMaxRight = b.right;
      globalY = b.top;
    }
  }
  return { x: globalMaxRight + newCanvasVideoGap, y: globalY };
}

function createProjectCanvasVideoNodeFromEditor(params: {
  content: string;
  name: string;
  position: { x: number; y: number };
  width: number;
  height: number;
  zIndex: number;
}): Node {
  const newId = `${canvasWorkflowVideoNodeType}-${Date.now()}-${nanoid(5)}`;
  return {
    id: newId,
    type: canvasWorkflowVideoNodeType,
    position: params.position,
    selected: true,
    zIndex: params.zIndex,
    style: { width: params.width, height: params.height },
    data: {
      name: params.name,
      content: params.content,
      state: 'idle',
      handles: {
        target: [{ handleType: 'Video', number: 0 }],
        source: [{ handleType: 'Video', number: 0 }],
      },
    } satisfies CanvasWorkflowNodeData,
  };
}

function getTrimmedVideoFlowNodeName(data: ImageFlowNodeData, fallback = 'video'): string {
  const raw = data.name;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : fallback;
}

function shouldShowVideoFlowToolbars(params: {
  selected: boolean;
  selectedVideoFlowNodeCount: number;
  dragging: boolean;
  isEditing: boolean;
  hasVideoContent: boolean;
}): boolean {
  return (
    params.selected &&
    params.selectedVideoFlowNodeCount === 1 &&
    !params.dragging &&
    !params.isEditing &&
    params.hasVideoContent
  );
}

const VideoNode: React.FC<NodeProps> = ({ id, data, selected, dragging, width, height }) => {
  const { setCenter } = useReactFlow();
  const {
    createCutVideoResultNodesRight,
    createVideoPlaceholderNodeRight,
    resolveVideoResultNode,
    removeNode,
    updateNode,
    updateNodeData,
    nodes,
  } = useMixedEditorStore();
  const { nodes: projectCanvasNodes } = useCanvasData();
  const { updateNode: updateProjectCanvasNode, addNode: addProjectCanvasNode } = useCanvasActions();
  const nodeData = data as ImageFlowNodeData | undefined;
  const pickResultBoxes = useMemo(
    () => (nodeData?.pickState?.resultBoxes ?? []) as ImageEditorPickResultBox[],
    [nodeData?.pickState?.resultBoxes],
  );
  const videoContent = String(nodeData?.content ?? '');
  const title = nodeData?.name?.trim() || 'video';
  const currentWidth = Math.max(1, Math.round(width ?? videoFlowMinWidth));
  const currentHeight = Math.max(1, Math.round(height ?? videoFlowMinHeight));
  const resolutionText = `${currentWidth}x${currentHeight}`;

  const nodeFrameRef = useRef<HTMLDivElement | null>(null);
  const videoViewportRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<VideoRef | null>(null);
  const [playback, setPlayback] = useState<VideoPlaybackSnapshot>({
    currentTime: 0,
    duration: 0,
    isPlaying: false,
    volume: 1,
  });
  const [editingMode, setEditingMode] = useState<'cut' | 'speed' | 'erase' | null>(null);
  const [eraseMaskTool, setEraseMaskTool] = useState<VideoEraseMaskTool>('selection');
  const [trackingSegments, setTrackingSegments] = useState<EraseTrackingSegment[]>([]);
  const [canEraseUndo, setCanEraseUndo] = useState(false);
  const [canEraseRedo, setCanEraseRedo] = useState(false);
  const [isCutSaving, setIsCutSaving] = useState(false);
  const [isSpeedSaving, setIsSpeedSaving] = useState(false);
  const nodeFromStore = useMemo(() => nodes.find((n: Node) => n.id === id), [nodes, id]);
  const nodesRef = useRef(nodes);
  const playbackTimeRef = useRef(playback.currentTime);
  const prevPlaybackTimeRef = useRef(playback.currentTime);
  const scheduledVideoErasePickIdsRef = useRef(new Set<string>());
  const pendingManualBoxRef = useRef(new Map<string, ImageEditorPickResultBox>());
  const eraseEntryPickStateRef = useRef<ImageFlowNodeData['pickState'] | null>(null);
  const eraseUndoStackRef = useRef<ImageEditorPickResultBox[][]>([]);
  const eraseRedoStackRef = useRef<ImageEditorPickResultBox[][]>([]);

  useEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);

  const updateEraseHistoryFlags = useCallback(() => {
    setCanEraseUndo(eraseUndoStackRef.current.length > 0);
    setCanEraseRedo(eraseRedoStackRef.current.length > 0);
  }, []);

  const resetEraseHistory = useCallback(() => {
    eraseUndoStackRef.current = [];
    eraseRedoStackRef.current = [];
    updateEraseHistoryFlags();
  }, [updateEraseHistoryFlags]);

  const readCurrentResultBoxes = useCallback(() => {
    const source = nodesRef.current.find((n) => n.id === id);
    return ((source?.data as Partial<ImageFlowNodeData> | undefined)?.pickState?.resultBoxes ?? []) as ImageEditorPickResultBox[];
  }, [id]);

  const applyResultBoxes = useCallback(
    (nextBoxes: ImageEditorPickResultBox[], options?: { recordHistory?: boolean }) => {
      const recordHistory = options?.recordHistory !== false;
      const currentBoxes = readCurrentResultBoxes();
      if (recordHistory) {
        eraseUndoStackRef.current.push(currentBoxes);
        eraseRedoStackRef.current = [];
      }
      updateNode(
        id,
        {
          data: {
            pickState: {
              resultBoxes: nextBoxes.length ? nextBoxes : null,
            },
          },
        },
        { history: 'skip' },
      );
      updateEraseHistoryFlags();
    },
    [id, readCurrentResultBoxes, updateEraseHistoryFlags, updateNode],
  );

  const applyResultBoxesTransient = useCallback(
    (nextBoxes: ImageEditorPickResultBox[]) => {
      updateNode(
        id,
        {
          data: {
            pickState: {
              resultBoxes: nextBoxes.length ? nextBoxes : null,
            },
          },
        },
        { history: 'skip' },
      );
    },
    [id, updateNode],
  );

  const startTrackingAnalysis = useCallback(
    (anchorSec: number, sourceBoxes?: ImageEditorPickResultBox[]) => {
      const duration = playback.duration > 0 ? playback.duration : 0;
      const trackedBoxes = toTrackingBoxes(sourceBoxes ?? readCurrentResultBoxes());
      setTrackingSegments(buildTrackingSegments(duration, anchorSec, trackedBoxes));
    },
    [playback.duration, readCurrentResultBoxes],
  );
  const currentTrackingStatus = useMemo(
    () => resolveTrackingStatusAtTime(trackingSegments, playback.currentTime),
    [trackingSegments, playback.currentTime],
  );
  const { draftBox, clearEraseInteractionState, handleTrackedBoxMouseDown, handleTrackedBoxResizeHandleMouseDown, handleVideoViewportMouseDown } =
    useVideoEraseInteractions({
      id,
      editingMode,
      eraseMaskTool,
      currentTrackingStatus,
      nodeFromStoreData: (nodeFromStore?.data as Partial<ImageFlowNodeData> | undefined),
      playbackCurrentTime: playback.currentTime,
      videoViewportRef,
      nodesRef,
      playbackTimeRef,
      prevPlaybackTimeRef,
      scheduledVideoErasePickIdsRef,
      pendingManualBoxRef,
      videoErasePickResultDefault,
      readCurrentResultBoxes,
      applyResultBoxes,
      applyResultBoxesTransient,
      startTrackingAnalysis,
      setTrackingSegments,
      updateNode,
    });

  const requestTrackingReselect = useCallback(() => {
    pendingManualBoxRef.current.clear();
    updateNode(
      id,
      {
        selected: true,
        data: {
          pickState: {
            fromCanvas: true,
            composerFocused: true,
            consumeFrom: 'videoErase',
            eraseMaskTool: 'selection',
            pendingList: null,
            resultBoxes: null,
          },
        },
      },
      { history: 'skip' },
    );
    setEraseMaskTool('selection');
    clearEraseInteractionState();
    setTrackingSegments([]);
    resetEraseHistory();
  }, [clearEraseInteractionState, id, resetEraseHistory, updateNode]);

  const handleEraseUndo = useCallback(() => {
    if (eraseUndoStackRef.current.length === 0) return;
    const currentBoxes = readCurrentResultBoxes();
    const prevBoxes = eraseUndoStackRef.current.pop() ?? [];
    eraseRedoStackRef.current.push(currentBoxes);
    updateNode(
      id,
      {
        data: {
          pickState: {
            resultBoxes: prevBoxes.length ? prevBoxes : null,
          },
        },
      },
      { history: 'skip' },
    );
    updateEraseHistoryFlags();
  }, [id, readCurrentResultBoxes, updateEraseHistoryFlags, updateNode]);

  const handleEraseRedo = useCallback(() => {
    if (eraseRedoStackRef.current.length === 0) return;
    const currentBoxes = readCurrentResultBoxes();
    const nextBoxes = eraseRedoStackRef.current.pop() ?? [];
    eraseUndoStackRef.current.push(currentBoxes);
    updateNode(
      id,
      {
        data: {
          pickState: {
            resultBoxes: nextBoxes.length ? nextBoxes : null,
          },
        },
      },
      { history: 'skip' },
    );
    updateEraseHistoryFlags();
  }, [id, readCurrentResultBoxes, updateEraseHistoryFlags, updateNode]);

  useEffect(() => {
    playbackTimeRef.current = playback.currentTime;
  }, [playback.currentTime]);

  const quickEditPickPendingListForThis = useMemo(() => {
    return nodes.reduce<NonNullable<NonNullable<ImageFlowNodeData['pickState']>['pending']>[]>((acc, n) => {
      const ps = (n.data as Partial<ImageFlowNodeData> | undefined)?.pickState;
      const fromList = (ps?.pendingList ?? []).filter((item) => item.targetNodeId === id);
      if (fromList.length > 0) {
        acc.push(...fromList);
      }
      return acc;
    }, []);
  }, [id, nodes]);

  const visiblePickResultBoxes = useMemo(() => {
    const frameAlignedBoxes = pickResultBoxes.filter((box) => {
      if (typeof box.frameTimeSec !== 'number') return true;
      return Math.abs(box.frameTimeSec - playback.currentTime) <= VIDEO_ERASE_FRAME_MATCH_TOLERANCE_SEC;
    });
    if (frameAlignedBoxes.length > 0) return frameAlignedBoxes;
    if (editingMode !== 'erase') return [];
    const activeTrackingSegment =
      trackingSegments.find((item) => playback.currentTime >= item.startSec && playback.currentTime <= item.endSec) ??
      trackingSegments[trackingSegments.length - 1];
    return (activeTrackingSegment?.boxes ?? []).map((box) => ({
      cxPct: box.cxPct,
      cyPct: box.cyPct,
      wPct: box.wPct,
      hPct: box.hPct,
      maskShape: box.maskShape,
      placeholderId: box.placeholderId,
    }));
  }, [editingMode, pickResultBoxes, playback.currentTime, trackingSegments]);
  /** Match "Identifying..." overlay: pending pick has no segments yet, but panel should show Tracking... */
  const trackingPhase: EraseTrackingPhase =
    trackingSegments.length > 0 || quickEditPickPendingListForThis.length > 0 ? 'tracking' : 'idle';
  const handlePlaybackUpdate = useCallback((snapshot: VideoPlaybackSnapshot) => {
    setPlayback(snapshot);
  }, []);

  const selectedVideoCount = useMemo(
    () => nodes.filter((n: Node) => n.selected && n.type === imageEditorVideoNodeType).length,
    [nodes],
  );

  const hasProjectCanvasVideoSelection = useMemo(
    () => projectCanvasNodes.some((n) => n.selected && n.type === canvasWorkflowVideoNodeType),
    [projectCanvasNodes],
  );

  const showToolbars = shouldShowVideoFlowToolbars({
    selected,
    selectedVideoFlowNodeCount: selectedVideoCount,
    dragging,
    isEditing: editingMode !== null,
    hasVideoContent: Boolean(videoContent),
  });

  const syncPlaybackFromVideo = selected && Boolean(videoContent);

  const focusCurrentNode = useCallback(
    (zoom = 1) => {
      const p = nodeFromStore?.position;
      if (!p) return;
      setCenter(p.x + currentWidth / 2, p.y + currentHeight / 2, { zoom, duration: 220 });
    },
    [currentHeight, currentWidth, nodeFromStore?.position, setCenter],
  );

  const handleCutOpen = useCallback(() => {
    if (!videoContent || editingMode === 'cut') return;
    focusCurrentNode();
    setEditingMode('cut');
  }, [editingMode, focusCurrentNode, videoContent]);

  const handleSpeedOpen = useCallback(() => {
    if (!videoContent || editingMode === 'speed') return;
    focusCurrentNode();
    setEditingMode('speed');
  }, [editingMode, focusCurrentNode, videoContent]);

  const handleEraseOpen = useCallback(() => {
    if (!videoContent || editingMode === 'erase') return;
    focusCurrentNode();
    eraseEntryPickStateRef.current = (((nodeFromStore?.data as Partial<ImageFlowNodeData> | undefined)?.pickState ?? null) as
      | ImageFlowNodeData['pickState']
      | null);
    updateNode(id, { data: { pickState: null } }, { history: 'skip' });
    pendingManualBoxRef.current.clear();
    setEraseMaskTool('selection');
    clearEraseInteractionState();
    setTrackingSegments([]);
    resetEraseHistory();
    setEditingMode('erase');
  }, [clearEraseInteractionState, editingMode, focusCurrentNode, id, nodeFromStore?.data, resetEraseHistory, updateNode, videoContent]);

  const handleUpscale = useCallback((_nodeId: string, _target: VideoUpscaleTarget) => {
    message.warning('Upscale coming soon');
  }, []);

  const handleInterpolate = useCallback((_nodeId: string, _target: VideoInterpolateTarget) => {
    message.warning('Interpolate coming soon');
  }, []);

  const handleCutClose = useCallback(() => {
    if (editingMode !== 'cut') return;
    setEditingMode(null);
  }, [editingMode]);

  const handleSpeedClose = useCallback(() => {
    if (editingMode !== 'speed') return;
    setEditingMode(null);
  }, [editingMode]);

  const handleEraseClose = useCallback(() => {
    if (editingMode !== 'erase') return;
    updateNode(
      id,
      {
        data: {
          pickState: eraseEntryPickStateRef.current ?? null,
        },
      },
      { history: 'skip' },
    );
    eraseEntryPickStateRef.current = null;
    pendingManualBoxRef.current.clear();
    clearEraseInteractionState();
    setTrackingSegments([]);
    resetEraseHistory();
    setEditingMode(null);
  }, [clearEraseInteractionState, editingMode, id, resetEraseHistory, updateNode]);

  const handleEraseSend = useCallback((_payload: { maskTool: VideoEraseMaskTool }) => {
    message.warning('Erase coming soon');
  }, []);

  const handleEraseMaskToolChange = useCallback((tool: VideoEraseMaskTool) => {
    setEraseMaskTool(tool);
    if (tool === 'selection') {
      setTrackingSegments([]);
    }
  }, []);

  const handleCutSave = useCallback(
    async (payload: { cutMarkers: TimelineCutMarker[]; segments: Array<{ start: number; end: number }> }) => {
      if (!videoContent || isCutSaving) return;
      setIsCutSaving(true);
      try {
        const clipSources = await cutVideoWithFfmpeg(videoContent, payload.segments);
        if (clipSources.length === 0) return;
        createCutVideoResultNodesRight(id, payload, clipSources, 200);
        setEditingMode(null);
      } catch {
        return;
      } finally {
        setIsCutSaving(false);
      }
    },
    [createCutVideoResultNodesRight, id, isCutSaving, videoContent],
  );

  const handleSpeedSave = useCallback(
    async (payload: { playbackRate: number }) => {
      if (!videoContent || isSpeedSaving) return;
      const placeholderId = createVideoPlaceholderNodeRight(id, { nameSuffix: 'speed', state: 'generating' });
      if (!placeholderId) return;
      setEditingMode(null);
      setIsSpeedSaving(true);
      try {
        const speedSrc = await speedVideoWithFfmpeg(videoContent, payload.playbackRate);
        if (!speedSrc) {
          removeNode(placeholderId);
          return;
        }
        resolveVideoResultNode(placeholderId, speedSrc, { state: 'idle' });
      } catch {
        removeNode(placeholderId);
        return;
      } finally {
        setIsSpeedSaving(false);
      }
    },
    [createVideoPlaceholderNodeRight, id, isSpeedSaving, removeNode, resolveVideoResultNode, videoContent],
  );

  const handleCreateNewCanvasVideoNode = useCallback(() => {
    if (!videoContent) return;
    void (async () => {
      let displayW = Math.max(1, Math.round(currentWidth));
      let displayH = Math.max(1, Math.round(currentHeight));
      try {
        const meta = await getVideoMetaFromUrl(videoContent);
        const nw = meta.width ?? 0;
        const nh = meta.height ?? 0;
        if (nw > 0 && nh > 0) {
          const d = computeWorkflowCanvasVideoDisplaySize(nw, nh);
          displayW = d.width;
          displayH = d.height;
        }
      } catch {
        // decode / CORS: keep editor tile size
      }
      const viewportApi = getProjectCanvasViewportApi();
      const center = viewportApi?.getViewportCenterFlow();
      const position =
        center != null
          ? { x: center.x - displayW / 2, y: center.y - displayH / 2 }
          : suggestNewProjectCanvasVideoPosition(projectCanvasNodes);
      const maxZ = projectCanvasNodes.reduce(
        (m, n) => Math.max(m, (n as Node & { zIndex?: number }).zIndex ?? 0),
        0,
      );
      const newNode = createProjectCanvasVideoNodeFromEditor({
        content: videoContent,
        name: getTrimmedVideoFlowNodeName(nodeData ?? { name: title, content: '', state: 'idle', nodeRuntimeData: {} }),
        position,
        width: displayW,
        height: displayH,
        zIndex: maxZ + 1,
      });
      addProjectCanvasNode(newNode, { select: true });
    })();
  }, [addProjectCanvasNode, currentHeight, currentWidth, nodeData, projectCanvasNodes, title, videoContent]);

  const handleAddToNodeClick = () => {
    if (!videoContent || !hasProjectCanvasVideoSelection) return;
    const targets = projectCanvasNodes.filter(
      (n) => n.selected && n.type === canvasWorkflowVideoNodeType,
    );
    const sourceName = getTrimmedVideoFlowNodeName(nodeData ?? { name: title, content: '', state: 'idle', nodeRuntimeData: {} });
    for (const target of targets) {
      updateProjectCanvasNode(target.id, {
        data: {
          content: videoContent,
          name: sourceName,
          state: 'idle',
          nodeSelectedResultData: null,
          pickState: null,
        } as Partial<CanvasWorkflowNodeData>,
      });
    }
  };

  return (
    <>
      <FlowNodeToolbar isVisible={showToolbars} position={Position.Top} offset={50} align='center'>
        <Toolbar
          nodeId={id}
          onCut={handleCutOpen}
          onSpeed={handleSpeedOpen}
          onUpscale={handleUpscale}
          onInterpolate={handleInterpolate}
          onErase={handleEraseOpen}
        />
      </FlowNodeToolbar>
      <FlowNodeToolbar isVisible={showToolbars} position={Position.Bottom} offset={12} align='center'>
        <div className='flex flex-col items-center gap-1' onMouseDown={(e) => e.stopPropagation()}>
          <PlaybackPanel
            videoRef={videoRef}
            mediaSrc={videoContent}
            currentTime={playback.currentTime}
            duration={playback.duration}
            isPlaying={playback.isPlaying}
            volume={playback.volume}
            fullscreenTargetRef={nodeFrameRef}
          />
          <BottomToolbar
            videoSrc={videoContent}
            onAddToNodeClick={handleAddToNodeClick}
            onCreateNewNodeClick={handleCreateNewCanvasVideoNode}
            disableAddToNode={!videoContent || !hasProjectCanvasVideoSelection}
            disableCreateNewNode={!videoContent}
            disableDownload={!videoContent}
          />
        </div>
      </FlowNodeToolbar>
      <FlowNodeToolbar isVisible={editingMode === 'cut'} position={Position.Bottom} offset={12} align='center'>
        <CutBottomToolbar
          active={editingMode === 'cut'}
          videoRef={videoRef}
          mediaSrc={videoContent}
          currentTime={playback.currentTime}
          duration={playback.duration}
          isPlaying={playback.isPlaying}
          volume={playback.volume}
          fullscreenTargetRef={nodeFrameRef}
          onClose={handleCutClose}
          onSave={handleCutSave}
        />
      </FlowNodeToolbar>
      <FlowNodeToolbar isVisible={editingMode === 'speed'} position={Position.Bottom} offset={12} align='center'>
        <SpeedBottomToolbar
          active={editingMode === 'speed'}
          videoRef={videoRef}
          mediaSrc={videoContent}
          currentTime={playback.currentTime}
          duration={playback.duration}
          isPlaying={playback.isPlaying}
          volume={playback.volume}
          fullscreenTargetRef={nodeFrameRef}
          onClose={handleSpeedClose}
          onSave={handleSpeedSave}
        />
      </FlowNodeToolbar>
      <FlowNodeToolbar isVisible={editingMode === 'erase'} position={Position.Bottom} offset={12} align='center'>
        <EraseBottomToolbar
          nodeId={id}
          active={editingMode === 'erase'}
          videoRef={videoRef}
          mediaSrc={videoContent}
          currentTime={playback.currentTime}
          duration={playback.duration}
          isPlaying={playback.isPlaying}
          volume={playback.volume}
          fullscreenTargetRef={nodeFrameRef}
          maskTool={eraseMaskTool}
          onMaskToolChange={handleEraseMaskToolChange}
          trackingPhase={trackingPhase}
          trackingSegments={trackingSegments}
          canUndo={canEraseUndo}
          canRedo={canEraseRedo}
          onUndo={handleEraseUndo}
          onRedo={handleEraseRedo}
          onClose={handleEraseClose}
          onSend={handleEraseSend}
        />
      </FlowNodeToolbar>
      <div
        ref={nodeFrameRef}
        className='relative h-full w-full min-w-0'
        style={{ minWidth: videoFlowMinWidth, minHeight: videoFlowMinHeight }}
      >
        <div className='absolute -translate-y-full left-0 right-0 -top-0 overflow-hidden'>
          <NodeHeader
            title={title}
            resolutionText={resolutionText}
            editable
            onTitleChange={(value) => updateNodeData(id, { name: value })}
          />
        </div>
        <NodeResizer
          isVisible={selected && editingMode === null}
          keepAspectRatio
          minWidth={videoFlowMinWidth}
          minHeight={videoFlowMinHeight}
        />
        <div
          className='relative flex h-full min-h-0 flex-col bg-background-default-base outline outline-2 pointer-events-auto'
          style={{ outlineColor: selected ? 'var(--color-border-utilities-selected)' : 'transparent' }}
        >
          <div
            ref={videoViewportRef}
            className='relative h-full w-full min-h-0 overflow-visible bg-white shadow-sm'
            data-agent-video-viewport={id}
            onMouseDown={handleVideoViewportMouseDown}
          >
            <div className='absolute inset-0 overflow-hidden'>
              {videoContent ? (
                <Video
                  ref={videoRef}
                  src={videoContent}
                  showControlBar={false}
                  onPlaybackUpdate={syncPlaybackFromVideo ? handlePlaybackUpdate : undefined}
                  className='h-full w-full !rounded-none'
                />
              ) : (
                <Loading inline backgroundColor='#ffffff' width='100%' height='100%' />
              )}
            </div>
            {quickEditPickPendingListForThis.map((pending) => (
              <div
                key={pending.placeholderId}
                className='pointer-events-none absolute z-[7] inline-flex h-[20px] w-[92px] items-center gap-1 rounded-full border border-white/75 bg-black/35 px-2 text-[10px] font-semibold leading-none text-white shadow-[0_2px_8px_rgba(0,0,0,0.25)] backdrop-blur-[2px] -translate-x-1/2 -translate-y-1/2'
                style={{
                  left: pending.overlayAnchor ? `${pending.overlayAnchor.xPct}%` : '50%',
                  top: pending.overlayAnchor ? `${pending.overlayAnchor.yPct}%` : '50%',
                }}
              >
                <span className='relative inline-flex h-3 w-3 shrink-0 animate-spin rounded-full border border-white/45 border-t-[#31C95B]' />
                <span>Identifying...</span>
              </div>
            ))}
            <TrackedBoxesOverlay
              boxes={visiblePickResultBoxes}
              draftBox={draftBox}
              onBoxMouseDown={handleTrackedBoxMouseDown}
              onResizeHandleMouseDown={handleTrackedBoxResizeHandleMouseDown}
            />
            {trackingPhase === 'tracking' && currentTrackingStatus === 'lost' && (
              <div className='absolute inset-0 z-[8] flex items-center justify-center bg-black/28'>
                <button
                  type='button'
                  className='pointer-events-auto inline-flex h-9 items-center gap-2 rounded-md border border-white/40 bg-black/50 px-3 text-xs font-medium text-white backdrop-blur-sm hover:bg-black/65'
                  onClick={requestTrackingReselect}
                >
                  <span>Tracking Lost, click</span>
                  <span className='inline-flex h-[18px] w-[18px] items-center justify-center rounded border border-white/55'>
                    <Icon name='videoNode-erase-selection' width={14} height={14} color='#fff' />
                  </span>
                  <span>to reselect</span>
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
};

export default memo(VideoNode);
