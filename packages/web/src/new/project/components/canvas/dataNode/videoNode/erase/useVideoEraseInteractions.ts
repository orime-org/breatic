import { nanoid } from 'nanoid';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { Node } from '@xyflow/react';
import type { ImageEditorPickResultBox, ImageFlowNodeData } from '@/new/project/types';
import type { VideoEraseMaskTool } from './EraseBottomToolbar';
import type { EraseTrackingSegment, EraseTrackingStatus } from './EraseTrackingPanel';

type EraseDrawDraft = {
  tool: 'rectangle' | 'circle';
  start: { xPct: number; yPct: number };
  current: { xPct: number; yPct: number };
  frameTimeSec: number;
  constrainToSquare?: boolean;
};

type EraseBoxDragState = {
  placeholderId: string;
  startClientX: number;
  startClientY: number;
  originCxPct: number;
  originCyPct: number;
  startBoxes: ImageEditorPickResultBox[];
};

export type EraseBoxResizeDirection =
  | 'top'
  | 'bottom'
  | 'left'
  | 'right'
  | 'top-left'
  | 'top-right'
  | 'bottom-left'
  | 'bottom-right';
type EraseBoxResizeState = {
  placeholderId: string;
  startClientX: number;
  startClientY: number;
  direction: EraseBoxResizeDirection;
  startBoxes: ImageEditorPickResultBox[];
};

const buildEraseBoxFromDrag = (params: {
  start: { xPct: number; yPct: number };
  end: { xPct: number; yPct: number };
  tool: 'rectangle' | 'circle';
  constrainToSquare?: boolean;
  viewportSize?: { width: number; height: number };
}): { cxPct: number; cyPct: number; wPct: number; hPct: number } => {
  const deltaX = params.end.xPct - params.start.xPct;
  const deltaY = params.end.yPct - params.start.yPct;
  const useSquare = params.tool === 'circle' && params.constrainToSquare;
  const nextEnd = (() => {
    if (!useSquare) return params.end;
    const viewportWidth = params.viewportSize?.width ?? 0;
    const viewportHeight = params.viewportSize?.height ?? 0;
    if (viewportWidth <= 0 || viewportHeight <= 0) {
      return {
        xPct: params.start.xPct + Math.sign(deltaX || 1) * Math.max(Math.abs(deltaX), Math.abs(deltaY)),
        yPct: params.start.yPct + Math.sign(deltaY || 1) * Math.max(Math.abs(deltaX), Math.abs(deltaY)),
      };
    }
    const deltaXPx = (deltaX / 100) * viewportWidth;
    const deltaYPx = (deltaY / 100) * viewportHeight;
    const sidePx = Math.max(Math.abs(deltaXPx), Math.abs(deltaYPx));
    const endXPct = params.start.xPct + (Math.sign(deltaXPx || 1) * sidePx * 100) / viewportWidth;
    const endYPct = params.start.yPct + (Math.sign(deltaYPx || 1) * sidePx * 100) / viewportHeight;
    return {
      xPct: Math.min(100, Math.max(0, endXPct)),
      yPct: Math.min(100, Math.max(0, endYPct)),
    };
  })();
  const minX = Math.min(params.start.xPct, nextEnd.xPct);
  const maxX = Math.max(params.start.xPct, nextEnd.xPct);
  const minY = Math.min(params.start.yPct, nextEnd.yPct);
  const maxY = Math.max(params.start.yPct, nextEnd.yPct);
  return {
    cxPct: (minX + maxX) / 2,
    cyPct: (minY + maxY) / 2,
    wPct: Math.max(2, maxX - minX),
    hPct: Math.max(2, maxY - minY),
  };
};

type UseVideoEraseInteractionsParams = {
  id: string;
  editingMode:
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
    | null;
  eraseMaskTool: VideoEraseMaskTool;
  currentTrackingStatus: EraseTrackingStatus | null;
  nodeFromStoreData: Partial<ImageFlowNodeData> | undefined;
  playbackCurrentTime: number;
  videoViewportRef: React.RefObject<HTMLDivElement | null>;
  nodesRef: React.MutableRefObject<Node[]>;
  playbackTimeRef: React.MutableRefObject<number>;
  prevPlaybackTimeRef: React.MutableRefObject<number>;
  scheduledVideoErasePickIdsRef: React.MutableRefObject<Set<string>>;
  pendingManualBoxRef: React.MutableRefObject<Map<string, ImageEditorPickResultBox>>;
  videoErasePickResultDefault: { wPct: number; hPct: number };
  readCurrentResultBoxes: () => ImageEditorPickResultBox[];
  applyResultBoxes: (nextBoxes: ImageEditorPickResultBox[], options?: { recordHistory?: boolean }) => void;
  applyResultBoxesTransient: (nextBoxes: ImageEditorPickResultBox[]) => void;
  startTrackingAnalysis: (anchorSec: number, sourceBoxes?: ImageEditorPickResultBox[]) => void;
  setTrackingSegments: React.Dispatch<React.SetStateAction<EraseTrackingSegment[]>>;
  updateNode: (nodeId: string, updates: Partial<Node>, options?: { history?: 'skip' }) => void;
};

export const useVideoEraseInteractions = (params: UseVideoEraseInteractionsParams) => {
  const {
    id,
    editingMode,
    eraseMaskTool,
    currentTrackingStatus,
    nodeFromStoreData,
    playbackCurrentTime,
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
  } = params;
  const [eraseDrawDraft, setEraseDrawDraft] = useState<EraseDrawDraft | null>(null);
  const [eraseBoxDragState, setEraseBoxDragState] = useState<EraseBoxDragState | null>(null);
  const [eraseBoxResizeState, setEraseBoxResizeState] = useState<EraseBoxResizeState | null>(null);

  const draftBox = useMemo(() => {
    if (!eraseDrawDraft) return null;
    const rect = videoViewportRef.current?.getBoundingClientRect();
    const box = buildEraseBoxFromDrag({
      start: eraseDrawDraft.start,
      end: eraseDrawDraft.current,
      tool: eraseDrawDraft.tool,
      constrainToSquare: eraseDrawDraft.constrainToSquare,
      viewportSize: rect ? { width: rect.width, height: rect.height } : undefined,
    });
    return {
      ...box,
      tool: eraseDrawDraft.tool,
      frameTimeSec: eraseDrawDraft.frameTimeSec,
    };
  }, [eraseDrawDraft, videoViewportRef]);

  const clearEraseInteractionState = useCallback(() => {
    setEraseDrawDraft(null);
    setEraseBoxDragState(null);
    setEraseBoxResizeState(null);
  }, []);

  const getPctInViewport = useCallback(
    (clientX: number, clientY: number) => {
      const viewport = videoViewportRef.current;
      if (!viewport) return null;
      const rect = viewport.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      const xPct = Math.min(100, Math.max(0, ((clientX - rect.left) / rect.width) * 100));
      const yPct = Math.min(100, Math.max(0, ((clientY - rect.top) / rect.height) * 100));
      return { xPct, yPct };
    },
    [videoViewportRef],
  );

  const handleTrackedBoxMouseDown = useCallback(
    (box: ImageEditorPickResultBox, e: React.MouseEvent<HTMLDivElement>) => {
      if (editingMode !== 'erase' || currentTrackingStatus === 'lost') return;
      if (!box.placeholderId) return;
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      setEraseBoxDragState({
        placeholderId: box.placeholderId,
        startClientX: e.clientX,
        startClientY: e.clientY,
        originCxPct: box.cxPct,
        originCyPct: box.cyPct,
        startBoxes: readCurrentResultBoxes(),
      });
    },
    [currentTrackingStatus, editingMode, readCurrentResultBoxes],
  );

  const handleTrackedBoxResizeHandleMouseDown = useCallback(
    (box: ImageEditorPickResultBox, direction: EraseBoxResizeDirection, e: React.MouseEvent<HTMLDivElement>) => {
      if (editingMode !== 'erase' || currentTrackingStatus === 'lost') return;
      if (!box.placeholderId) return;
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      setEraseBoxResizeState({
        placeholderId: box.placeholderId,
        startClientX: e.clientX,
        startClientY: e.clientY,
        direction,
        startBoxes: readCurrentResultBoxes(),
      });
    },
    [currentTrackingStatus, editingMode, readCurrentResultBoxes],
  );

  const handleVideoViewportMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (editingMode !== 'erase') return;
      if (eraseMaskTool !== 'rectangle' && eraseMaskTool !== 'circle') return;
      if (e.button !== 0) return;
      const hit = getPctInViewport(e.clientX, e.clientY);
      if (!hit) return;
      e.preventDefault();
      e.stopPropagation();
      setEraseDrawDraft({
        tool: eraseMaskTool,
        start: hit,
        current: hit,
        frameTimeSec: playbackCurrentTime,
        constrainToSquare: false,
      });
    },
    [editingMode, eraseMaskTool, getPctInViewport, playbackCurrentTime],
  );

  useEffect(() => {
    if (!eraseBoxDragState) return;
    const onMouseMove = (e: MouseEvent) => {
      const viewport = videoViewportRef.current;
      if (!viewport) return;
      const rect = viewport.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const deltaXPct = ((e.clientX - eraseBoxDragState.startClientX) / rect.width) * 100;
      const deltaYPct = ((e.clientY - eraseBoxDragState.startClientY) / rect.height) * 100;
      const nextBoxes = eraseBoxDragState.startBoxes.map((item) => {
        if (item.placeholderId !== eraseBoxDragState.placeholderId) return item;
        const halfW = item.wPct / 2;
        const halfH = item.hPct / 2;
        const cxPct = Math.min(100 - halfW, Math.max(halfW, eraseBoxDragState.originCxPct + deltaXPct));
        const cyPct = Math.min(100 - halfH, Math.max(halfH, eraseBoxDragState.originCyPct + deltaYPct));
        return { ...item, cxPct, cyPct };
      });
      applyResultBoxesTransient(nextBoxes);
    };
    const onMouseUp = () => {
      const latest = readCurrentResultBoxes();
      applyResultBoxes(latest, { recordHistory: true });
      setEraseBoxDragState(null);
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [applyResultBoxes, applyResultBoxesTransient, eraseBoxDragState, readCurrentResultBoxes, videoViewportRef]);

  useEffect(() => {
    if (!eraseBoxResizeState) return;
    const onMouseMove = (e: MouseEvent) => {
      const viewport = videoViewportRef.current;
      if (!viewport) return;
      const rect = viewport.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const deltaXPct = ((e.clientX - eraseBoxResizeState.startClientX) / rect.width) * 100;
      const deltaYPct = ((e.clientY - eraseBoxResizeState.startClientY) / rect.height) * 100;
      const minSizePct = 2;
      const nextBoxes = eraseBoxResizeState.startBoxes.map((item) => {
        if (item.placeholderId !== eraseBoxResizeState.placeholderId) return item;
        let left = item.cxPct - item.wPct / 2;
        let right = item.cxPct + item.wPct / 2;
        let top = item.cyPct - item.hPct / 2;
        let bottom = item.cyPct + item.hPct / 2;
        if (eraseBoxResizeState.direction === 'left') {
          left = Math.min(right - minSizePct, Math.max(0, left + deltaXPct));
        } else if (eraseBoxResizeState.direction === 'right') {
          right = Math.max(left + minSizePct, Math.min(100, right + deltaXPct));
        } else if (eraseBoxResizeState.direction === 'top') {
          top = Math.min(bottom - minSizePct, Math.max(0, top + deltaYPct));
        } else if (eraseBoxResizeState.direction === 'bottom') {
          bottom = Math.max(top + minSizePct, Math.min(100, bottom + deltaYPct));
        } else if (eraseBoxResizeState.direction === 'top-left') {
          left = Math.min(right - minSizePct, Math.max(0, left + deltaXPct));
          top = Math.min(bottom - minSizePct, Math.max(0, top + deltaYPct));
        } else if (eraseBoxResizeState.direction === 'top-right') {
          right = Math.max(left + minSizePct, Math.min(100, right + deltaXPct));
          top = Math.min(bottom - minSizePct, Math.max(0, top + deltaYPct));
        } else if (eraseBoxResizeState.direction === 'bottom-left') {
          left = Math.min(right - minSizePct, Math.max(0, left + deltaXPct));
          bottom = Math.max(top + minSizePct, Math.min(100, bottom + deltaYPct));
        } else {
          right = Math.max(left + minSizePct, Math.min(100, right + deltaXPct));
          bottom = Math.max(top + minSizePct, Math.min(100, bottom + deltaYPct));
        }
        return {
          ...item,
          cxPct: (left + right) / 2,
          cyPct: (top + bottom) / 2,
          wPct: Math.max(minSizePct, right - left),
          hPct: Math.max(minSizePct, bottom - top),
        };
      });
      applyResultBoxesTransient(nextBoxes);
    };
    const onMouseUp = () => {
      const latest = readCurrentResultBoxes();
      applyResultBoxes(latest, { recordHistory: true });
      setEraseBoxResizeState(null);
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [applyResultBoxes, applyResultBoxesTransient, eraseBoxResizeState, readCurrentResultBoxes, videoViewportRef]);

  useEffect(() => {
    if (!eraseDrawDraft) return;
    const onMouseMove = (e: MouseEvent) => {
      const hit = getPctInViewport(e.clientX, e.clientY);
      if (!hit) return;
      setEraseDrawDraft((prev) =>
        prev
          ? {
            ...prev,
            current: hit,
            constrainToSquare: false,
          }
          : prev,
      );
    };
    const onMouseUp = (e: MouseEvent) => {
      const hit = getPctInViewport(e.clientX, e.clientY);
      setEraseDrawDraft((prev) => {
        if (!prev) return null;
        const end = hit ?? prev.current;
        const box = buildEraseBoxFromDrag({
          start: prev.start,
          end,
          tool: prev.tool,
          constrainToSquare: false,
          viewportSize: videoViewportRef.current
            ? {
              width: videoViewportRef.current.getBoundingClientRect().width,
              height: videoViewportRef.current.getBoundingClientRect().height,
            }
            : undefined,
        });
        const placeholderId = `manual-${Date.now()}-${nanoid(4)}`;
        const nextBox: ImageEditorPickResultBox = {
          ...box,
          frameTimeSec: prev.frameTimeSec,
          maskShape: prev.tool,
          placeholderId,
          sourceNodeId: id,
          name: prev.tool === 'circle' ? 'circle' : 'rectangle',
        };
        pendingManualBoxRef.current.clear();
        pendingManualBoxRef.current.set(placeholderId, nextBox);
        setTrackingSegments([]);
        updateNode(
          id,
          {
            data: {
              pickState: {
                consumeFrom: 'videoErase',
                eraseMaskTool: prev.tool,
                pendingList: [
                  {
                    targetNodeId: id,
                    placeholderId,
                    content: 'manual',
                    name: prev.tool === 'circle' ? 'circle' : 'rectangle',
                    overlayAnchor: { xPct: nextBox.cxPct, yPct: nextBox.cyPct },
                  },
                ],
                resultBoxes: null,
              },
            },
          },
          { history: 'skip' },
        );
        return null;
      });
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [eraseDrawDraft, getPctInViewport, id, pendingManualBoxRef, setTrackingSegments, updateNode, videoViewportRef]);

  useEffect(() => {
    if (editingMode !== 'erase') return;
    const sourcePs = nodeFromStoreData?.pickState;
    if (sourcePs?.consumeFrom !== 'videoErase') return;
    const pendingList = sourcePs.pendingList ?? [];
    if (pendingList.length === 0) return;
    setTrackingSegments((prev) => (prev.length > 0 ? [] : prev));
    const pending = pendingList[pendingList.length - 1];
    if (!pending) return;
    if (scheduledVideoErasePickIdsRef.current.has(pending.placeholderId)) return;
    scheduledVideoErasePickIdsRef.current.add(pending.placeholderId);
    const pickFrameTime = playbackTimeRef.current;
    window.setTimeout(() => {
      scheduledVideoErasePickIdsRef.current.delete(pending.placeholderId);
      const currentNodes = nodesRef.current;
      if (Math.abs(playbackTimeRef.current - pickFrameTime) > 0.001) {
        return;
      }
      const source = currentNodes.find((n) => n.id === id);
      const sourcePick = (source?.data as Partial<ImageFlowNodeData> | undefined)?.pickState;
      const currentPending = sourcePick?.pendingList ?? [];
      if (!currentPending.some((item) => item.placeholderId === pending.placeholderId)) return;

      updateNode(id, { data: { pickState: { pendingList: null } } }, { history: 'skip' });

      const manualBox = pendingManualBoxRef.current.get(pending.placeholderId);
      pendingManualBoxRef.current.delete(pending.placeholderId);
      const halfW = videoErasePickResultDefault.wPct / 2;
      const halfH = videoErasePickResultDefault.hPct / 2;
      const rawCx = pending.overlayAnchor?.xPct ?? 50;
      const rawCy = pending.overlayAnchor?.yPct ?? 50;
      const cxPct = Math.min(100 - halfW, Math.max(halfW, rawCx));
      const cyPct = Math.min(100 - halfH, Math.max(halfH, rawCy));
      const nextBox: ImageEditorPickResultBox = manualBox ?? {
        cxPct,
        cyPct,
        wPct: videoErasePickResultDefault.wPct,
        hPct: videoErasePickResultDefault.hPct,
        frameTimeSec: pickFrameTime,
        maskShape: eraseMaskTool === 'circle' ? 'circle' : eraseMaskTool === 'rectangle' ? 'rectangle' : undefined,
        placeholderId: pending.placeholderId,
        sourceNodeId: id,
        content: pending.content,
        name: pending.name,
      };
      const nextBoxes = [nextBox];
      applyResultBoxes(nextBoxes, { recordHistory: true });
      startTrackingAnalysis(pickFrameTime, nextBoxes);
    }, 900);
  }, [
    applyResultBoxes,
    editingMode,
    eraseMaskTool,
    id,
    nodeFromStoreData?.pickState,
    nodesRef,
    pendingManualBoxRef,
    playbackTimeRef,
    scheduledVideoErasePickIdsRef,
    setTrackingSegments,
    startTrackingAnalysis,
    updateNode,
    videoErasePickResultDefault.hPct,
    videoErasePickResultDefault.wPct,
  ]);

  useEffect(() => {
    const prev = prevPlaybackTimeRef.current;
    const curr = playbackCurrentTime;
    prevPlaybackTimeRef.current = curr;
    if (editingMode !== 'erase' || Math.abs(curr - prev) <= 0.0001) return;
    const sourcePs = nodeFromStoreData?.pickState;
    if (sourcePs?.consumeFrom !== 'videoErase') return;
    if (!sourcePs.pendingList?.length) return;
    scheduledVideoErasePickIdsRef.current.clear();
    pendingManualBoxRef.current.clear();
    setTrackingSegments([]);
    updateNode(
      id,
      {
        data: {
          pickState: {
            pendingList: null,
          },
        },
      },
      { history: 'skip' },
    );
  }, [
    editingMode,
    id,
    nodeFromStoreData?.pickState,
    pendingManualBoxRef,
    playbackCurrentTime,
    prevPlaybackTimeRef,
    scheduledVideoErasePickIdsRef,
    setTrackingSegments,
    updateNode,
  ]);

  return {
    draftBox,
    clearEraseInteractionState,
    handleTrackedBoxMouseDown,
    handleTrackedBoxResizeHandleMouseDown,
    handleVideoViewportMouseDown,
  };
};
