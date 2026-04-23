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
import { isAdjustValueNeutral, videoAdjustWithFfmpeg } from '@/utils/videoAdjustWithFfmpeg';
import { videoStabilizationWithFfmpeg } from '@/utils/videoStabilizationWithFfmpeg';
import { videoCropWithFfmpeg } from '@/utils/videoCropWithFfmpeg';
import { videoHdrConversionWithFfmpeg } from '@/utils/videoHdrConversionWithFfmpeg';
import { videoSceneExtensionWithFfmpeg } from '@/utils/videoSceneExtensionWithFfmpeg';
import { videoAudioDenoiseWithFfmpeg } from '@/utils/videoAudioDenoiseWithFfmpeg';
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
import ExtendBottomToolbar, { type VideoExtendDurationSec } from './extend/ExtendBottomToolbar';
import AnimateBottomToolbar, { type VideoAnimateStyleKey } from './animate/AnimateBottomToolbar';
import AdjustBottomToolbar, { type AdjustValue, defaultAdjustValue } from './adjust/AdjustBottomToolbar';
import VideoAdjustWebGLCanvas from './adjust/VideoAdjustWebGLCanvas';
import StabilizationBottomToolbar from './stabilization/StabilizationBottomToolbar';
import CropBottomToolbar from './crop/CropBottomToolbar';
import HdrConversionBottomToolbar, { type HdrConversionPayload } from './hdrConversion/HdrConversionBottomToolbar';
import CropOverlay, { type CropRect } from './crop/CropOverlay';
import SceneExtensionBottomToolbar, { type SceneExtensionResolution } from './sceneExtension/SceneExtensionBottomToolbar';
import SceneExtensionOverlay, { type SceneExtensionFrame } from './sceneExtension/SceneExtensionOverlay';
import AudioDenoiseBottomToolbar from './audioDenoise/AudioDenoiseBottomToolbar';
import TrackedBoxesOverlay from './erase/TrackedBoxesOverlay';
import type { VideoEraseMaskTool } from './erase/EraseBottomToolbar';
import type { EraseTrackingBox, EraseTrackingPhase, EraseTrackingSegment, EraseTrackingStatus } from './erase/EraseTrackingPanel';
import { useVideoEraseInteractions } from './erase/useVideoEraseInteractions';
import type { TimelineCutMarker } from './playback/PlaybackPanel';
import LipSyncBottomToolbar, { type LipSyncFaceItem, type LipSyncPhase, type LipSyncVoiceState } from './lipSync/LipSyncBottomToolbar';
import { detectHumanVoice } from './lipSync/detectHumanVoice';

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
const STABILIZATION_CROP_DEFAULT = 6;
const STABILIZATION_CROP_MIN = 0;
const STABILIZATION_CROP_MAX = 14;
const LIP_SYNC_IDENTIFY_DELAY_MS = 1200;

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

type LipSyncFace = LipSyncFaceItem & {
  box: EraseTrackingBox;
};

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
  const { setCenter, getZoom } = useReactFlow();
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
  const [editingMode, setEditingMode] = useState<
    | 'cut'
    | 'speed'
    | 'erase'
    | 'extend'
    | 'animate'
    | 'adjust'
    | 'stabilization'
    | 'crop'
    | 'hdrConversion'
    | 'sceneExtension'
    | 'audioDenoise'
    | 'lipSync'
    | null
  >(null);
  const [adjustPreviewValue, setAdjustPreviewValue] = useState<AdjustValue>(defaultAdjustValue);
  const [eraseMaskTool, setEraseMaskTool] = useState<VideoEraseMaskTool>('selection');
  const [trackingSegments, setTrackingSegments] = useState<EraseTrackingSegment[]>([]);
  const [canEraseUndo, setCanEraseUndo] = useState(false);
  const [canEraseRedo, setCanEraseRedo] = useState(false);
  const [isCutSaving, setIsCutSaving] = useState(false);
  const [isSpeedSaving, setIsSpeedSaving] = useState(false);
  const [isAdjustSaving, setIsAdjustSaving] = useState(false);
  const [isStabilizationSaving, setIsStabilizationSaving] = useState(false);
  const [isCropSaving, setIsCropSaving] = useState(false);
  const [isHdrSaving, setIsHdrSaving] = useState(false);
  const [isAudioDenoiseSaving, setIsAudioDenoiseSaving] = useState(false);
  const [lipSyncPhase, setLipSyncPhase] = useState<LipSyncPhase>('idle');
  const [lipSyncFaces, setLipSyncFaces] = useState<LipSyncFace[]>([]);
  const [selectedLipSyncFaceId, setSelectedLipSyncFaceId] = useState<string | null>(null);
  const [lipSyncTrackingSegments, setLipSyncTrackingSegments] = useState<EraseTrackingSegment[]>([]);
  const [lipSyncAudioSource, setLipSyncAudioSource] = useState<
    | { type: 'upload'; name: string; file: File }
    | null
  >(null);
  const [lipSyncVoiceState, setLipSyncVoiceState] = useState<LipSyncVoiceState>('idle');
  const [lipSyncVoiceMessage, setLipSyncVoiceMessage] = useState('');
  const [lipSyncAudioTrackSrc, setLipSyncAudioTrackSrc] = useState('');
  const [hdrProgressPct, setHdrProgressPct] = useState(0);
  const [audioDenoiseIntensity, setAudioDenoiseIntensity] = useState(50);
  const [stabilizationCropPct, setStabilizationCropPct] = useState(STABILIZATION_CROP_DEFAULT);
  const [cropRect, setCropRect] = useState<CropRect>({
    x: 0,
    y: 0,
    w: currentWidth,
    h: currentHeight,
  });
  const [sceneExtensionSize, setSceneExtensionSize] = useState<{ w: number; h: number }>({
    w: currentWidth,
    h: currentHeight,
  });
  const [sceneExtensionOrigin, setSceneExtensionOrigin] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const nodeFromStore = useMemo(() => nodes.find((n: Node) => n.id === id), [nodes, id]);
  const nodesRef = useRef(nodes);
  const playbackTimeRef = useRef(playback.currentTime);
  const prevPlaybackTimeRef = useRef(playback.currentTime);
  const scheduledVideoErasePickIdsRef = useRef(new Set<string>());
  const pendingManualBoxRef = useRef(new Map<string, ImageEditorPickResultBox>());
  const lipSyncIdentifyTimerRef = useRef<number | null>(null);
  const eraseEntryPickStateRef = useRef<ImageFlowNodeData['pickState'] | null>(null);
  const eraseUndoStackRef = useRef<ImageEditorPickResultBox[][]>([]);
  const eraseRedoStackRef = useRef<ImageEditorPickResultBox[][]>([]);

  useEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);

  useEffect(() => () => {
    if (lipSyncIdentifyTimerRef.current != null) {
      window.clearTimeout(lipSyncIdentifyTimerRef.current);
      lipSyncIdentifyTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (editingMode === 'lipSync') return;
    if (lipSyncIdentifyTimerRef.current != null) {
      window.clearTimeout(lipSyncIdentifyTimerRef.current);
      lipSyncIdentifyTimerRef.current = null;
    }
  }, [editingMode]);

  useEffect(() => {
    if (!lipSyncAudioSource?.file) {
      setLipSyncAudioTrackSrc('');
      return;
    }
    const objectUrl = URL.createObjectURL(lipSyncAudioSource.file);
    setLipSyncAudioTrackSrc(objectUrl);
    return () => {
      URL.revokeObjectURL(objectUrl);
    };
  }, [lipSyncAudioSource]);

  const updateEraseHistoryFlags = useCallback(() => {
    setCanEraseUndo(eraseUndoStackRef.current.length > 0);
    setCanEraseRedo(eraseRedoStackRef.current.length > 0);
  }, []);

  const resetEraseHistory = useCallback(() => {
    eraseUndoStackRef.current = [];
    eraseRedoStackRef.current = [];
    updateEraseHistoryFlags();
  }, [updateEraseHistoryFlags]);

  const cloneResultBoxes = useCallback(
    (boxes: ImageEditorPickResultBox[]) => boxes.map((box) => ({ ...box })),
    [],
  );

  const readCurrentResultBoxes = useCallback(() => {
    const source = nodesRef.current.find((n) => n.id === id);
    return ((source?.data as Partial<ImageFlowNodeData> | undefined)?.pickState?.resultBoxes ?? []) as ImageEditorPickResultBox[];
  }, [id]);

  const startTrackingAnalysis = useCallback(
    (anchorSec: number, sourceBoxes?: ImageEditorPickResultBox[]) => {
      const duration = playback.duration > 0 ? playback.duration : 0;
      const trackedBoxes = toTrackingBoxes(sourceBoxes ?? readCurrentResultBoxes());
      setTrackingSegments(buildTrackingSegments(duration, anchorSec, trackedBoxes));
    },
    [playback.duration, readCurrentResultBoxes],
  );

  const applyResultBoxes = useCallback(
    (nextBoxes: ImageEditorPickResultBox[], options?: { recordHistory?: boolean }) => {
      const recordHistory = options?.recordHistory !== false;
      const currentBoxes = cloneResultBoxes(readCurrentResultBoxes());
      const normalizedNextBoxes = cloneResultBoxes(nextBoxes);
      if (recordHistory) {
        eraseUndoStackRef.current.push(currentBoxes);
        eraseRedoStackRef.current = [];
      }
      updateNode(
        id,
        {
          data: {
            pickState: {
              resultBoxes: normalizedNextBoxes.length ? normalizedNextBoxes : null,
            },
          },
        },
        { history: 'skip' },
      );
      if (normalizedNextBoxes.length > 0) {
        const anchorBox = normalizedNextBoxes.find((box) => Number.isFinite(box.frameTimeSec));
        const anchorSec = anchorBox?.frameTimeSec ?? playback.currentTime;
        startTrackingAnalysis(anchorSec, normalizedNextBoxes);
      } else {
        setTrackingSegments([]);
      }
      updateEraseHistoryFlags();
    },
    [cloneResultBoxes, id, playback.currentTime, readCurrentResultBoxes, setTrackingSegments, startTrackingAnalysis, updateEraseHistoryFlags, updateNode],
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

  const currentTrackingStatus = useMemo(
    () => resolveTrackingStatusAtTime(trackingSegments, playback.currentTime),
    [trackingSegments, playback.currentTime],
  );
  const currentLipSyncTrackingStatus = useMemo(
    () => resolveTrackingStatusAtTime(lipSyncTrackingSegments, playback.currentTime),
    [lipSyncTrackingSegments, playback.currentTime],
  );
  const showLipSyncTrackingPending =
    editingMode === 'lipSync' &&
    lipSyncPhase === 'ready' &&
    selectedLipSyncFaceId != null &&
    lipSyncTrackingSegments.length === 0;
  const showLipSyncLostOverlay =
    editingMode === 'lipSync' &&
    lipSyncPhase === 'ready' &&
    currentLipSyncTrackingStatus === 'lost';
  let eraseInteractionMode: 'cut' | 'speed' | 'erase' | 'extend' | 'animate' | 'adjust' | null = null;
  if (
    editingMode === 'cut' ||
    editingMode === 'speed' ||
    editingMode === 'erase' ||
    editingMode === 'extend' ||
    editingMode === 'animate' ||
    editingMode === 'adjust'
  ) {
    eraseInteractionMode = editingMode;
  }
  const { draftBox, clearEraseInteractionState, handleTrackedBoxMouseDown, handleTrackedBoxResizeHandleMouseDown, handleVideoViewportMouseDown } =
    useVideoEraseInteractions({
      id,
      editingMode: eraseInteractionMode,
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
    const currentBoxes = cloneResultBoxes(readCurrentResultBoxes());
    const prevBoxes = cloneResultBoxes(eraseUndoStackRef.current.pop() ?? []);
    eraseRedoStackRef.current.push(currentBoxes);
    applyResultBoxes(prevBoxes, { recordHistory: false });
  }, [applyResultBoxes, cloneResultBoxes, readCurrentResultBoxes]);

  const handleEraseRedo = useCallback(() => {
    if (eraseRedoStackRef.current.length === 0) return;
    const currentBoxes = cloneResultBoxes(readCurrentResultBoxes());
    const nextBoxes = cloneResultBoxes(eraseRedoStackRef.current.pop() ?? []);
    eraseUndoStackRef.current.push(currentBoxes);
    applyResultBoxes(nextBoxes, { recordHistory: false });
  }, [applyResultBoxes, cloneResultBoxes, readCurrentResultBoxes]);

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

  const handleExtendOpen = useCallback(() => {
    if (!videoContent || editingMode === 'extend') return;
    focusCurrentNode();
    setEditingMode('extend');
  }, [editingMode, focusCurrentNode, videoContent]);

  const handleAnimateOpen = useCallback(() => {
    if (!videoContent || editingMode === 'animate') return;
    focusCurrentNode();
    setEditingMode('animate');
  }, [editingMode, focusCurrentNode, videoContent]);

  const handleAdjustOpen = useCallback(() => {
    if (!videoContent || editingMode === 'adjust') return;
    focusCurrentNode();
    setAdjustPreviewValue(defaultAdjustValue);
    setEditingMode('adjust');
  }, [editingMode, focusCurrentNode, videoContent]);

  const handleStabilizationOpen = useCallback(() => {
    if (!videoContent || editingMode === 'stabilization') return;
    focusCurrentNode();
    setStabilizationCropPct(STABILIZATION_CROP_DEFAULT);
    setEditingMode('stabilization');
  }, [editingMode, focusCurrentNode, videoContent]);

  const handleCropOpen = useCallback(() => {
    if (!videoContent || editingMode === 'crop') return;
    focusCurrentNode();
    setCropRect({ x: 0, y: 0, w: currentWidth, h: currentHeight });
    setEditingMode('crop');
  }, [currentHeight, currentWidth, editingMode, focusCurrentNode, videoContent]);

  const handleUpscale = useCallback((_nodeId: string, _target: VideoUpscaleTarget) => {
    message.warning('Upscale coming soon');
  }, []);

  const handleInterpolate = useCallback((_nodeId: string, _target: VideoInterpolateTarget) => {
    message.warning('Interpolate coming soon');
  }, []);

  const handleHdrConversion = useCallback(() => {
    if (!videoContent || editingMode === 'hdrConversion') return;
    focusCurrentNode();
    setHdrProgressPct(0);
    setEditingMode('hdrConversion');
  }, [editingMode, focusCurrentNode, videoContent]);

  const handleSceneExtensionOpen = useCallback(() => {
    if (!videoContent || editingMode === 'sceneExtension') return;
    const cw = Math.max(1, Math.round(currentWidth));
    const ch = Math.max(1, Math.round(currentHeight));
    const pad = 40;
    setSceneExtensionSize({ w: cw + pad * 2, h: ch + pad * 2 });
    setSceneExtensionOrigin({ x: -pad, y: -pad });
    setEditingMode('sceneExtension');
    focusCurrentNode(0.6);
  }, [currentHeight, currentWidth, editingMode, focusCurrentNode, videoContent]);

  const handleAudioDenoiseOpen = useCallback(() => {
    if (!videoContent || editingMode === 'audioDenoise') return;
    focusCurrentNode();
    setAudioDenoiseIntensity(50);
    setEditingMode('audioDenoise');
  }, [editingMode, focusCurrentNode, videoContent]);

  const validateLipSyncAudioSource = useCallback(
    async (input: { type: 'upload'; name: string; file: File }) => {
      setLipSyncVoiceState('checking');
      setLipSyncVoiceMessage('');
      try {
        const result = await detectHumanVoice({ type: 'file', file: input.file });
        if (result.hasHumanVoice) {
          setLipSyncVoiceState('valid');
          setLipSyncVoiceMessage('');
        } else {
          setLipSyncVoiceState('invalid');
          setLipSyncVoiceMessage(result.reason ?? 'No human voice detected');
        }
      } catch {
        setLipSyncVoiceState('invalid');
        setLipSyncVoiceMessage('Failed to analyze audio, please try another one');
      }
    },
    [],
  );

  const startLipSyncFaceIdentification = useCallback(() => {
    if (lipSyncIdentifyTimerRef.current != null) {
      window.clearTimeout(lipSyncIdentifyTimerRef.current);
      lipSyncIdentifyTimerRef.current = null;
    }
    setLipSyncPhase('identifying');
    setLipSyncFaces([]);
    setSelectedLipSyncFaceId(null);
    setLipSyncTrackingSegments([]);
    lipSyncIdentifyTimerRef.current = window.setTimeout(() => {
      const detectedFaces: LipSyncFace[] = [
        {
          id: 'face_01',
          label: 'face_01',
          confidence: 0.96,
          box: { cxPct: 36, cyPct: 34, wPct: 15, hPct: 24, placeholderId: 'lip-face-01' },
        },
        {
          id: 'face_02',
          label: 'face_02',
          confidence: 0.72,
          box: { cxPct: 67, cyPct: 33, wPct: 15, hPct: 24, placeholderId: 'lip-face-02' },
        },
      ];
      setLipSyncFaces(detectedFaces);
      setSelectedLipSyncFaceId(detectedFaces[0]?.id ?? null);
      setLipSyncPhase('ready');
      if ((playback.duration ?? 0) > 0) {
        setLipSyncTrackingSegments(
          buildTrackingSegments(playback.duration, playback.currentTime, [detectedFaces[0].box]),
        );
      }
      lipSyncIdentifyTimerRef.current = null;
    }, LIP_SYNC_IDENTIFY_DELAY_MS);
  }, [playback.currentTime, playback.duration]);

  const handleLipSyncOpen = useCallback(() => {
    if (!videoContent || editingMode === 'lipSync') return;
    focusCurrentNode();
    setLipSyncAudioSource(null);
    setLipSyncVoiceState('idle');
    setLipSyncVoiceMessage('');
    setEditingMode('lipSync');
    startLipSyncFaceIdentification();
  }, [editingMode, focusCurrentNode, startLipSyncFaceIdentification, videoContent]);

  const handleLipSyncFaceSelect = useCallback((faceId: string) => {
    setSelectedLipSyncFaceId(faceId);
    const targetFace = lipSyncFaces.find((item) => item.id === faceId);
    if (!targetFace || (playback.duration ?? 0) <= 0) {
      setLipSyncTrackingSegments([]);
      return;
    }
    setLipSyncTrackingSegments(buildTrackingSegments(playback.duration, playback.currentTime, [targetFace.box]));
  }, [lipSyncFaces, playback.currentTime, playback.duration]);

  const handleLipSyncRedetect = useCallback(() => {
    startLipSyncFaceIdentification();
  }, [startLipSyncFaceIdentification]);

  const handleLipSyncUploadAudio = useCallback(
    (file: File) => {
      const nextSource = { type: 'upload' as const, name: file.name, file };
      setLipSyncAudioSource(nextSource);
      void validateLipSyncAudioSource(nextSource);
    },
    [validateLipSyncAudioSource],
  );

  const normalizeNodeSize = useCallback((size: { width: number; height: number }) => {
    return {
      width: Math.max(videoFlowMinWidth, Math.round(size.width)),
      height: Math.max(videoFlowMinHeight, Math.round(size.height)),
    };
  }, []);

  const applyResultNodeSize = useCallback(
    (nodeId: string, size: { width: number; height: number }) => {
      const nextSize = normalizeNodeSize(size);
      updateNode(
        nodeId,
        { style: { width: nextSize.width, height: nextSize.height } },
        { history: 'skip' },
      );
    },
    [normalizeNodeSize, updateNode],
  );

  const deriveResultNodeSize = useCallback(
    async (
      nextSrc: string,
      fallback: { width: number; height: number },
    ): Promise<{ width: number; height: number }> => {
      try {
        const resultMeta = await getVideoMetaFromUrl(nextSrc).catch(() => ({ width: undefined, height: undefined }));
        const sourceMeta = await getVideoMetaFromUrl(videoContent).catch(() => ({ width: undefined, height: undefined }));
        const sourceW = Number(sourceMeta.width ?? 0);
        const sourceH = Number(sourceMeta.height ?? 0);
        const resultW = Number(resultMeta.width ?? 0);
        const resultH = Number(resultMeta.height ?? 0);
        if (sourceW <= 0 || sourceH <= 0 || resultW <= 0 || resultH <= 0) {
          return normalizeNodeSize(fallback);
        }
        const scaleX = currentWidth / sourceW;
        const scaleY = currentHeight / sourceH;
        return normalizeNodeSize({
          width: resultW * scaleX,
          height: resultH * scaleY,
        });
      } catch {
        return normalizeNodeSize(fallback);
      }
    },
    [currentHeight, currentWidth, normalizeNodeSize, videoContent],
  );

  const handleCutout = useCallback((_nodeId: string) => {
    message.warning('Cutout coming soon');
  }, []);

  const handleSceneExtension = useCallback((_nodeId: string) => {
    handleSceneExtensionOpen();
  }, [handleSceneExtensionOpen]);

  const handleAudioDenoise = useCallback((_nodeId: string) => {
    handleAudioDenoiseOpen();
  }, [handleAudioDenoiseOpen]);

  const handleLipSync = useCallback((_nodeId: string) => {
    handleLipSyncOpen();
  }, [handleLipSyncOpen]);

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

  const handleExtendClose = useCallback(() => {
    if (editingMode !== 'extend') return;
    setEditingMode(null);
  }, [editingMode]);

  const handleAnimateClose = useCallback(() => {
    if (editingMode !== 'animate') return;
    setEditingMode(null);
  }, [editingMode]);

  const handleAdjustClose = useCallback(() => {
    if (editingMode !== 'adjust') return;
    setEditingMode(null);
  }, [editingMode]);

  const handleStabilizationClose = useCallback(() => {
    if (editingMode !== 'stabilization') return;
    setEditingMode(null);
  }, [editingMode]);

  const handleCropClose = useCallback(() => {
    if (editingMode !== 'crop') return;
    setEditingMode(null);
  }, [editingMode]);

  const handleHdrConversionClose = useCallback(() => {
    if (editingMode !== 'hdrConversion' || isHdrSaving) return;
    setEditingMode(null);
    setHdrProgressPct(0);
  }, [editingMode, isHdrSaving]);

  const handleSceneExtensionClose = useCallback(() => {
    if (editingMode !== 'sceneExtension') return;
    setEditingMode(null);
  }, [editingMode]);

  const handleAudioDenoiseClose = useCallback(() => {
    if (editingMode !== 'audioDenoise' || isAudioDenoiseSaving) return;
    setEditingMode(null);
  }, [editingMode, isAudioDenoiseSaving]);

  const handleLipSyncClose = useCallback(() => {
    if (editingMode !== 'lipSync') return;
    if (lipSyncIdentifyTimerRef.current != null) {
      window.clearTimeout(lipSyncIdentifyTimerRef.current);
      lipSyncIdentifyTimerRef.current = null;
    }
    setLipSyncPhase('idle');
    setLipSyncFaces([]);
    setSelectedLipSyncFaceId(null);
    setLipSyncTrackingSegments([]);
    setLipSyncAudioSource(null);
    setLipSyncVoiceState('idle');
    setLipSyncVoiceMessage('');
    setEditingMode(null);
  }, [editingMode]);

  const handleEraseSend = useCallback((_payload: { maskTool: VideoEraseMaskTool }) => {
    message.warning('Erase coming soon');
  }, []);

  const handleExtendSend = useCallback((_payload: { durationSec: VideoExtendDurationSec; prompt: string }) => {
    message.warning('Extend coming soon');
  }, []);

  const handleAnimateSend = useCallback((_payload: { style: VideoAnimateStyleKey; prompt: string }) => {
    message.warning('Animate coming soon');
  }, []);

  const handleLipSyncSend = useCallback(() => {
    if (!selectedLipSyncFaceId) {
      message.warning('Please select one face to continue');
      return;
    }
    if (!lipSyncAudioSource) {
      message.warning('Please select or upload an audio source');
      return;
    }
    if (lipSyncVoiceState !== 'valid') {
      message.warning('Selected audio does not contain clear human voice');
      return;
    }
    message.warning('Lip Sync generation is coming soon');
  }, [lipSyncAudioSource, lipSyncVoiceState, selectedLipSyncFaceId]);

  const handleStabilizationSend = useCallback(
    async (payload: { stabilization: number }) => {
      if (!videoContent || isStabilizationSaving) return;
      const placeholderId = createVideoPlaceholderNodeRight(id, { nameSuffix: 'stabilization', state: 'generating' });
      if (!placeholderId) return;
      const ratio = Math.max(
        0,
        1 - (Math.max(STABILIZATION_CROP_MIN, Math.min(STABILIZATION_CROP_MAX, payload.stabilization)) * 2) / 100,
      );
      const expectedSize = normalizeNodeSize({
        width: currentWidth * ratio,
        height: currentHeight * ratio,
      });
      applyResultNodeSize(placeholderId, expectedSize);
      setEditingMode(null);
      setIsStabilizationSaving(true);
      try {
        const nextSrc = payload.stabilization <= 0
          ? videoContent
          : await videoStabilizationWithFfmpeg(videoContent, payload.stabilization);
        if (!nextSrc) {
          removeNode(placeholderId);
          return;
        }
        const nextNodeSize = await deriveResultNodeSize(nextSrc, expectedSize);
        applyResultNodeSize(placeholderId, nextNodeSize);
        resolveVideoResultNode(placeholderId, nextSrc, { state: 'idle' });
      } catch {
        removeNode(placeholderId);
        message.error('Could not export stabilization result. Try again or use a smaller clip.');
      } finally {
        setIsStabilizationSaving(false);
      }
    },
    [
      createVideoPlaceholderNodeRight,
      id,
      isStabilizationSaving,
      removeNode,
      resolveVideoResultNode,
      applyResultNodeSize,
      currentHeight,
      currentWidth,
      deriveResultNodeSize,
      normalizeNodeSize,
      videoContent,
    ],
  );

  const handleSceneExtensionDimensionChange = useCallback(
    (w: number, h: number, keepCentered = false) => {
      const cw = Math.max(1, Math.round(currentWidth));
      const ch = Math.max(1, Math.round(currentHeight));
      const ow = Math.max(cw, Math.round(w));
      const oh = Math.max(ch, Math.round(h));
      if (keepCentered) {
        setSceneExtensionOrigin({ x: (cw - ow) / 2, y: (ch - oh) / 2 });
      }
      setSceneExtensionSize({ w: ow, h: oh });
    },
    [currentHeight, currentWidth],
  );

  const handleSceneExtensionFrameChange = useCallback(
    (next: SceneExtensionFrame) => {
      const cw = Math.max(1, Math.round(currentWidth));
      const ch = Math.max(1, Math.round(currentHeight));
      setSceneExtensionSize({ w: Math.max(cw, next.w), h: Math.max(ch, next.h) });
      setSceneExtensionOrigin({ x: next.ox, y: next.oy });
    },
    [currentHeight, currentWidth],
  );

  const handleSceneExtensionSend = useCallback(
    async (payload: { width: number; height: number; resolution: SceneExtensionResolution; ratio: string }) => {
      if (!videoContent) return;
      const placeholderId = createVideoPlaceholderNodeRight(id, { nameSuffix: 'scene-extension', state: 'generating' });
      if (!placeholderId) return;

      const frame = {
        w: Math.max(1, Math.round(payload.width)),
        h: Math.max(1, Math.round(payload.height)),
        ox: sceneExtensionOrigin.x,
        oy: sceneExtensionOrigin.y,
      };
      const expectedSize = normalizeNodeSize({ width: frame.w, height: frame.h });
      applyResultNodeSize(placeholderId, expectedSize);
      setEditingMode(null);

      try {
        const nextSrc = await videoSceneExtensionWithFfmpeg(videoContent, {
          frame,
          container: { width: currentWidth, height: currentHeight },
        });
        if (!nextSrc) {
          removeNode(placeholderId);
          return;
        }
        const nextNodeSize = await deriveResultNodeSize(nextSrc, expectedSize);
        applyResultNodeSize(placeholderId, nextNodeSize);
        resolveVideoResultNode(placeholderId, nextSrc, { state: 'idle' });
      } catch {
        removeNode(placeholderId);
        message.error('Could not export scene extension result. Try again.');
      }
    },
    [
      applyResultNodeSize,
      createVideoPlaceholderNodeRight,
      currentHeight,
      currentWidth,
      deriveResultNodeSize,
      id,
      normalizeNodeSize,
      removeNode,
      resolveVideoResultNode,
      sceneExtensionOrigin.x,
      sceneExtensionOrigin.y,
      videoContent,
    ],
  );

  const handleAudioDenoiseSend = useCallback(
    async (payload: { intensity: number }) => {
      if (!videoContent || isAudioDenoiseSaving) return;
      const placeholderId = createVideoPlaceholderNodeRight(id, { nameSuffix: 'audio-denoise', state: 'generating' });
      if (!placeholderId) return;
      setEditingMode(null);
      setIsAudioDenoiseSaving(true);
      try {
        const nextSrc = await videoAudioDenoiseWithFfmpeg(videoContent, payload.intensity);
        if (!nextSrc) {
          removeNode(placeholderId);
          return;
        }
        resolveVideoResultNode(placeholderId, nextSrc, { state: 'idle' });
      } catch {
        removeNode(placeholderId);
        message.error('Could not export audio denoise result. Try again or use a different clip.');
      } finally {
        setIsAudioDenoiseSaving(false);
      }
    },
    [createVideoPlaceholderNodeRight, id, isAudioDenoiseSaving, removeNode, resolveVideoResultNode, videoContent],
  );

  const handleCropDimensionChange = useCallback(
    (w: number, h: number, keepCentered = false) => {
      setCropRect((prev) => {
        if (keepCentered) {
          return {
            x: Math.max(0, Math.round((currentWidth - w) / 2)),
            y: Math.max(0, Math.round((currentHeight - h) / 2)),
            w,
            h,
          };
        }
        const maxX = Math.max(0, currentWidth - w);
        const maxY = Math.max(0, currentHeight - h);
        return {
          x: Math.min(maxX, Math.max(0, prev.x)),
          y: Math.min(maxY, Math.max(0, prev.y)),
          w,
          h,
        };
      });
    },
    [currentHeight, currentWidth],
  );

  const handleCropSave = useCallback(async () => {
    if (!videoContent || isCropSaving) return;
    const placeholderId = createVideoPlaceholderNodeRight(id, { nameSuffix: 'crop', state: 'generating' });
    if (!placeholderId) return;
    const expectedSize = normalizeNodeSize({
      width: cropRect.w,
      height: cropRect.h,
    });
    applyResultNodeSize(placeholderId, expectedSize);
    setEditingMode(null);
    setIsCropSaving(true);
    try {
      const nextSrc = await videoCropWithFfmpeg(videoContent, cropRect, {
        width: currentWidth,
        height: currentHeight,
      });
      if (!nextSrc) {
        removeNode(placeholderId);
        return;
      }
      const nextNodeSize = await deriveResultNodeSize(nextSrc, expectedSize);
      applyResultNodeSize(placeholderId, nextNodeSize);
      resolveVideoResultNode(placeholderId, nextSrc, { state: 'idle' });
    } catch {
      removeNode(placeholderId);
      message.error('Could not export cropped video. Try again or use a smaller clip.');
    } finally {
      setIsCropSaving(false);
    }
  }, [
    createVideoPlaceholderNodeRight,
    cropRect,
    currentHeight,
    currentWidth,
    id,
    isCropSaving,
    removeNode,
    resolveVideoResultNode,
    applyResultNodeSize,
    deriveResultNodeSize,
    normalizeNodeSize,
    videoContent,
  ]);

  const handleHdrConversionSave = useCallback(
    async (payload: HdrConversionPayload) => {
      if (!videoContent || isHdrSaving) return;
      if (payload.aiEnhance) {
        message.warning('AI Enhance for HDR Conversion is coming soon');
        return;
      }
      const placeholderId = createVideoPlaceholderNodeRight(id, {
        nameSuffix: payload.aiEnhance ? 'hdr-ai' : 'hdr',
        state: 'generating',
      });
      if (!placeholderId) return;
      // Match Cut behavior: exit toolbar immediately after Save.
      setEditingMode(null);
      setIsHdrSaving(true);
      setHdrProgressPct(payload.aiEnhance ? 8 : 70);
      try {
        const nextSrc = await videoHdrConversionWithFfmpeg(videoContent, {
          preset: payload.preset,
          intensity: payload.intensity,
          aiEnhance: payload.aiEnhance,
          onProgress: payload.aiEnhance
            ? (progressPct) => setHdrProgressPct(progressPct)
            : undefined,
        });
        if (!nextSrc) {
          removeNode(placeholderId);
          return;
        }
        const nextMeta = await getVideoMetaFromUrl(nextSrc);
        if (!nextMeta.width || !nextMeta.height) {
          throw new Error('HDR output is not decodable by browser');
        }
        resolveVideoResultNode(placeholderId, nextSrc, { state: 'idle' });
      } catch {
        removeNode(placeholderId);
        message.error('Could not export HDR conversion result. Try again or use a smaller clip.');
      } finally {
        setIsHdrSaving(false);
        setHdrProgressPct(0);
      }
    },
    [
      createVideoPlaceholderNodeRight,
      id,
      isHdrSaving,
      removeNode,
      resolveVideoResultNode,
      videoContent,
    ],
  );

  const handleAdjustSave = useCallback(
    async (value: AdjustValue) => {
      if (!videoContent || isAdjustSaving) return;
      const placeholderId = createVideoPlaceholderNodeRight(id, { nameSuffix: 'adjust', state: 'generating' });
      if (!placeholderId) return;
      setEditingMode(null);
      setIsAdjustSaving(true);
      try {
        const nextSrc = isAdjustValueNeutral(value)
          ? videoContent
          : await videoAdjustWithFfmpeg(videoContent, value);
        if (!nextSrc) {
          removeNode(placeholderId);
          return;
        }
        resolveVideoResultNode(placeholderId, nextSrc, { state: 'idle' });
      } catch {
        removeNode(placeholderId);
        message.error('Could not export adjusted video. Try again or use a smaller clip.');
      } finally {
        setIsAdjustSaving(false);
      }
    },
    [
      createVideoPlaceholderNodeRight,
      id,
      isAdjustSaving,
      removeNode,
      resolveVideoResultNode,
      videoContent,
    ],
  );

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

  const zoom = getZoom();
  const sceneExtensionToolbarBottomOffset = useMemo(
    () => 12 + Math.max(0, sceneExtensionOrigin.y + sceneExtensionSize.h - currentHeight) * zoom,
    [currentHeight, sceneExtensionOrigin.y, sceneExtensionSize.h, zoom],
  );
  const sceneExtensionToolbarTranslateX = useMemo(
    () => (sceneExtensionOrigin.x + sceneExtensionSize.w / 2 - currentWidth / 2) * zoom,
    [currentWidth, sceneExtensionOrigin.x, sceneExtensionSize.w, zoom],
  );

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
          onExtend={handleExtendOpen}
          onAnimate={handleAnimateOpen}
          onAdjust={handleAdjustOpen}
          onStabilization={handleStabilizationOpen}
          onLipSync={handleLipSync}
          onCrop={handleCropOpen}
          onHdrConversion={handleHdrConversion}
          onCutout={handleCutout}
          onSceneExtension={handleSceneExtension}
          onAudioDenoise={handleAudioDenoise}
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
      <FlowNodeToolbar isVisible={editingMode === 'extend'} position={Position.Bottom} offset={12} align='center'>
        <ExtendBottomToolbar
          active={editingMode === 'extend'}
          videoRef={videoRef}
          mediaSrc={videoContent}
          currentTime={playback.currentTime}
          duration={playback.duration}
          isPlaying={playback.isPlaying}
          volume={playback.volume}
          fullscreenTargetRef={nodeFrameRef}
          onClose={handleExtendClose}
          onSend={handleExtendSend}
        />
      </FlowNodeToolbar>
      <FlowNodeToolbar isVisible={editingMode === 'animate'} position={Position.Bottom} offset={12} align='center'>
        <AnimateBottomToolbar
          active={editingMode === 'animate'}
          videoRef={videoRef}
          mediaSrc={videoContent}
          currentTime={playback.currentTime}
          duration={playback.duration}
          isPlaying={playback.isPlaying}
          volume={playback.volume}
          fullscreenTargetRef={nodeFrameRef}
          onClose={handleAnimateClose}
          onSend={handleAnimateSend}
        />
      </FlowNodeToolbar>
      <FlowNodeToolbar isVisible={editingMode === 'adjust'} position={Position.Bottom} offset={12} align='center'>
        <AdjustBottomToolbar
          active={editingMode === 'adjust'}
          videoRef={videoRef}
          mediaSrc={videoContent}
          currentTime={playback.currentTime}
          duration={playback.duration}
          isPlaying={playback.isPlaying}
          volume={playback.volume}
          fullscreenTargetRef={nodeFrameRef}
          onClose={handleAdjustClose}
          onChange={setAdjustPreviewValue}
          onSave={handleAdjustSave}
        />
      </FlowNodeToolbar>
      <FlowNodeToolbar isVisible={editingMode === 'stabilization'} position={Position.Bottom} offset={12} align='center'>
        <StabilizationBottomToolbar
          active={editingMode === 'stabilization'}
          videoRef={videoRef}
          mediaSrc={videoContent}
          currentTime={playback.currentTime}
          duration={playback.duration}
          isPlaying={playback.isPlaying}
          volume={playback.volume}
          fullscreenTargetRef={nodeFrameRef}
          stabilization={stabilizationCropPct}
          onChange={setStabilizationCropPct}
          onClose={handleStabilizationClose}
          onSend={handleStabilizationSend}
        />
      </FlowNodeToolbar>
      <FlowNodeToolbar isVisible={editingMode === 'crop'} position={Position.Bottom} offset={12} align='center'>
        <CropBottomToolbar
          active={editingMode === 'crop'}
          videoRef={videoRef}
          mediaSrc={videoContent}
          currentTime={playback.currentTime}
          duration={playback.duration}
          isPlaying={playback.isPlaying}
          volume={playback.volume}
          fullscreenTargetRef={nodeFrameRef}
          width={cropRect.w}
          height={cropRect.h}
          containerWidth={currentWidth}
          containerHeight={currentHeight}
          onDimensionChange={handleCropDimensionChange}
          onClose={handleCropClose}
          onSave={handleCropSave}
        />
      </FlowNodeToolbar>
      <FlowNodeToolbar
        isVisible={editingMode === 'sceneExtension'}
        position={Position.Bottom}
        offset={sceneExtensionToolbarBottomOffset}
        align='center'
      >
        <div
          className='pointer-events-auto'
          style={sceneExtensionToolbarTranslateX !== 0 ? { transform: `translateX(${sceneExtensionToolbarTranslateX}px)` } : undefined}
        >
          <SceneExtensionBottomToolbar
            active={editingMode === 'sceneExtension'}
            videoRef={videoRef}
            mediaSrc={videoContent}
            currentTime={playback.currentTime}
            duration={playback.duration}
            isPlaying={playback.isPlaying}
            volume={playback.volume}
            fullscreenTargetRef={nodeFrameRef}
            width={sceneExtensionSize.w}
            height={sceneExtensionSize.h}
            containerWidth={currentWidth}
            containerHeight={currentHeight}
            onDimensionChange={handleSceneExtensionDimensionChange}
            onClose={handleSceneExtensionClose}
            onSend={handleSceneExtensionSend}
          />
        </div>
      </FlowNodeToolbar>
      <FlowNodeToolbar isVisible={editingMode === 'hdrConversion'} position={Position.Bottom} offset={12} align='center'>
        <HdrConversionBottomToolbar
          active={editingMode === 'hdrConversion'}
          videoRef={videoRef}
          mediaSrc={videoContent}
          currentTime={playback.currentTime}
          duration={playback.duration}
          isPlaying={playback.isPlaying}
          volume={playback.volume}
          fullscreenTargetRef={nodeFrameRef}
          processing={isHdrSaving}
          progressPct={hdrProgressPct}
          onClose={handleHdrConversionClose}
          onSave={handleHdrConversionSave}
        />
      </FlowNodeToolbar>
      <FlowNodeToolbar isVisible={editingMode === 'audioDenoise'} position={Position.Bottom} offset={12} align='center'>
        <AudioDenoiseBottomToolbar
          active={editingMode === 'audioDenoise'}
          videoRef={videoRef}
          mediaSrc={videoContent}
          currentTime={playback.currentTime}
          duration={playback.duration}
          isPlaying={playback.isPlaying}
          volume={playback.volume}
          fullscreenTargetRef={nodeFrameRef}
          intensity={audioDenoiseIntensity}
          onChange={setAudioDenoiseIntensity}
          onClose={handleAudioDenoiseClose}
          onSend={handleAudioDenoiseSend}
        />
      </FlowNodeToolbar>
      <FlowNodeToolbar isVisible={editingMode === 'lipSync'} position={Position.Bottom} offset={12} align='center'>
        <LipSyncBottomToolbar
          active={editingMode === 'lipSync'}
          videoRef={videoRef}
          mediaSrc={videoContent}
          currentTime={playback.currentTime}
          duration={playback.duration}
          isPlaying={playback.isPlaying}
          volume={playback.volume}
          fullscreenTargetRef={nodeFrameRef}
          phase={lipSyncPhase}
          faces={lipSyncFaces.map((face) => ({ id: face.id, label: face.label, confidence: face.confidence }))}
          selectedFaceId={selectedLipSyncFaceId}
          trackingSegments={lipSyncTrackingSegments}
          audioTrackSrc={lipSyncAudioTrackSrc}
          selectedAudioName={lipSyncAudioSource?.name}
          voiceState={lipSyncVoiceState}
          voiceMessage={lipSyncVoiceMessage}
          onFaceSelect={handleLipSyncFaceSelect}
          onRedetect={handleLipSyncRedetect}
          onUploadAudio={handleLipSyncUploadAudio}
          onClose={handleLipSyncClose}
          onSend={handleLipSyncSend}
          canSend={Boolean(selectedLipSyncFaceId && lipSyncVoiceState === 'valid' && lipSyncAudioSource)}
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
                  className={`h-full w-full !rounded-none${editingMode === 'adjust' ? ' opacity-0' : ''}`}
                />
              ) : (
                <Loading inline backgroundColor='#ffffff' width='100%' height='100%' />
              )}
              {editingMode === 'adjust' && videoContent ? (
                <VideoAdjustWebGLCanvas videoRef={videoRef} adjustValue={adjustPreviewValue} />
              ) : null}
              {editingMode === 'stabilization' && videoContent ? (
                <div
                  className='pointer-events-none absolute z-[6] border border-dashed border-[#7F88FF] bg-[rgba(127,136,255,0.14)]'
                  style={{
                    inset: `${Math.max(STABILIZATION_CROP_MIN, Math.min(STABILIZATION_CROP_MAX, stabilizationCropPct))}%`,
                  }}
                />
              ) : null}
              {editingMode === 'lipSync' && (lipSyncPhase === 'identifying' || showLipSyncTrackingPending) ? (
                <div className='pointer-events-none absolute inset-0 z-[7] flex items-center justify-center'>
                  <div className='inline-flex h-[24px] items-center gap-1 rounded-full border border-white/70 bg-black/35 px-3 text-[11px] font-semibold text-white shadow-[0_2px_8px_rgba(0,0,0,0.25)]'>
                    <span className='relative inline-flex h-3 w-3 shrink-0 animate-spin rounded-full border border-white/45 border-t-[#31C95B]' />
                    <span>Tracking...</span>
                  </div>
                </div>
              ) : null}
            </div>
            {editingMode === 'lipSync' && lipSyncPhase === 'ready' && !showLipSyncLostOverlay
              ? lipSyncFaces.map((face) => {
                const left = `${face.box.cxPct - face.box.wPct / 2}%`;
                const top = `${face.box.cyPct - face.box.hPct / 2}%`;
                const widthPct = `${face.box.wPct}%`;
                const heightPct = `${face.box.hPct}%`;
                const selectedFace = selectedLipSyncFaceId === face.id;
                return (
                  <button
                    key={face.id}
                    type='button'
                    className={`absolute z-[7] overflow-visible border-2 border-dashed ${
                      selectedFace
                        ? 'border-[#7F88FF] bg-[rgba(127,136,255,0.18)]'
                        : 'border-white/80 bg-black/20'
                    }`}
                    style={{ left, top, width: widthPct, height: heightPct }}
                    onClick={() => handleLipSyncFaceSelect(face.id)}
                  >
                    <span
                      className={`absolute left-1/2 top-full z-[1] mt-1 inline-flex -translate-x-1/2 items-center whitespace-nowrap rounded-[4px] px-1 py-[1px] text-[10px] font-semibold ${
                        selectedFace ? 'bg-[#7F88FF] text-white' : 'bg-black/55 text-white'
                      }`}
                    >
                      {face.label}_{Math.round(face.confidence * 100)}%
                    </span>
                  </button>
                );
              })
              : null}
            {showLipSyncLostOverlay ? (
              <div className='absolute inset-0 z-[8] flex items-center justify-center bg-black/28'>
                <button
                  type='button'
                  className='pointer-events-auto inline-flex h-9 items-center gap-2 rounded-md border border-white/40 bg-black/50 px-3 text-xs font-medium text-white backdrop-blur-sm hover:bg-black/65'
                  onClick={handleLipSyncRedetect}
                >
                  <span>Tracking Lost, click</span>
                  <span className='inline-flex h-[18px] w-[18px] items-center justify-center rounded border border-white/55'>
                    <Icon name='videoNode-erase-selection' width={14} height={14} color='#fff' />
                  </span>
                  <span>to reselect</span>
                </button>
              </div>
            ) : null}
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
            {editingMode === 'crop' && (
              <CropOverlay
                containerWidth={currentWidth}
                containerHeight={currentHeight}
                value={cropRect}
                onChange={setCropRect}
              />
            )}
            {editingMode === 'sceneExtension' && (
              <SceneExtensionOverlay
                containerWidth={currentWidth}
                containerHeight={currentHeight}
                outerWidth={sceneExtensionSize.w}
                outerHeight={sceneExtensionSize.h}
                originX={sceneExtensionOrigin.x}
                originY={sceneExtensionOrigin.y}
                onFrameChange={handleSceneExtensionFrameChange}
              />
            )}
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
