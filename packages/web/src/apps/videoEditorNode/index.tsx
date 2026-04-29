import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { HistoryItem } from '@breatic/shared';
import * as Y from 'yjs';
import { Icon } from '@/components/base/icon';
import Tooltip from '@/components/base/tooltip';
import Divider from '@/components/base/divider';
import RecognizedPickDropdown from '@/components/base/agent/RecognizedPickDropdown';
import { RiAddLine, RiSubtractLine } from 'react-icons/ri';
import { useCanvasData } from '@/contexts/CanvasDataContext';
import { useCanvasActions } from '@/hooks/useCanvasActions';
import { getCanvasYjsManager } from '@/utils/canvasYjsRef';
import { getUserOrigin } from '@/utils/yjsProjectManager';
import Video, { type VideoPlaybackSnapshot, type VideoRef } from '@/apps/project/components/canvas/common/Video';
import LeftHistoryPanel from './components/LeftHistoryPanel/LeftHistoryPanel';
import RightToolPanel from './components/RightToolPanel/RightToolPanel';
import CutBottomToolbar from './components/cut/CutBottomToolbar';
import SpeedBottomToolbar from './components/speed/SpeedBottomToolbar';
import UpscaleBottomToolbar from './components/upscale/UpscaleBottomToolbar';
import InterpolateBottomToolbar from './components/interpolate/InterpolateBottomToolbar';
import EraseBottomToolbar from './components/erase/EraseBottomToolbar';
import type { VideoEraseMaskTool } from './components/erase/EraseBottomToolbar';
import type { EraseTrackingSegment } from './components/erase/EraseTrackingPanel';
import ExtendBottomToolbar from './components/extend/ExtendBottomToolbar';
import AnimateBottomToolbar from './components/animate/AnimateBottomToolbar';
import AdjustBottomToolbar from './components/adjust/AdjustBottomToolbar';
import StabilizationBottomToolbar from './components/stabilization/StabilizationBottomToolbar';
import CropBottomToolbar from './components/crop/CropBottomToolbar';
import HdrConversionBottomToolbar from './components/hdrConversion/HdrConversionBottomToolbar';
import SceneExtensionBottomToolbar from './components/sceneExtension/SceneExtensionBottomToolbar';
import SceneExtensionOverlay, { type SceneExtensionFrame } from './components/sceneExtension/SceneExtensionOverlay';
import AudioDenoiseBottomToolbar from './components/audioDenoise/AudioDenoiseBottomToolbar';
import CropOverlay, { type CropRect } from './components/crop/CropOverlay';
import TrackedBoxesOverlay, { type EraseOverlayBox } from './components/erase/TrackedBoxesOverlay';
import QuickEditBottomToolbar from './components/quickEdit/QuickEditBottomToolbar';
import type { VideoEditorToolKey, VideoNodeData } from './type';
import type { VideoHistoryItem } from './components/LeftHistoryPanel/LeftHistoryPanel';

type VideoEditorNodePageProps = {
  nodeId?: string;
};

const VideoEditorNodePage: React.FC<VideoEditorNodePageProps> = ({ nodeId: nodeIdProp }) => {
  const recognizedOverlayPresets = [
    { key: 'subject', label: 'Subject', cxPct: 50, cyPct: 50, wPct: 26, hPct: 26 },
    { key: 'foreground', label: 'Foreground', cxPct: 35, cyPct: 55, wPct: 28, hPct: 28 },
    { key: 'background', label: 'Background', cxPct: 65, cyPct: 45, wPct: 30, hPct: 30 },
  ] as const;
  const params = useParams<'nodeId'>();
  const nodeId = nodeIdProp ?? params.nodeId ?? '';
  const { nodes } = useCanvasData();
  const { setActiveHistoryId, pushHistoryItem } = useCanvasActions();
  const [activeTool, setActiveTool] = useState<VideoEditorToolKey | null>(null);
  const [zoomFactor, setZoomFactor] = useState(0.8);
  const [zoomInput, setZoomInput] = useState('80');
  const [selectedHistoryId, setSelectedHistoryId] = useState<string | null>(null);
  const [hostHistoryId, setHostHistoryId] = useState<string | null>(null);
  const [playbackSnapshot, setPlaybackSnapshot] = useState<VideoPlaybackSnapshot>({
    currentTime: 0,
    duration: 0,
    isPlaying: false,
    volume: 1,
  });
  const canvasShellRef = useRef<HTMLDivElement | null>(null);
  const videoFrameRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<VideoRef | null>(null);
  const [videoFrameSize, setVideoFrameSize] = useState({ width: 0, height: 0 });
  const [cropRect, setCropRect] = useState<CropRect>({ x: 0, y: 0, w: 0, h: 0 });
  const [sceneExtensionFrame, setSceneExtensionFrame] = useState<SceneExtensionFrame>({ w: 0, h: 0, ox: 0, oy: 0 });
  const prevToolRef = useRef<VideoEditorToolKey | null>(null);
  const [eraseMaskTool, setEraseMaskTool] = useState<VideoEraseMaskTool>('selection');
  const [eraseBoxes, setEraseBoxes] = useState<EraseOverlayBox[]>([]);
  const [eraseDraft, setEraseDraft] = useState<null | { cxPct: number; cyPct: number; wPct: number; hPct: number; tool: 'rectangle' | 'circle' }>(null);
  const eraseDrawStartRef = useRef<null | { x: number; y: number }>(null);
  const [erasePendingPicks, setErasePendingPicks] = useState<Array<{ id: string; xPct: number; yPct: number; tool: 'rectangle' | 'circle' }>>([]);
  const erasePendingTimersRef = useRef<number[]>([]);
  const eraseInteractionRef = useRef<
    | null
    | {
        mode: 'move' | 'resize';
        boxId: string;
        shape: 'rectangle' | 'circle';
        handle?: 'top' | 'bottom' | 'left' | 'right' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
        startX: number;
        startY: number;
        startCx: number;
        startCy: number;
        startW: number;
        startH: number;
      }
  >(null);
  const [quickEditPickEnabled, setQuickEditPickEnabled] = useState(false);
  const [quickEditPickBoxes, setQuickEditPickBoxes] = useState<Array<{ id: string; cxPct: number; cyPct: number; wPct: number; hPct: number; name: string }>>([]);
  const [quickEditPendingPicks, setQuickEditPendingPicks] = useState<Array<{ id: string; cxPct: number; cyPct: number; wPct: number; hPct: number }>>([]);
  const quickEditPickTimersRef = useRef<number[]>([]);
  const [quickEditImageSrc, setQuickEditImageSrc] = useState('');
  const quickEditTaskTimersRef = useRef<number[]>([]);
  const quickEditHistoryIdRef = useRef(0);
  /** Increment after mini-tool send/save to remount bottom toolbars and clear internal React state. */
  const [toolbarSessionKey, setToolbarSessionKey] = useState(0);

  const currentNode = useMemo(() => nodes.find((n) => n.id === nodeId), [nodeId, nodes]);
  const nodeData = (currentNode?.data as VideoNodeData | undefined) ?? {};
  const historyList = useMemo(() => {
    const raw = nodeData.history ?? [];
    return [...raw].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  }, [nodeData.history]);
  const canvasActiveHistoryId = nodeData.activeHistoryId ?? null;
  const activeHistoryId = canvasActiveHistoryId ?? historyList[0]?.id ?? null;
  const currentSelectedHistoryId = selectedHistoryId ?? activeHistoryId;
  const selectedHistoryItem = historyList.find((item) => item.id === currentSelectedHistoryId) ?? historyList[0];
  const videoSrc = selectedHistoryItem?.url ?? '';
  const activeHistoryIndex = historyList.findIndex((item) => item.id === selectedHistoryItem?.id);
  const canUndo = activeHistoryIndex < historyList.length - 1 && activeHistoryIndex >= 0;
  const canRedo = activeHistoryIndex > 0;
  const videoWidth = Math.max(1, Number(selectedHistoryItem?.width ?? 16));
  const videoHeight = Math.max(1, Number(selectedHistoryItem?.height ?? 9));

  const zoomPercent = useMemo(() => Math.round(zoomFactor * 100), [zoomFactor]);
  const historyPanelItems: VideoHistoryItem[] = useMemo(
    () =>
      historyList.map((item) => ({
        id: item.id,
        src: item.cover ?? item.url ?? '',
        status: item.status,
        errorMessage: item.errorMessage,
      })),
    [historyList],
  );

  useEffect(() => {
    setZoomInput(String(zoomPercent));
  }, [zoomPercent]);

  useEffect(() => {
    setHostHistoryId(canvasActiveHistoryId);
  }, [canvasActiveHistoryId]);

  useEffect(() => {
    if (historyList.length === 0) {
      setSelectedHistoryId(null);
      return;
    }
    if (!selectedHistoryId) {
      setSelectedHistoryId(activeHistoryId);
      return;
    }
    const exists = historyList.some((item) => item.id === selectedHistoryId);
    if (!exists) {
      setSelectedHistoryId(activeHistoryId);
    }
  }, [activeHistoryId, historyList, selectedHistoryId]);

  useEffect(() => {
    const shell = canvasShellRef.current;
    if (!shell) return;
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      setZoomFactor((prev) => {
        const next = event.deltaY < 0 ? prev * 1.08 : prev / 1.08;
        return Math.max(0.2, Math.min(1, next));
      });
    };
    shell.addEventListener('wheel', handleWheel, { passive: false });
    return () => shell.removeEventListener('wheel', handleWheel);
  }, []);

  const handleZoomOut = () => setZoomFactor((prev) => Math.max(0.2, prev / 1.08));

  const handleZoomIn = () => setZoomFactor((prev) => Math.min(1, prev * 1.08));

  const applyZoomInput = () => {
    const normalized = zoomInput.trim().replace('%', '');
    const nextPercent = Number(normalized);
    if (!Number.isFinite(nextPercent)) {
      setZoomInput(String(zoomPercent));
      return;
    }
    const clampedPercent = Math.max(20, Math.min(100, Math.round(nextPercent)));
    setZoomFactor(clampedPercent / 100);
    setZoomInput(String(clampedPercent));
  };

  const handleZoomPercentInputChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const digits = event.target.value.replace(/[^\d]/g, '');
    setZoomInput(digits);
  };

  const handleZoomPercentInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      applyZoomInput();
    }
  };

  const handleApplyHistoryToNode = () => {
    if (!selectedHistoryItem) return;
    setActiveHistoryId(nodeId, selectedHistoryItem.id);
    setHostHistoryId(selectedHistoryItem.id);
  };

  const handleUndo = () => {
    if (!canUndo) return;
    const nextItem = historyList[activeHistoryIndex + 1];
    if (!nextItem) return;
    setActiveHistoryId(nodeId, nextItem.id);
  };

  const handleRedo = () => {
    if (!canRedo) return;
    const nextItem = historyList[activeHistoryIndex - 1];
    if (!nextItem) return;
    setActiveHistoryId(nodeId, nextItem.id);
  };

  useEffect(() => {
    setPlaybackSnapshot({
      currentTime: 0,
      duration: 0,
      isPlaying: false,
      volume: 1,
    });
  }, [videoSrc]);

  useEffect(() => {
    const el = videoFrameRef.current;
    if (!el) return;
    const updateSize = () => {
      // Use layout size before CSS transform scale, so crop geometry stays
      // in the same coordinate space as overlay drawing.
      const width = Math.round(el.offsetWidth || el.clientWidth || el.getBoundingClientRect().width);
      const height = Math.round(el.offsetHeight || el.clientHeight || el.getBoundingClientRect().height);
      setVideoFrameSize({ width, height });
    };
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(el);
    return () => observer.disconnect();
  }, [videoSrc, zoomFactor]);

  useEffect(() => {
    if (videoFrameSize.width <= 0 || videoFrameSize.height <= 0) return;
    setCropRect({
      x: 0,
      y: 0,
      w: Math.round(videoFrameSize.width),
      h: Math.round(videoFrameSize.height),
    });
    setSceneExtensionFrame({
      w: Math.round(videoFrameSize.width),
      h: Math.round(videoFrameSize.height),
      ox: 0,
      oy: 0,
    });
  }, [videoFrameSize.width, videoFrameSize.height, selectedHistoryItem?.id]);

  useEffect(() => {
    const prevTool = prevToolRef.current;
    prevToolRef.current = activeTool;
    if (activeTool !== 'scene-extension' || prevTool === 'scene-extension') return;
    if (videoFrameSize.width <= 0 || videoFrameSize.height <= 0) return;
    const pad = 40;
    const cw = Math.max(1, Math.round(videoFrameSize.width));
    const ch = Math.max(1, Math.round(videoFrameSize.height));
    setSceneExtensionFrame({
      w: cw + pad * 2,
      h: ch + pad * 2,
      ox: -pad,
      oy: -pad,
    });
  }, [activeTool, videoFrameSize.width, videoFrameSize.height]);

  useEffect(() => {
    if (activeTool !== 'erase') {
      setEraseDraft(null);
      eraseDrawStartRef.current = null;
      eraseInteractionRef.current = null;
      setEraseBoxes([]);
      erasePendingTimersRef.current.forEach((timer) => window.clearTimeout(timer));
      erasePendingTimersRef.current = [];
      setErasePendingPicks([]);
    }
  }, [activeTool]);

  useEffect(() => {
    if (activeTool === 'quick-edit') return;
    quickEditPickTimersRef.current.forEach((timer) => window.clearTimeout(timer));
    quickEditPickTimersRef.current = [];
    setQuickEditPickEnabled(false);
    setQuickEditPickBoxes([]);
    setQuickEditPendingPicks([]);
  }, [activeTool]);

  useEffect(
    () => () => {
      erasePendingTimersRef.current.forEach((timer) => window.clearTimeout(timer));
      erasePendingTimersRef.current = [];
      quickEditPickTimersRef.current.forEach((timer) => window.clearTimeout(timer));
      quickEditPickTimersRef.current = [];
      quickEditTaskTimersRef.current.forEach((timer) => window.clearTimeout(timer));
      quickEditTaskTimersRef.current = [];
    },
    [],
  );

  const createQuickEditHistoryId = () => {
    quickEditHistoryIdRef.current += 1;
    return `video-quick-edit-${Date.now()}-${quickEditHistoryIdRef.current}`;
  };

  const updateHistoryItemStatus = (targetNodeId: string, targetHistoryId: string, status: 'loading' | 'done' | 'failed') => {
    const mgr = getCanvasYjsManager();
    if (!mgr?.synced) return;
    const nodeMap = mgr.nodesMap.get(targetNodeId) as Y.Map<unknown> | undefined;
    if (!(nodeMap instanceof Y.Map)) return;
    mgr.doc.transact(() => {
      const dataMap = nodeMap.get('data') as Y.Map<unknown> | undefined;
      if (!(dataMap instanceof Y.Map)) return;
      const history = dataMap.get('history') as Y.Array<unknown> | undefined;
      if (!(history instanceof Y.Array)) return;
      const hit = history.toArray().find((entry) => {
        if (!(entry instanceof Y.Map)) return false;
        return entry.get('id') === targetHistoryId;
      }) as Y.Map<unknown> | undefined;
      if (!(hit instanceof Y.Map)) return;
      hit.set('status', status);
      hit.delete('errorMessage');
    }, getUserOrigin());
  };

  const handleQuickEditSend = (content: string) => {
    if (!nodeId || !selectedHistoryItem) return;
    enqueueVideoToolHistoryTask('video.quick-edit', content);
  };

  const enqueueVideoToolHistoryTask = (tool: string, prompt?: string, delayMs = 1800) => {
    if (!nodeId || !selectedHistoryItem) return;
    const baseUrl = selectedHistoryItem.url || videoSrc;
    if (!baseUrl) return;
    resetEditorMiniToolToolbar(activeTool);
    const loadingId = createQuickEditHistoryId();
    const loadingItem: HistoryItem = {
      id: loadingId,
      url: baseUrl,
      cover: selectedHistoryItem.cover ?? baseUrl,
      width: selectedHistoryItem.width,
      height: selectedHistoryItem.height,
      duration: selectedHistoryItem.duration,
      by: selectedHistoryItem.by ?? { userId: 'local', username: 'local' },
      createdAt: Date.now(),
      source: 'editor-mini-tool',
      tool,
      prompt,
      status: 'loading',
    };
    pushHistoryItem(nodeId, loadingItem);
    setSelectedHistoryId(loadingId);
    const timer = window.setTimeout(() => {
      updateHistoryItemStatus(nodeId, loadingId, 'done');
      setSelectedHistoryId(loadingId);
      quickEditTaskTimersRef.current = quickEditTaskTimersRef.current.filter((entry) => entry !== timer);
    }, delayMs);
    quickEditTaskTimersRef.current.push(timer);
  };

  const closeActiveTool = () => setActiveTool(null);

  const sendVideoMiniTool = (tool: string) => () => {
    enqueueVideoToolHistoryTask(tool);
  };

  const handleHistoryRetry = (_index: number, item: VideoHistoryItem) => {
    if (!nodeId) return;
    updateHistoryItemStatus(nodeId, item.id, 'loading');
    const timer = window.setTimeout(() => {
      updateHistoryItemStatus(nodeId, item.id, 'done');
      quickEditTaskTimersRef.current = quickEditTaskTimersRef.current.filter((entry) => entry !== timer);
    }, 1200);
    quickEditTaskTimersRef.current.push(timer);
  };

  const handleExitCrop = () => {
    setCropRect({
      x: 0,
      y: 0,
      w: Math.max(1, Math.round(videoFrameSize.width)),
      h: Math.max(1, Math.round(videoFrameSize.height)),
    });
    setActiveTool(null);
  };

  const handleCropToolbarDimensionChange = (w: number, h: number, keepCentered?: boolean) => {
    setCropRect((prev) => {
      const maxW = Math.max(1, videoFrameSize.width);
      const maxH = Math.max(1, videoFrameSize.height);
      const nextW = Math.max(20, Math.min(w, maxW));
      const nextH = Math.max(20, Math.min(h, maxH));
      if (keepCentered) {
        const cx = prev.x + prev.w / 2;
        const cy = prev.y + prev.h / 2;
        return {
          x: Math.max(0, Math.min(cx - nextW / 2, maxW - nextW)),
          y: Math.max(0, Math.min(cy - nextH / 2, maxH - nextH)),
          w: nextW,
          h: nextH,
        };
      }
      return {
        x: Math.max(0, Math.min(prev.x, maxW - nextW)),
        y: Math.max(0, Math.min(prev.y, maxH - nextH)),
        w: nextW,
        h: nextH,
      };
    });
  };

  const handleSceneExtensionToolbarDimensionChange = (w: number, h: number, keepCentered?: boolean) => {
    const maxW = Math.max(1, videoFrameSize.width);
    const maxH = Math.max(1, videoFrameSize.height);
    const nextW = Math.max(maxW, Math.min(w, maxW * 2));
    const nextH = Math.max(maxH, Math.min(h, maxH * 2));
    if (keepCentered) {
      setSceneExtensionFrame((prev) => ({
        ...prev,
        w: nextW,
        h: nextH,
        ox: (maxW - nextW) / 2,
        oy: (maxH - nextH) / 2,
      }));
      return;
    }
    setSceneExtensionFrame((prev) => ({ ...prev, w: nextW, h: nextH }));
  };

  const handleQuickEditCanvasPick = (event: React.MouseEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const rawXPct = ((event.clientX - rect.left) / rect.width) * 100;
    const rawYPct = ((event.clientY - rect.top) / rect.height) * 100;
    const wPct = 26;
    const hPct = 26;
    const halfW = wPct / 2;
    const halfH = hPct / 2;
    const cxPct = Math.min(100 - halfW, Math.max(halfW, rawXPct));
    const cyPct = Math.min(100 - halfH, Math.max(halfH, rawYPct));
    const id = `video-quick-pick-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const pendingPick = { id, cxPct, cyPct, wPct, hPct };
    setQuickEditPendingPicks((prev) => [...prev, pendingPick]);
    const timer = window.setTimeout(() => {
      setQuickEditPendingPicks((prev) => prev.filter((pick) => pick.id !== id));
      setQuickEditPickBoxes((prev) => [...prev, { ...pendingPick, name: recognizedOverlayPresets[0].label }]);
    }, 1200);
    quickEditPickTimersRef.current.push(timer);
  };

  const handleQuickEditRemovePickBox = (id: string) => {
    setQuickEditPendingPicks((prev) => prev.filter((item) => item.id !== id));
    setQuickEditPickBoxes((prev) => prev.filter((item) => item.id !== id));
  };

  const handleQuickEditPickPresetSelect = (boxId: string, presetKey: string) => {
    const preset = recognizedOverlayPresets.find((item) => item.key === presetKey);
    if (!preset) return;
    setQuickEditPickBoxes((prev) =>
      prev.map((item) =>
        item.id === boxId
          ? {
            ...item,
            name: preset.label,
            cxPct: preset.cxPct,
            cyPct: preset.cyPct,
            wPct: preset.wPct,
            hPct: preset.hPct,
          }
          : item,
      ),
    );
  };

  const scheduleEraseIdentifying = (payload: { xPct: number; yPct: number; wPct: number; hPct: number; tool: 'rectangle' | 'circle' }) => {
    const pendingId = `erase-pending-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    erasePendingTimersRef.current.forEach((timer) => window.clearTimeout(timer));
    erasePendingTimersRef.current = [];
    setErasePendingPicks([{ id: pendingId, xPct: payload.xPct, yPct: payload.yPct, tool: payload.tool }]);
    setEraseBoxes([]);
    const timer = window.setTimeout(() => {
      setErasePendingPicks((prev) => (prev.some((item) => item.id === pendingId) ? [] : prev));
      setEraseBoxes([
        {
          id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
          cxPct: payload.xPct,
          cyPct: payload.yPct,
          wPct: payload.wPct,
          hPct: payload.hPct,
          maskShape: payload.tool,
        },
      ]);
      erasePendingTimersRef.current = erasePendingTimersRef.current.filter((item) => item !== timer);
    }, 900);
    erasePendingTimersRef.current.push(timer);
  };

  const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
  const eraseMinSizePct = 1.5;

  const applyBoxInteraction = (event: React.MouseEvent<HTMLDivElement>) => {
    const interaction = eraseInteractionRef.current;
    if (!interaction) return false;
    const rect = event.currentTarget.getBoundingClientRect();
    if (!rect.width || !rect.height) return true;
    const x = ((event.clientX - rect.left) / rect.width) * 100;
    const y = ((event.clientY - rect.top) / rect.height) * 100;
    const dx = x - interaction.startX;
    const dy = y - interaction.startY;

    setEraseBoxes((prev) =>
      prev.map((box) => {
        if (box.id !== interaction.boxId) return box;
        const startLeft = interaction.startCx - interaction.startW / 2;
        const startRight = interaction.startCx + interaction.startW / 2;
        const startTop = interaction.startCy - interaction.startH / 2;
        const startBottom = interaction.startCy + interaction.startH / 2;

        if (interaction.mode === 'move') {
          const nextCx = clamp(interaction.startCx + dx, box.wPct / 2, 100 - box.wPct / 2);
          const nextCy = clamp(interaction.startCy + dy, box.hPct / 2, 100 - box.hPct / 2);
          return { ...box, cxPct: nextCx, cyPct: nextCy };
        }

        let left = startLeft;
        let right = startRight;
        let top = startTop;
        let bottom = startBottom;
        const handle = interaction.handle;
        if (!handle) return box;

        if (handle.includes('left')) left = clamp(startLeft + dx, 0, right - eraseMinSizePct);
        if (handle.includes('right')) right = clamp(startRight + dx, left + eraseMinSizePct, 100);
        if (handle.includes('top')) top = clamp(startTop + dy, 0, bottom - eraseMinSizePct);
        if (handle.includes('bottom')) bottom = clamp(startBottom + dy, top + eraseMinSizePct, 100);
        if (interaction.shape === 'circle') {
          if (handle === 'left' || handle === 'right') {
            top = startTop;
            bottom = startBottom;
          } else {
            left = startLeft;
            right = startRight;
          }
        }
        return {
          ...box,
          cxPct: (left + right) / 2,
          cyPct: (top + bottom) / 2,
          wPct: Math.max(eraseMinSizePct, right - left),
          hPct: Math.max(eraseMinSizePct, bottom - top),
        };
      }),
    );
    return true;
  };

  const eraseTrackingSegments = useMemo<EraseTrackingSegment[]>(() => {
    const duration = playbackSnapshot.duration;
    if (duration <= 0 || eraseBoxes.length === 0) return [];
    const lead = Math.max(0.6, duration * 0.08);
    const unclearLen = Math.max(0.8, duration * 0.14);
    const lostLen = Math.max(0.8, duration * 0.1);
    const unclearStart = clamp(duration - (unclearLen + lostLen + lead), 0, duration);
    const unclearEnd = clamp(unclearStart + unclearLen, 0, duration);
    const lostStart = clamp(unclearEnd, 0, duration);
    const segments: EraseTrackingSegment[] = [
      { startSec: 0, endSec: unclearStart, status: 'confirm', boxes: eraseBoxes },
      { startSec: unclearStart, endSec: unclearEnd, status: 'unclear', boxes: [] },
      { startSec: lostStart, endSec: duration, status: 'lost', boxes: [] },
    ];
    return segments.filter((segment) => segment.endSec > segment.startSec);
  }, [eraseBoxes, playbackSnapshot.duration]);

  const currentEraseTrackingStatus = useMemo<'confirm' | 'unclear' | 'lost' | null>(() => {
    const duration = playbackSnapshot.duration;
    if (duration <= 0 || eraseTrackingSegments.length === 0) return null;
    const t = clamp(playbackSnapshot.currentTime, 0, duration);
    const seg = eraseTrackingSegments.find((item) => t >= item.startSec && t <= item.endSec);
    return seg?.status ?? eraseTrackingSegments[eraseTrackingSegments.length - 1]?.status ?? null;
  }, [eraseTrackingSegments, playbackSnapshot.currentTime, playbackSnapshot.duration]);
  const showEraseLostOverlay = activeTool === 'erase' && currentEraseTrackingStatus === 'lost';

  const handleEraseSurfaceMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (eraseInteractionRef.current) return;
    if (eraseMaskTool === 'selection') {
      const rect = e.currentTarget.getBoundingClientRect();
      const rawXPct = ((e.clientX - rect.left) / rect.width) * 100;
      const rawYPct = ((e.clientY - rect.top) / rect.height) * 100;
      const wPct = 26;
      const hPct = 26;
      const halfW = wPct / 2;
      const halfH = hPct / 2;
      const xPct = Math.min(100 - halfW, Math.max(halfW, rawXPct));
      const yPct = Math.min(100 - halfH, Math.max(halfH, rawYPct));
      scheduleEraseIdentifying({ xPct, yPct, wPct, hPct, tool: 'rectangle' });
      e.preventDefault();
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    const y = ((e.clientY - rect.top) / rect.height) * 100;
    eraseDrawStartRef.current = { x, y };
    const tool = eraseMaskTool === 'circle' ? 'circle' : 'rectangle';
    setEraseDraft({ cxPct: x, cyPct: y, wPct: 0.01, hPct: 0.01, tool });
    e.preventDefault();
  };

  const handleEraseSurfaceMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (applyBoxInteraction(e)) return;
    const start = eraseDrawStartRef.current;
    if (!start) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    const y = ((e.clientY - rect.top) / rect.height) * 100;
    const left = Math.min(start.x, x);
    const top = Math.min(start.y, y);
    const right = Math.max(start.x, x);
    const bottom = Math.max(start.y, y);
    setEraseDraft((prev) => ({
      cxPct: (left + right) / 2,
      cyPct: (top + bottom) / 2,
      wPct: Math.max(0.01, right - left),
      hPct: Math.max(0.01, bottom - top),
      tool: prev?.tool ?? (eraseMaskTool === 'circle' ? 'circle' : 'rectangle'),
    }));
  };

  const handleEraseSurfaceMouseUp = () => {
    if (eraseInteractionRef.current) {
      eraseInteractionRef.current = null;
      return;
    }
    const draft = eraseDraft;
    if (draft && draft.wPct > 0.2 && draft.hPct > 0.2) {
      scheduleEraseIdentifying({
        xPct: draft.cxPct,
        yPct: draft.cyPct,
        wPct: draft.wPct,
        hPct: draft.hPct,
        tool: draft.tool,
      });
    }
    eraseDrawStartRef.current = null;
    setEraseDraft(null);
  };

  const handleEraseSurfaceMouseLeave = () => {
    if (eraseInteractionRef.current) {
      eraseInteractionRef.current = null;
    }
    if (!eraseDrawStartRef.current) return;
    eraseDrawStartRef.current = null;
    setEraseDraft(null);
  };

  const handleEraseLostOverlayReselect = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const currentBox = eraseBoxes[0];
    if (!currentBox) return;
    scheduleEraseIdentifying({
      xPct: currentBox.cxPct,
      yPct: currentBox.cyPct,
      wPct: currentBox.wPct,
      hPct: currentBox.hPct,
      tool: currentBox.maskShape,
    });
    setEraseMaskTool(currentBox.maskShape === 'circle' ? 'circle' : 'rectangle');
  };

  const handleEraseTrackedBoxMoveStart = (box: EraseOverlayBox, e: React.MouseEvent<HTMLDivElement>) => {
    const parent = e.currentTarget.parentElement;
    if (!parent) return;
    const rect = parent.getBoundingClientRect();
    eraseInteractionRef.current = {
      mode: 'move',
      boxId: box.id,
      shape: box.maskShape,
      startX: ((e.clientX - rect.left) / rect.width) * 100,
      startY: ((e.clientY - rect.top) / rect.height) * 100,
      startCx: box.cxPct,
      startCy: box.cyPct,
      startW: box.wPct,
      startH: box.hPct,
    };
    e.preventDefault();
    e.stopPropagation();
  };

  const handleEraseTrackedBoxResizeStart = (
    box: EraseOverlayBox,
    direction:
      | 'top'
      | 'bottom'
      | 'left'
      | 'right'
      | 'top-left'
      | 'top-right'
      | 'bottom-left'
      | 'bottom-right',
    e: React.MouseEvent<HTMLDivElement>,
  ) => {
    const outer = e.currentTarget.parentElement?.parentElement;
    if (!outer) return;
    const rect = outer.getBoundingClientRect();
    eraseInteractionRef.current = {
      mode: 'resize',
      boxId: box.id,
      shape: box.maskShape,
      handle: direction,
      startX: ((e.clientX - rect.left) / rect.width) * 100,
      startY: ((e.clientY - rect.top) / rect.height) * 100,
      startCx: box.cxPct,
      startCy: box.cyPct,
      startW: box.wPct,
      startH: box.hPct,
    };
    e.preventDefault();
    e.stopPropagation();
  };

  const captureQuickEditPreview = () => {
    const fallbackSrc = selectedHistoryItem?.cover ?? '';
    const videoEl = videoRef.current?.getHtmlVideoElement();
    if (!videoEl || videoEl.videoWidth <= 0 || videoEl.videoHeight <= 0) {
      setQuickEditImageSrc(fallbackSrc);
      return;
    }
    const targetWidth = Math.min(1024, Math.max(1, videoEl.videoWidth));
    const targetHeight = Math.max(1, Math.round((targetWidth / videoEl.videoWidth) * videoEl.videoHeight));
    const canvas = document.createElement('canvas');
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      setQuickEditImageSrc(fallbackSrc);
      return;
    }
    try {
      ctx.drawImage(videoEl, 0, 0, targetWidth, targetHeight);
      setQuickEditImageSrc(canvas.toDataURL('image/jpeg', 0.92));
    } catch {
      setQuickEditImageSrc(fallbackSrc);
    }
  };

  /**
   * Clears tool-specific overlay / draft state and remounts the active bottom toolbar
   * so internal UI (sliders, cut markers, composer uploads) resets after send/save.
   *
   * @param editorTool — Active editor tool when the mini-tool was submitted.
   */
  const resetEditorMiniToolToolbar = (editorTool: VideoEditorToolKey | null) => {
    setToolbarSessionKey((k) => k + 1);
    if (!editorTool) return;
    switch (editorTool) {
      case 'quick-edit': {
        quickEditPickTimersRef.current.forEach((timer) => window.clearTimeout(timer));
        quickEditPickTimersRef.current = [];
        setQuickEditPickEnabled(false);
        setQuickEditPickBoxes([]);
        setQuickEditPendingPicks([]);
        window.requestAnimationFrame(() => {
          captureQuickEditPreview();
        });
        break;
      }
      case 'erase': {
        erasePendingTimersRef.current.forEach((timer) => window.clearTimeout(timer));
        erasePendingTimersRef.current = [];
        setErasePendingPicks([]);
        setEraseBoxes([]);
        setEraseDraft(null);
        eraseDrawStartRef.current = null;
        eraseInteractionRef.current = null;
        setEraseMaskTool('selection');
        break;
      }
      case 'crop': {
        const w = Math.max(1, Math.round(videoFrameSize.width));
        const h = Math.max(1, Math.round(videoFrameSize.height));
        setCropRect({ x: 0, y: 0, w, h });
        break;
      }
      case 'scene-extension': {
        if (videoFrameSize.width <= 0 || videoFrameSize.height <= 0) break;
        const pad = 40;
        const cw = Math.max(1, Math.round(videoFrameSize.width));
        const ch = Math.max(1, Math.round(videoFrameSize.height));
        setSceneExtensionFrame({
          w: cw + pad * 2,
          h: ch + pad * 2,
          ox: -pad,
          oy: -pad,
        });
        break;
      }
      default:
        break;
    }
  };

  const handleRightToolPanelSelect = (tool: VideoEditorToolKey) => {
    setActiveTool((prev) => (prev === tool ? null : tool));
    if (tool === 'quick-edit') {
      setZoomFactor(1);
      captureQuickEditPreview();
    }
  };

  if (!nodeId) {
    return (
      <div className='flex h-full w-full min-h-0 min-w-0 items-center justify-center bg-[#f3f4f6] text-sm text-[#6b7280]'>
        Missing node id
      </div>
    );
  }

  return (
    <div className='flex h-full w-full min-h-0 min-w-0 flex-col bg-[#f2f3f5]'>
      <div className='grid min-h-0 flex-1 grid-cols-[200px_minmax(0,1fr)_64px] divide-x divide-[#e6e8ec]'>
        <LeftHistoryPanel
          historyList={historyPanelItems}
          activeIndex={Math.max(0, historyPanelItems.findIndex((item) => item.id === currentSelectedHistoryId))}
          hostHistoryId={hostHistoryId}
          onSelect={(_index, item) => setSelectedHistoryId(item.id)}
          onRetry={handleHistoryRetry}
        />

        <div className='flex min-h-0 h-full flex-col bg-background-default-secondary'>
          <div className='flex min-h-0 flex-1 items-center justify-center bg-[#f6f8fb] p-3'>
            <div
              ref={canvasShellRef}
              className='relative h-full w-full overflow-hidden rounded-lg bg-[#f6f8fb]'
            >
              <div className={`flex h-full w-full items-center justify-center ${activeTool === 'scene-extension' ? 'overflow-visible' : 'overflow-hidden'}`}>
                <div
                  className='relative w-full'
                  ref={videoFrameRef}
                  style={{
                    transform: `scale(${zoomFactor})`,
                    transformOrigin: 'center center',
                    aspectRatio: `${videoWidth} / ${videoHeight}`,
                    maxHeight: '100%',
                    maxWidth: '100%',
                  }}
                >
                  {videoSrc ? (
                    <Video
                      ref={videoRef}
                      src={videoSrc}
                      showControlBar={false}
                      onPlaybackUpdate={setPlaybackSnapshot}
                      className='!rounded-none !bg-transparent'
                    />
                  ) : (
                    <div className='h-full w-full' />
                  )}
                  {videoSrc && activeTool === 'crop' && videoFrameSize.width > 0 && videoFrameSize.height > 0 && (
                    <CropOverlay
                      containerWidth={videoFrameSize.width}
                      containerHeight={videoFrameSize.height}
                      viewportScale={zoomFactor}
                      value={cropRect}
                      onChange={setCropRect}
                    />
                  )}
                  {videoSrc && activeTool === 'scene-extension' && videoFrameSize.width > 0 && videoFrameSize.height > 0 && (
                    <SceneExtensionOverlay
                      containerWidth={videoFrameSize.width}
                      containerHeight={videoFrameSize.height}
                      viewportScale={zoomFactor}
                      outerWidth={sceneExtensionFrame.w}
                      outerHeight={sceneExtensionFrame.h}
                      originX={sceneExtensionFrame.ox}
                      originY={sceneExtensionFrame.oy}
                      onFrameChange={setSceneExtensionFrame}
                    />
                  )}
                  {videoSrc && activeTool === 'erase' && videoFrameSize.width > 0 && videoFrameSize.height > 0 && (
                    <div
                      className='absolute inset-0 z-20'
                      onMouseDown={handleEraseSurfaceMouseDown}
                      onMouseMove={handleEraseSurfaceMouseMove}
                      onMouseUp={handleEraseSurfaceMouseUp}
                      onMouseLeave={handleEraseSurfaceMouseLeave}
                    >
                      {!showEraseLostOverlay && (
                        <TrackedBoxesOverlay
                          boxes={eraseBoxes}
                          draftBox={eraseDraft}
                          onBoxMouseDown={handleEraseTrackedBoxMoveStart}
                          onResizeHandleMouseDown={handleEraseTrackedBoxResizeStart}
                        />
                      )}
                      {erasePendingPicks.map((item) => (
                        <div
                          key={item.id}
                          className='pointer-events-none absolute'
                          style={{
                            left: `${item.xPct}%`,
                            top: `${item.yPct}%`,
                            transform: `translate(-50%, calc(-100% - 10px)) scale(${1 / Math.max(0.0001, zoomFactor)})`,
                            transformOrigin: 'bottom center',
                          }}
                        >
                          <div className='inline-flex h-[20px] items-center gap-1.5 rounded-full border border-[#DBDBDB] bg-background-default-base px-2 shadow-[0_1px_3px_rgba(0,0,0,0.08)]'>
                            <span className='block h-2.5 w-2.5 shrink-0 animate-spin rounded-full border border-[var(--color-icon-base)] border-t-transparent' />
                            <span className='text-[10px] leading-none font-medium text-text-default-base whitespace-nowrap'>Identifying...</span>
                          </div>
                        </div>
                      ))}
                      {showEraseLostOverlay && (
                        <div className='absolute inset-0 z-[26] flex items-center justify-center bg-black/45 backdrop-blur-[1px]'>
                          <button
                            type='button'
                            className='pointer-events-auto inline-flex h-9 items-center gap-2 rounded-md border border-white/40 bg-black/50 px-3 text-xs font-medium text-white backdrop-blur-sm hover:bg-black/65'
                            style={{
                              transform: `scale(${1 / Math.max(0.0001, zoomFactor)})`,
                              transformOrigin: 'center center',
                            }}
                            onClick={handleEraseLostOverlayReselect}
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
                  )}
                  {videoSrc && activeTool === 'quick-edit' && quickEditPickEnabled && (
                    <div
                      className='absolute inset-0 z-20 cursor-crosshair'
                      role='button'
                      tabIndex={0}
                      aria-label='Video quick edit pick surface'
                      onClick={handleQuickEditCanvasPick}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                        }
                      }}
                    >
                      {quickEditPendingPicks.map((box) => (
                        <div
                          key={`pending-${box.id}`}
                          className='pointer-events-none absolute'
                          style={{
                            left: `${box.cxPct}%`,
                            top: `${box.cyPct}%`,
                            transform: `translate(-50%, calc(-100% - 10px)) scale(${1 / Math.max(0.0001, zoomFactor)})`,
                            transformOrigin: 'bottom center',
                          }}
                        >
                          <div className='inline-flex h-[20px] items-center gap-1.5 rounded-full border border-[#DBDBDB] bg-background-default-base px-2 shadow-[0_1px_3px_rgba(0,0,0,0.08)]'>
                            <span className='block h-2.5 w-2.5 shrink-0 animate-spin rounded-full border border-[var(--color-icon-base)] border-t-transparent' />
                            <span className='text-[10px] leading-none font-medium text-text-default-base whitespace-nowrap'>Identifying...</span>
                          </div>
                        </div>
                      ))}
                      {quickEditPickBoxes.map((box) => (
                        <div
                          key={box.id}
                          className='absolute border border-[#A5A6F6] bg-[rgba(109,124,255,0.14)]'
                          style={{
                            left: `${box.cxPct - box.wPct / 2}%`,
                            top: `${box.cyPct - box.hPct / 2}%`,
                            width: `${box.wPct}%`,
                            height: `${box.hPct}%`,
                          }}
                        >
                          <div
                            className='absolute -left-1 -top-8 z-[8] pointer-events-auto'
                            style={{
                              transform: `scale(${1 / Math.max(0.0001, zoomFactor)})`,
                              transformOrigin: 'bottom left',
                            }}
                          >
                            <RecognizedPickDropdown
                              currentLabel={box.name}
                              options={recognizedOverlayPresets.map((item) => ({ key: item.key, label: item.label }))}
                              onSelect={(presetKey) => handleQuickEditPickPresetSelect(box.id, presetKey)}
                            />
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
              <div className='pointer-events-none absolute left-1/2 top-3 z-10 -translate-x-1/2'>
                <div className='pointer-events-auto flex items-center gap-1 rounded-xl bg-background-default-base px-[4px] py-[6px] shadow-[0px_4px_16px_-1px_rgba(12,12,13,0.05),0px_4px_4px_-1px_rgba(12,12,13,0.05),0px_1px_8px_1px_rgba(12,12,13,0.05)]'>
                  <Tooltip title='Apply to Node' placement='bottom' offset={4}>
                    <button
                      type='button'
                      className='flex h-9 w-9 items-center justify-center rounded-[6px] text-icon-base transition-colors hover:bg-background-default-base-hover'
                      aria-label='Apply to Node'
                      onClick={handleApplyHistoryToNode}
                    >
                      <Icon name='project-chat-generated-add-to-input-icon' width={20} height={20} />
                    </button>
                  </Tooltip>
                  <Tooltip title='Create New Node' placement='bottom' offset={4}>
                    <button
                      type='button'
                      className='flex h-9 w-9 items-center justify-center rounded-[6px] text-icon-base transition-colors hover:bg-background-default-base-hover'
                      aria-label='Create New Node'
                      onClick={() => void 0}
                    >
                      <Icon name='project-create-new-node-icon' width={20} height={20} />
                    </button>
                  </Tooltip>
                  <Divider type='vertical' className='mx-1 h-5 bg-[#D0D0D0]' />
                  <Tooltip title='Location' placement='bottom' offset={4}>
                    <button
                      type='button'
                      className='flex h-9 w-9 items-center justify-center rounded-[6px] text-icon-base transition-colors hover:bg-background-default-base-hover'
                      aria-label='Location'
                      onClick={() => void 0}
                    >
                      <Icon name='project-image-editor-right-expand-corner-icon' width={20} height={20} />
                    </button>
                  </Tooltip>
                </div>
              </div>
              <div className='pointer-events-none absolute bottom-3 right-3 z-10'>
                <div className='pointer-events-auto flex items-center gap-2'>
                  <div className='flex h-8 items-center overflow-hidden rounded-md border border-[#d7dce3] bg-background-default-secondary shadow-[0_1px_3px_rgba(0,0,0,0.08)]'>
                    <button
                      type='button'
                      aria-label='Zoom out'
                      onClick={handleZoomOut}
                      className='flex h-8 w-8 items-center justify-center transition-colors hover:bg-[#f3f4f6]'
                    >
                      <RiSubtractLine className='h-[14px] w-[14px] text-[var(--color-icon-secondary)]' />
                    </button>
                    <div className='h-5 w-px bg-[#d7dce3]' />
                    <div className='flex min-w-[52px] items-center justify-center px-1'>
                      <input
                        type='text'
                        inputMode='numeric'
                        aria-label='Zoom percent'
                        value={zoomInput}
                        onChange={handleZoomPercentInputChange}
                        onBlur={applyZoomInput}
                        onKeyDown={handleZoomPercentInputKeyDown}
                        className='w-[34px] bg-transparent text-center text-[12px] font-medium text-text-default-secondary outline-none'
                      />
                      <span className='text-[12px] font-medium text-text-default-secondary'>%</span>
                    </div>
                    <div className='h-5 w-px bg-[#d7dce3]' />
                    <button
                      type='button'
                      aria-label='Zoom in'
                      onClick={handleZoomIn}
                      className='flex h-8 w-8 items-center justify-center transition-colors hover:bg-[#f3f4f6]'
                    >
                      <RiAddLine className='h-[14px] w-[14px] text-[var(--color-icon-secondary)]' />
                    </button>
                  </div>
                  <div className='flex h-8 items-center gap-2 rounded-md border border-[#d7dce3] bg-background-default-secondary p-0 shadow-[0_1px_3px_rgba(0,0,0,0.08)] backdrop-blur-sm'>
                    <button
                      type='button'
                      aria-label='Undo'
                      disabled={!canUndo}
                      onClick={handleUndo}
                      className='flex h-8 w-8 items-center justify-center rounded-md transition-colors hover:bg-[#f3f4f6] disabled:cursor-not-allowed disabled:opacity-40'
                    >
                      <Icon name='videoEditor-undo-icon' width={14} height={14} color='var(--color-icon-secondary)' />
                    </button>
                    <button
                      type='button'
                      aria-label='Redo'
                      disabled={!canRedo}
                      onClick={handleRedo}
                      className='flex h-8 w-8 items-center justify-center rounded-md transition-colors hover:bg-[#f3f4f6] disabled:cursor-not-allowed disabled:opacity-40'
                    >
                      <Icon name='videoEditor-redo-icon' width={14} height={14} color='var(--color-icon-secondary)' />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
          {activeTool && (
            <div className='flex min-h-[200px] justify-center overflow-hidden border-t border-[#e6e8ec] bg-background-default-secondary p-3'>
              {activeTool === 'cut' && (
                <CutBottomToolbar
                  key={toolbarSessionKey}
                  active
                  videoRef={videoRef}
                  mediaSrc={videoSrc}
                  currentTime={playbackSnapshot.currentTime}
                  duration={playbackSnapshot.duration}
                  isPlaying={playbackSnapshot.isPlaying}
                  volume={playbackSnapshot.volume}
                  onClose={closeActiveTool}
                  onSave={sendVideoMiniTool('video.cut')}
                />
              )}
              {activeTool === 'quick-edit' && (
                <QuickEditBottomToolbar
                  key={toolbarSessionKey}
                  active
                  videoRef={videoRef}
                  mediaSrc={videoSrc}
                  currentTime={playbackSnapshot.currentTime}
                  duration={playbackSnapshot.duration}
                  isPlaying={playbackSnapshot.isPlaying}
                  volume={playbackSnapshot.volume}
                  imageSrc={quickEditImageSrc}
                  pendingPicks={quickEditPendingPicks.map((item) => ({ id: item.id }))}
                  recognizedPicks={quickEditPickBoxes.map((item) => ({ id: item.id, name: item.name }))}
                  onStartPick={() => setQuickEditPickEnabled(true)}
                  onRemovePickBox={handleQuickEditRemovePickBox}
                  onClose={closeActiveTool}
                  onSend={handleQuickEditSend}
                />
              )}
              {activeTool === 'speed' && (
                <SpeedBottomToolbar
                  key={toolbarSessionKey}
                  active
                  videoRef={videoRef}
                  mediaSrc={videoSrc}
                  currentTime={playbackSnapshot.currentTime}
                  duration={playbackSnapshot.duration}
                  isPlaying={playbackSnapshot.isPlaying}
                  volume={playbackSnapshot.volume}
                  onClose={closeActiveTool}
                  onSave={sendVideoMiniTool('video.speed')}
                />
              )}
              {activeTool === 'upscale' && (
                <UpscaleBottomToolbar
                  key={toolbarSessionKey}
                  active
                  videoRef={videoRef}
                  mediaSrc={videoSrc}
                  currentTime={playbackSnapshot.currentTime}
                  duration={playbackSnapshot.duration}
                  isPlaying={playbackSnapshot.isPlaying}
                  volume={playbackSnapshot.volume}
                  onClose={closeActiveTool}
                  onSend={sendVideoMiniTool('video.upscale')}
                />
              )}
              {activeTool === 'interpolate' && (
                <InterpolateBottomToolbar
                  key={toolbarSessionKey}
                  active
                  videoRef={videoRef}
                  mediaSrc={videoSrc}
                  currentTime={playbackSnapshot.currentTime}
                  duration={playbackSnapshot.duration}
                  isPlaying={playbackSnapshot.isPlaying}
                  volume={playbackSnapshot.volume}
                  onClose={closeActiveTool}
                  onSend={sendVideoMiniTool('video.interpolate')}
                />
              )}
              {activeTool === 'erase' && (
                <EraseBottomToolbar
                  key={toolbarSessionKey}
                  active
                  videoRef={videoRef}
                  mediaSrc={videoSrc}
                  currentTime={playbackSnapshot.currentTime}
                  duration={playbackSnapshot.duration}
                  isPlaying={playbackSnapshot.isPlaying}
                  volume={playbackSnapshot.volume}
                  trackingPhase={erasePendingPicks.length > 0 || eraseBoxes.length > 0 ? 'tracking' : 'idle'}
                  trackingSegments={eraseTrackingSegments}
                  maskTool={eraseMaskTool}
                  onMaskToolChange={setEraseMaskTool}
                  canUndo={eraseBoxes.length > 0}
                  onUndo={() => setEraseBoxes((prev) => prev.slice(0, -1))}
                  onClose={closeActiveTool}
                  onSend={sendVideoMiniTool('video.erase')}
                />
              )}
              {activeTool === 'extend' && (
                <ExtendBottomToolbar
                  key={toolbarSessionKey}
                  active
                  videoRef={videoRef}
                  mediaSrc={videoSrc}
                  currentTime={playbackSnapshot.currentTime}
                  duration={playbackSnapshot.duration}
                  isPlaying={playbackSnapshot.isPlaying}
                  volume={playbackSnapshot.volume}
                  onClose={closeActiveTool}
                  onSend={sendVideoMiniTool('video.extend')}
                />
              )}
              {activeTool === 'animate' && (
                <AnimateBottomToolbar
                  key={toolbarSessionKey}
                  active
                  videoRef={videoRef}
                  mediaSrc={videoSrc}
                  currentTime={playbackSnapshot.currentTime}
                  duration={playbackSnapshot.duration}
                  isPlaying={playbackSnapshot.isPlaying}
                  volume={playbackSnapshot.volume}
                  onClose={closeActiveTool}
                  onSend={sendVideoMiniTool('video.animate')}
                />
              )}
              {activeTool === 'adjust' && (
                <AdjustBottomToolbar
                  key={toolbarSessionKey}
                  active
                  videoRef={videoRef}
                  mediaSrc={videoSrc}
                  currentTime={playbackSnapshot.currentTime}
                  duration={playbackSnapshot.duration}
                  isPlaying={playbackSnapshot.isPlaying}
                  volume={playbackSnapshot.volume}
                  onClose={closeActiveTool}
                  onSave={sendVideoMiniTool('video.adjust')}
                />
              )}
              {activeTool === 'stabilization' && (
                <StabilizationBottomToolbar
                  key={toolbarSessionKey}
                  active
                  videoRef={videoRef}
                  mediaSrc={videoSrc}
                  currentTime={playbackSnapshot.currentTime}
                  duration={playbackSnapshot.duration}
                  isPlaying={playbackSnapshot.isPlaying}
                  volume={playbackSnapshot.volume}
                  onClose={closeActiveTool}
                  onSend={sendVideoMiniTool('video.stabilization')}
                />
              )}
              {activeTool === 'crop' && (
                <CropBottomToolbar
                  key={toolbarSessionKey}
                  active
                  videoRef={videoRef}
                  mediaSrc={videoSrc}
                  currentTime={playbackSnapshot.currentTime}
                  duration={playbackSnapshot.duration}
                  isPlaying={playbackSnapshot.isPlaying}
                  volume={playbackSnapshot.volume}
                  width={Math.round(cropRect.w)}
                  height={Math.round(cropRect.h)}
                  containerWidth={Math.max(1, videoFrameSize.width)}
                  containerHeight={Math.max(1, videoFrameSize.height)}
                  onDimensionChange={handleCropToolbarDimensionChange}
                  onClose={handleExitCrop}
                  onSave={sendVideoMiniTool('video.crop')}
                />
              )}
              {activeTool === 'hdr-conversion' && (
                <HdrConversionBottomToolbar
                  key={toolbarSessionKey}
                  active
                  videoRef={videoRef}
                  mediaSrc={videoSrc}
                  currentTime={playbackSnapshot.currentTime}
                  duration={playbackSnapshot.duration}
                  isPlaying={playbackSnapshot.isPlaying}
                  volume={playbackSnapshot.volume}
                  onClose={closeActiveTool}
                  onSave={sendVideoMiniTool('video.hdr-conversion')}
                />
              )}
              {activeTool === 'scene-extension' && (
                <SceneExtensionBottomToolbar
                  key={toolbarSessionKey}
                  active
                  videoRef={videoRef}
                  mediaSrc={videoSrc}
                  currentTime={playbackSnapshot.currentTime}
                  duration={playbackSnapshot.duration}
                  isPlaying={playbackSnapshot.isPlaying}
                  volume={playbackSnapshot.volume}
                  width={Math.round(sceneExtensionFrame.w || videoFrameSize.width)}
                  height={Math.round(sceneExtensionFrame.h || videoFrameSize.height)}
                  containerWidth={Math.max(1, videoFrameSize.width)}
                  containerHeight={Math.max(1, videoFrameSize.height)}
                  onDimensionChange={handleSceneExtensionToolbarDimensionChange}
                  onClose={closeActiveTool}
                  onSend={sendVideoMiniTool('video.scene-extension')}
                />
              )}
              {activeTool === 'audio-denoise' && (
                <AudioDenoiseBottomToolbar
                  key={toolbarSessionKey}
                  active
                  videoRef={videoRef}
                  mediaSrc={videoSrc}
                  currentTime={playbackSnapshot.currentTime}
                  duration={playbackSnapshot.duration}
                  isPlaying={playbackSnapshot.isPlaying}
                  volume={playbackSnapshot.volume}
                  onClose={closeActiveTool}
                  onSend={sendVideoMiniTool('video.audio-denoise')}
                />
              )}
            </div>
          )}
        </div>

        <RightToolPanel activeTool={activeTool} onSelect={handleRightToolPanelSelect} />
      </div>
    </div>
  );
};

export default VideoEditorNodePage;
