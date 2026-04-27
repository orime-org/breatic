import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, FabricImage } from 'fabric';
import { RiAddLine, RiSubtractLine } from 'react-icons/ri';
import { useParams } from 'react-router-dom';
import { Icon } from '@/components/base/icon';
import Loading from '@/components/loading/Loading';
import IMAGE_EDITOR_DEFAULT_IMAGE from './defaultImageBase64';
import LeftHistoryPanel, { type ImageHistoryItem } from './components/LeftHistoryPanel/LeftHistoryPanel';
import RightToolPanel, { type ImageEditorToolMode } from './components/RightToolPanel/RightToolPanel';
import ImageInpaintCanvas from './components/inpaint/ImageInpaintCanvas';
import InpaintBottomToolbar from './components/inpaint/InpaintBottomToolbar';
import MarkBottomToolbar from './components/mark/MarkBottomToolbar';
import GraffitiBottomToolbar from './components/graffiti/GraffitiBottomToolbar';
import AdjustBottomToolbar, { defaultAdjustValue, type AdjustValue } from './components/adjust/AdjustBottomToolbar';
import { buildAdjustFabricFilters, isNeutralAdjustValue } from './components/adjust/adjustFilters';
import CropBottomToolbar from './components/crop/CropBottomToolbar';
import CropOverlay, { type CropRect } from './components/crop/CropOverlay';
import FlipRotateBottomToolbar, {
  bitmapTransformToPngDataUrl,
  type FlipRotateBitmapOp,
} from './components/flipRotate/FlipRotateBottomToolbar';
import ExpandBottomToolbar, { type ExpandResolution } from './components/expand/ExpandBottomToolbar';
import ExpandOverlay from './components/expand/ExpandOverlay';
import UpscaleBottomToolbar from './components/upscale/UpscaleBottomToolbar';
import GridSliceBottomToolbar from './components/gridSlice/GridSliceBottomToolbar';
import { type GridSliceValue } from './components/gridSlice/GridSliceSettings';
import GridSliceOverlay from './components/gridSlice/GridSliceOverlay';
import RelightBottomToolbar from './components/relight/RelightBottomToolbar';
import MultiAngleBottomToolbar from './components/multiAngle/MultiAngleBottomToolbar';

type ImageEditorPageProps = {
  nodeId?: string;
};

type BottomActionMode = 'history-item' | 'tool-apply-history';

const ImageEditorPage: React.FC<ImageEditorPageProps> = ({ nodeId: nodeIdProp }) => {
  const params = useParams<'projectId' | 'nodeId'>();
  const nodeId = nodeIdProp ?? params.nodeId ?? '';
  const [selectedHistoryIndex, setSelectedHistoryIndex] = useState(0);
  const [hostHistoryIndex, setHostHistoryIndex] = useState(0);
  const [historyList, setHistoryList] = useState<ImageHistoryItem[]>([
    { src: IMAGE_EDITOR_DEFAULT_IMAGE, status: 'done' },
  ]);
  const [imageSrc, setImageSrc] = useState(IMAGE_EDITOR_DEFAULT_IMAGE);
  const [editorCanvas, setEditorCanvas] = useState<Canvas | null>(null);
  const canvasShellRef = useRef<HTMLDivElement | null>(null);
  const [shellSize, setShellSize] = useState({ width: 1, height: 1 });
  const [imageSize, setImageSize] = useState<{ width: number; height: number } | null>(null);
  const [imageLoading, setImageLoading] = useState(true);
  const [zoomFactor, setZoomFactor] = useState(1);
  const [zoomInput, setZoomInput] = useState('100');
  const historyRef = useRef<string[]>([]);
  const historyIndexRef = useRef(-1);
  const restoringRef = useRef(false);
  const historyMuteUntilRef = useRef(0);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [activeTool, setActiveTool] = useState<ImageEditorToolMode>('inpaint');
  const [cropRect, setCropRect] = useState<CropRect>({ x: 0, y: 0, w: 1, h: 1 });
  const [adjustValue, setAdjustValue] = useState<AdjustValue>(defaultAdjustValue);
  const [expandSize, setExpandSize] = useState<{ w: number; h: number }>({ w: 1, h: 1 });
  const [expandOrigin, setExpandOrigin] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [bottomActionMode, setBottomActionMode] = useState<BottomActionMode>('history-item');
  const mockTaskTimersRef = useRef<number[]>([]);
  const [gridSlice, setGridSlice] = useState<GridSliceValue>({ rows: 2, cols: 2 });
  const [selectedGridCells, setSelectedGridCells] = useState<string[]>([]);

  const currentSelectedItem = historyList[selectedHistoryIndex];
  const currentSelectedSrc = currentSelectedItem?.src ?? imageSrc;
  const toolsAutoAddHistoryOnSend = useMemo(
    () => new Set<ImageEditorToolMode>(['inpaint', 'relight', 'multi-angle', 'upscale', 'grid-slice']),
    [],
  );

  useEffect(() => {
    const shell = canvasShellRef.current;
    if (!shell) return;
    const updateSize = () => {
      const rect = shell.getBoundingClientRect();
      setShellSize({
        width: Math.max(1, Math.floor(rect.width)),
        height: Math.max(1, Math.floor(rect.height)),
      });
    };
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(shell);
    return () => observer.disconnect();
  }, []);

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

  useEffect(() => {
    let cancelled = false;
    setImageLoading(true);
    const image = new window.Image();
    image.crossOrigin = 'anonymous';
    image.onload = () => {
      if (cancelled) return;
      setImageSize({
        width: Math.max(1, image.naturalWidth || image.width || 1),
        height: Math.max(1, image.naturalHeight || image.height || 1),
      });
      setZoomFactor(1);
      setImageLoading(false);
    };
    image.onerror = () => {
      if (cancelled) return;
      setImageSize(null);
      setImageLoading(false);
    };
    image.src = imageSrc;
    return () => {
      cancelled = true;
    };
  }, [imageSrc]);

  const fitScale = useMemo(() => {
    if (!imageSize) return 1;
    return Math.min(shellSize.width / imageSize.width, shellSize.height / imageSize.height);
  }, [shellSize.width, shellSize.height, imageSize]);

  const displayScale = useMemo(() => Math.max(0.05, Math.min(8, fitScale * zoomFactor)), [fitScale, zoomFactor]);
  const zoomPercent = useMemo(() => Math.round(zoomFactor * 100), [zoomFactor]);

  useEffect(() => {
    setZoomInput(String(zoomPercent));
  }, [zoomPercent]);

  const updateHistoryAvailability = useCallback(() => {
    setCanUndo(historyIndexRef.current > 0);
    setCanRedo(historyIndexRef.current >= 0 && historyIndexRef.current < historyRef.current.length - 1);
  }, []);

  const pushCanvasSnapshot = useCallback(
    (canvas: Canvas) => {
      if (restoringRef.current) return;
      if (performance.now() < historyMuteUntilRef.current) return;
      const snapshot = JSON.stringify(canvas.toDatalessJSON());
      const current = historyRef.current[historyIndexRef.current];
      if (snapshot === current) return;
      const nextHistory = historyRef.current.slice(0, historyIndexRef.current + 1);
      nextHistory.push(snapshot);
      historyRef.current = nextHistory;
      historyIndexRef.current = nextHistory.length - 1;
      updateHistoryAvailability();
    },
    [updateHistoryAvailability],
  );

  const applyCanvasSnapshot = useCallback(
    async (canvas: Canvas, targetIndex: number) => {
      const snapshot = historyRef.current[targetIndex];
      if (!snapshot) return;
      restoringRef.current = true;
      try {
        const parsed = JSON.parse(snapshot);
        const loadResult = canvas.loadFromJSON(parsed);
        if (loadResult instanceof Promise) {
          await loadResult;
        }
        // Fabric JSON restore may drop custom erasable flags used by EraserBrush.
        // Re-mark non-image overlay objects as erasable so erase still works
        // after undo/redo history navigation.
        canvas.getObjects().forEach((obj) => {
          if (obj.type !== 'image') {
            (obj as unknown as { erasable?: boolean }).erasable = true;
          }
        });
        canvas.requestRenderAll();
        historyIndexRef.current = targetIndex;
        // `loadFromJSON` may emit `object:*` events after the await above.
        // Keep restore lock for one extra frame to avoid replay events
        // being captured as a new history snapshot (which breaks multi-step undo).
        await new Promise<void>((resolve) => {
          window.requestAnimationFrame(() => resolve());
        });
        // Additional guard window: Fabric may still emit delayed events
        // right after history navigation. Mute snapshot collection briefly.
        historyMuteUntilRef.current = performance.now() + 120;
      } catch {
        // No-op: keep previous canvas state on malformed snapshot.
      } finally {
        restoringRef.current = false;
        updateHistoryAvailability();
      }
    },
    [updateHistoryAvailability],
  );

  const handleUndo = useCallback(() => {
    if (restoringRef.current) return;
    if (!editorCanvas || historyIndexRef.current <= 0) return;
    void applyCanvasSnapshot(editorCanvas, historyIndexRef.current - 1);
  }, [editorCanvas, applyCanvasSnapshot]);

  const handleRedo = useCallback(() => {
    if (restoringRef.current) return;
    if (!editorCanvas || historyIndexRef.current >= historyRef.current.length - 1) return;
    void applyCanvasSnapshot(editorCanvas, historyIndexRef.current + 1);
  }, [editorCanvas, applyCanvasSnapshot]);

  const handleCanvasCommit = useCallback(() => {
    if (!editorCanvas) return;
    pushCanvasSnapshot(editorCanvas);
  }, [editorCanvas, pushCanvasSnapshot]);

  const isInpaintCanvasMode = useCallback((mode: ImageEditorToolMode): boolean => {
    return mode === 'inpaint' || mode === 'mark' || mode === 'graffiti' || mode === 'adjust';
  }, []);

  const handleZoomOut = useCallback(() => {
    setZoomFactor((prev) => Math.max(0.2, prev / 1.08));
  }, []);

  const handleZoomIn = useCallback(() => {
    setZoomFactor((prev) => Math.min(1, prev * 1.08));
  }, []);

  const applyZoomInput = useCallback(() => {
    const normalized = zoomInput.trim().replace('%', '');
    const nextPercent = Number(normalized);
    if (!Number.isFinite(nextPercent)) {
      setZoomInput(String(zoomPercent));
      return;
    }
    const clampedPercent = Math.max(20, Math.min(100, Math.round(nextPercent)));
    setZoomFactor(clampedPercent / 100);
    setZoomInput(String(clampedPercent));
  }, [zoomInput, zoomPercent]);

  const handleToolSelect = useCallback(
    (tool: ImageEditorToolMode) => {
      const implementedTools = new Set<ImageEditorToolMode>([
        'inpaint',
        'mark',
        'graffiti',
        'adjust',
        'crop',
        'flip-rotate',
        'expand',
        'upscale',
        'cutout',
        'grid-slice',
        'relight',
        'multi-angle',
      ]);
      if (!implementedTools.has(tool)) {
        return;
      }
      setActiveTool(tool);
      setBottomActionMode('tool-apply-history');
      if (tool === 'crop' && imageSize) {
        setCropRect({ x: 0, y: 0, w: imageSize.width, h: imageSize.height });
      }
      if (tool === 'adjust') {
        setAdjustValue(defaultAdjustValue);
      }
      if (tool === 'expand' && imageSize) {
        const pad = 40;
        setExpandSize({ w: imageSize.width + pad * 2, h: imageSize.height + pad * 2 });
        setExpandOrigin({ x: -pad, y: -pad });
      }
      if (tool === 'grid-slice') {
        setSelectedGridCells([]);
      }
    },
    [imageSize],
  );

  const handleGridCellToggle = useCallback((row: number, col: number) => {
    const cellKey = `${row}-${col}`;
    setSelectedGridCells((prev) =>
      prev.includes(cellKey) ? prev.filter((item) => item !== cellKey) : [...prev, cellKey],
    );
  }, []);

  const handleCropDimensionChange = useCallback(
    (w: number, h: number, keepCentered = false) => {
      if (!imageSize) return;
      setCropRect((prev) => {
        const nextW = Math.max(1, Math.round(w));
        const nextH = Math.max(1, Math.round(h));
        if (keepCentered) {
          return {
            x: Math.max(0, Math.round((imageSize.width - nextW) / 2)),
            y: Math.max(0, Math.round((imageSize.height - nextH) / 2)),
            w: nextW,
            h: nextH,
          };
        }
        const maxX = Math.max(0, imageSize.width - nextW);
        const maxY = Math.max(0, imageSize.height - nextH);
        return {
          x: Math.min(maxX, Math.max(0, prev.x)),
          y: Math.min(maxY, Math.max(0, prev.y)),
          w: nextW,
          h: nextH,
        };
      });
    },
    [imageSize],
  );

  const handleCropSave = useCallback(async () => {
    if (!imageSrc || !imageSize) return;
    const image = new window.Image();
    image.crossOrigin = 'anonymous';
    image.src = imageSrc;
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('crop image load failed'));
    });

    const sx = Math.max(0, Math.min(image.naturalWidth, cropRect.x));
    const sy = Math.max(0, Math.min(image.naturalHeight, cropRect.y));
    const sw = Math.max(1, Math.min(image.naturalWidth - sx, cropRect.w));
    const sh = Math.max(1, Math.min(image.naturalHeight - sy, cropRect.h));

    const outputCanvas = document.createElement('canvas');
    outputCanvas.width = sw;
    outputCanvas.height = sh;
    const ctx = outputCanvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(image, sx, sy, sw, sh, 0, 0, sw, sh);
    setImageSrc(outputCanvas.toDataURL('image/png'));
    setActiveTool('inpaint');
  }, [cropRect.h, cropRect.w, cropRect.x, cropRect.y, imageSize, imageSrc]);

  const generateCroppedImage = useCallback(async (sourceSrc: string): Promise<string | null> => {
    if (!sourceSrc || !imageSize) return null;
    const image = new window.Image();
    image.crossOrigin = 'anonymous';
    image.src = sourceSrc;
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('crop image load failed'));
    });

    const sx = Math.max(0, Math.min(image.naturalWidth, cropRect.x));
    const sy = Math.max(0, Math.min(image.naturalHeight, cropRect.y));
    const sw = Math.max(1, Math.min(image.naturalWidth - sx, cropRect.w));
    const sh = Math.max(1, Math.min(image.naturalHeight - sy, cropRect.h));

    const outputCanvas = document.createElement('canvas');
    outputCanvas.width = sw;
    outputCanvas.height = sh;
    const ctx = outputCanvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(image, sx, sy, sw, sh, 0, 0, sw, sh);
    return outputCanvas.toDataURL('image/png');
  }, [cropRect.h, cropRect.w, cropRect.x, cropRect.y, imageSize]);

  const handleFlipRotateApply = useCallback(
    async (op: FlipRotateBitmapOp) => {
      if (!imageSrc) return;
      const { dataUrl } = await bitmapTransformToPngDataUrl(imageSrc, op);
      setImageSrc(dataUrl);
    },
    [imageSrc],
  );

  const applyAdjustFiltersToFabricImage = useCallback(async (image: FabricImage, value: AdjustValue) => {
    image.filters = buildAdjustFabricFilters(value) as FabricImage['filters'];
    await Promise.resolve(image.applyFilters());
  }, []);

  const handleAdjustPreviewImageReady = useCallback(
    async (image: FabricImage) => {
      await applyAdjustFiltersToFabricImage(image, adjustValue);
    },
    [adjustValue, applyAdjustFiltersToFabricImage],
  );

  const generateAdjustedImage = useCallback(
    async (src: string, value: AdjustValue): Promise<string | null> => {
      const image = await FabricImage.fromURL(src, { crossOrigin: 'anonymous' });
      const iw = image.width ?? 0;
      const ih = image.height ?? 0;
      if (!iw || !ih) return null;

      await applyAdjustFiltersToFabricImage(image, value);

      const el = document.createElement('canvas');
      const fabricCanvas = new Canvas(el, { width: iw, height: ih, selection: false, preserveObjectStacking: true });
      image.set({
        left: 0,
        top: 0,
        originX: 'left',
        originY: 'top',
        selectable: false,
        evented: false,
        erasable: false,
      });
      fabricCanvas.clear();
      fabricCanvas.add(image);
      fabricCanvas.requestRenderAll();
      const nextImage = fabricCanvas.toDataURL({ format: 'png', quality: 1, multiplier: 1 });
      fabricCanvas.dispose();
      return nextImage;
    },
    [applyAdjustFiltersToFabricImage],
  );

  const handleAdjustSave = useCallback(
    async (value: AdjustValue) => {
      setAdjustValue(value);
      if (!imageSrc) {
        setActiveTool('inpaint');
        return;
      }
      if (isNeutralAdjustValue(value)) {
        setActiveTool('inpaint');
        return;
      }
      const next = await generateAdjustedImage(imageSrc, value);
      if (next) setImageSrc(next);
      setActiveTool('inpaint');
    },
    [generateAdjustedImage, imageSrc],
  );

  const handleExpandDimensionChange = useCallback(
    (w: number, h: number, keepCentered = false) => {
      if (!imageSize) return;
      const cw = Math.max(1, Math.round(imageSize.width));
      const ch = Math.max(1, Math.round(imageSize.height));
      const ow = Math.max(cw, Math.round(w));
      const oh = Math.max(ch, Math.round(h));
      if (keepCentered) {
        setExpandOrigin({ x: (cw - ow) / 2, y: (ch - oh) / 2 });
      }
      setExpandSize({ w: ow, h: oh });
    },
    [imageSize],
  );

  const handleExpandFrameChange = useCallback(
    (next: { w: number; h: number; ox: number; oy: number }) => {
      if (!imageSize) return;
      const cw = Math.max(1, Math.round(imageSize.width));
      const ch = Math.max(1, Math.round(imageSize.height));
      setExpandSize({ w: Math.max(cw, next.w), h: Math.max(ch, next.h) });
      setExpandOrigin({ x: next.ox, y: next.oy });
    },
    [imageSize],
  );

  const generateExpandedImage = useCallback(
    async (
      src: string,
      frame: { w: number; h: number; ox: number; oy: number },
    ): Promise<string | null> => {
      if (!imageSize) return null;
      const image = new window.Image();
      image.crossOrigin = 'anonymous';
      image.src = src;
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error('expand image load failed'));
      });

      const outW = Math.max(1, Math.round(frame.w));
      const outH = Math.max(1, Math.round(frame.h));
      const outputCanvas = document.createElement('canvas');
      outputCanvas.width = outW;
      outputCanvas.height = outH;
      const ctx = outputCanvas.getContext('2d');
      if (!ctx) return null;
      const nodeLeftInFrame = -frame.ox;
      const nodeTopInFrame = -frame.oy;
      ctx.drawImage(image, nodeLeftInFrame, nodeTopInFrame, imageSize.width, imageSize.height);
      return outputCanvas.toDataURL('image/png');
    },
    [imageSize],
  );

  const handleExpandSend = useCallback(
    async (payload: { width: number; height: number; resolution: ExpandResolution; ratio: string }) => {
      if (!imageSrc) return;
      const frame = {
        w: Math.max(1, Math.round(payload.width)),
        h: Math.max(1, Math.round(payload.height)),
        ox: expandOrigin.x,
        oy: expandOrigin.y,
      };
      const expanded = await generateExpandedImage(imageSrc, frame);
      if (expanded) setImageSrc(expanded);
      setActiveTool('inpaint');
    },
    [expandOrigin.x, expandOrigin.y, generateExpandedImage, imageSrc],
  );

  const handleUpscaleSend = useCallback(
    async (_payload: { resolution: '2k' | '4k' | '8k'; promptEnabled: boolean; prompt: string }) => {
      const loadingItem: ImageHistoryItem = {
        src: currentSelectedSrc || imageSrc,
        status: 'loading',
      };
      let loadingIndex = -1;
      setHistoryList((prev) => {
        const next = [...prev, loadingItem];
        loadingIndex = next.length - 1;
        return next;
      });
      setSelectedHistoryIndex(Math.max(0, loadingIndex));
      setBottomActionMode('history-item');
      const timer = window.setTimeout(() => {
        const isSuccess = Math.random() > 0.15;
        setHistoryList((prev) =>
          prev.map((entry, idx) =>
            idx === loadingIndex
              ? {
                ...entry,
                status: isSuccess ? 'done' : 'failed',
                errorMessage: isSuccess ? undefined : 'Upscale failed, please retry',
              }
              : entry,
          ),
        );
        void isSuccess;
      }, 1800);
      mockTaskTimersRef.current.push(timer);
      setActiveTool('inpaint');
    },
    [currentSelectedSrc, imageSrc],
  );

  const handleApplyToNode = useCallback(() => {
    setHostHistoryIndex(selectedHistoryIndex);
  }, [selectedHistoryIndex]);

  const handleAddNewNodeToCanvas = useCallback(() => {
    void 0;
  }, []);

  const handleExitTool = useCallback(() => {
    setActiveTool('inpaint');
    setBottomActionMode('history-item');
  }, []);

  const handleApplyToHistory = useCallback(async () => {
    if (activeTool === 'cutout') {
      const loadingItem: ImageHistoryItem = {
        src: currentSelectedSrc || imageSrc,
        status: 'loading',
      };
      let loadingIndex = -1;
      setHistoryList((prev) => {
        const next = [...prev, loadingItem];
        loadingIndex = next.length - 1;
        return next;
      });
      setSelectedHistoryIndex(Math.max(0, loadingIndex));
      setBottomActionMode('history-item');
      setActiveTool('inpaint');
      const timer = window.setTimeout(() => {
        const isSuccess = Math.random() > 0.2;
        setHistoryList((prev) =>
          prev.map((entry, idx) =>
            idx === loadingIndex
              ? {
                ...entry,
                status: isSuccess ? 'done' : 'failed',
                errorMessage: isSuccess ? undefined : 'Cutout failed, please retry',
              }
              : entry,
          ),
        );
        void isSuccess;
      }, 1500);
      mockTaskTimersRef.current.push(timer);
      return;
    }

    let src = currentSelectedSrc || imageSrc;
    if (activeTool === 'crop') {
      const cropped = await generateCroppedImage(src);
      if (cropped) src = cropped;
    } else if (activeTool === 'adjust') {
      if (imageSrc && !isNeutralAdjustValue(adjustValue)) {
        const adjusted = await generateAdjustedImage(imageSrc, adjustValue);
        if (adjusted) src = adjusted;
      }
    } else if (activeTool === 'expand') {
      const frame = {
        w: Math.max(1, Math.round(expandSize.w)),
        h: Math.max(1, Math.round(expandSize.h)),
        ox: expandOrigin.x,
        oy: expandOrigin.y,
      };
      if (imageSrc) {
        const expanded = await generateExpandedImage(imageSrc, frame);
        if (expanded) src = expanded;
      }
    } else if ((activeTool === 'mark' || activeTool === 'graffiti') && editorCanvas) {
      src = editorCanvas.toDataURL({
        format: 'png',
        quality: 1,
        multiplier: 1,
      });
    }

    if (!src) return;
    setImageSrc(src);
    setHistoryList((prev) => [...prev, { src, status: 'done' }]);
    setSelectedHistoryIndex(historyList.length);
    setBottomActionMode('history-item');
    setActiveTool('inpaint');
  }, [
    activeTool,
    adjustValue,
    currentSelectedSrc,
    editorCanvas,
    expandOrigin.x,
    expandOrigin.y,
    expandSize.h,
    expandSize.w,
    generateAdjustedImage,
    generateCroppedImage,
    generateExpandedImage,
    historyList.length,
    imageSrc,
  ]);

  const handleHistorySelect = useCallback((idx: number, item: ImageHistoryItem) => {
    setSelectedHistoryIndex(idx);
    setBottomActionMode('history-item');
    setActiveTool('inpaint');
    if (item.status === 'failed') {
      return;
    }
    if (item.status === 'loading') {
      return;
    }
    setImageSrc(item.src);
  }, []);

  const handleHistoryRetry = useCallback((idx: number, item: ImageHistoryItem) => {
    setHistoryList((prev) =>
      prev.map((entry, entryIdx) =>
        entryIdx === idx ? { ...entry, status: 'loading', errorMessage: undefined } : entry,
      ),
    );
    window.setTimeout(() => {
      setHistoryList((prev) =>
        prev.map((entry, entryIdx) =>
          entryIdx === idx ? { ...entry, status: 'done', src: item.src } : entry,
        ),
      );
    }, 1200);
  }, []);

  const appendDoneHistoryItem = useCallback((src: string) => {
    setHistoryList((prev) => [...prev, { src, status: 'done' }]);
    setSelectedHistoryIndex(historyList.length);
    setBottomActionMode('history-item');
  }, [historyList.length]);

  const handleGridSliceSend = useCallback(() => {
    const loadingItem: ImageHistoryItem = { src: currentSelectedSrc || imageSrc, status: 'loading' };
    let loadingIndex = -1;
    setHistoryList((prev) => {
      const next = [...prev, loadingItem];
      loadingIndex = next.length - 1;
      return next;
    });
    setSelectedHistoryIndex(Math.max(0, loadingIndex));
    setBottomActionMode('history-item');
    const timer = window.setTimeout(() => {
      const isSuccess = Math.random() > 0.2;
      setHistoryList((prev) =>
        prev.map((entry, idx) =>
          idx === loadingIndex
            ? { ...entry, status: isSuccess ? 'done' : 'failed', errorMessage: isSuccess ? undefined : 'Grid slice failed, please retry' }
            : entry,
        ),
      );
      setActiveTool('inpaint');
    }, 1600);
    mockTaskTimersRef.current.push(timer);
  }, [currentSelectedSrc, imageSrc]);

  useEffect(() => {
    return () => {
      mockTaskTimersRef.current.forEach((timer) => window.clearTimeout(timer));
      mockTaskTimersRef.current = [];
    };
  }, []);

  useEffect(() => {
    if (!editorCanvas) {
      historyRef.current = [];
      historyIndexRef.current = -1;
      updateHistoryAvailability();
      return;
    }

    pushCanvasSnapshot(editorCanvas);

    return;
  }, [editorCanvas, pushCanvasSnapshot, updateHistoryAvailability]);

  if (!nodeId) {
    return (
      <div className='flex h-full w-full min-h-0 min-w-0 items-center justify-center bg-[#f3f4f6] text-sm text-[#6b7280]'>
        Missing node id
      </div>
    );
  }

  return (
    <div className='flex h-full w-full min-h-0 min-w-0 flex-col bg-[#f2f3f5]'>
      <div className='flex min-h-0 flex-1 flex-col rounded-xl border border-[#e6e8ec] bg-background-default-secondary'>
        <div className='grid min-h-0 flex-1 grid-cols-[200px_minmax(0,1fr)_64px] divide-x divide-[#e6e8ec]'>
          <div className='h-full'>
            <LeftHistoryPanel
              historyList={historyList}
              activeIndex={selectedHistoryIndex}
              hostIndex={hostHistoryIndex}
              onSelect={handleHistorySelect}
              onRetry={handleHistoryRetry}
            />
          </div>

          <div className='flex min-h-0 h-full flex-col bg-background-default-secondary'>
            <div className='flex min-h-0 flex-1 items-center justify-center bg-[#f6f8fb] p-3'>
              <div ref={canvasShellRef} className='relative h-full w-full overflow-hidden rounded-lg bg-[#f6f8fb]'>
                {imageSize ? (
                  <div className='flex h-full w-full items-center justify-center'>
                    <div
                      style={{
                        transform: `scale(${displayScale})`,
                        transformOrigin: 'center center',
                      }}
                    >
                      <ImageInpaintCanvas
                        src={imageSrc}
                        width={imageSize.width}
                        height={imageSize.height}
                        drawBackgroundOnCanvas={activeTool !== 'inpaint'}
                        drawLayerOpacity={activeTool === 'inpaint' ? 0.55 : 1}
                        onImageReady={activeTool === 'adjust' ? handleAdjustPreviewImageReady : undefined}
                        onCanvasReady={setEditorCanvas}
                      />
                      {activeTool === 'crop' && (
                        <CropOverlay
                          containerWidth={imageSize.width}
                          containerHeight={imageSize.height}
                          viewportScale={displayScale}
                          value={cropRect}
                          onChange={setCropRect}
                        />
                      )}
                      {activeTool === 'expand' && (
                        <ExpandOverlay
                          containerWidth={imageSize.width}
                          containerHeight={imageSize.height}
                          viewportScale={displayScale}
                          outerWidth={expandSize.w}
                          outerHeight={expandSize.h}
                          originX={expandOrigin.x}
                          originY={expandOrigin.y}
                          onFrameChange={handleExpandFrameChange}
                        />
                      )}
                      {activeTool === 'grid-slice' && (
                        <GridSliceOverlay
                          rows={Math.max(1, gridSlice.rows)}
                          cols={Math.max(1, gridSlice.cols)}
                          viewportScale={displayScale}
                          selectedCells={selectedGridCells}
                          onToggleCell={handleGridCellToggle}
                        />
                      )}
                    </div>
                  </div>
                ) : (
                  <div className='flex h-full w-full items-center justify-center' />
                )}
                {imageLoading && (
                  <div className='pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-[#f0f2f666]'>
                    <Loading inline width='100%' height='100%' backgroundColor='transparent' scale={0.20} />
                  </div>
                )}
                <div className='pointer-events-none absolute bottom-3 right-3 z-10'>
                  <div className='pointer-events-auto flex items-center gap-2'>
                    <div className='flex h-8 items-center overflow-hidden rounded-md border border-[#d7dce3] bg-background-default-secondary shadow-[0_1px_3px_rgba(0,0,0,0.08)]'>
                      <button
                        type='button'
                        aria-label='Zoom out'
                        onClick={handleZoomOut}
                        className='flex h-8 w-8 items-center justify-center text-[14px] font-medium leading-none text-text-default-base transition-colors hover:bg-[#f3f4f6]'
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
                          onChange={(event) => {
                            const digits = event.target.value.replace(/[^\d]/g, '');
                            setZoomInput(digits);
                          }}
                          onBlur={applyZoomInput}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              event.preventDefault();
                              applyZoomInput();
                            }
                          }}
                          className='w-[34px] bg-transparent text-center text-[12px] font-medium text-text-default-secondary outline-none'
                        />
                        <span className='text-[12px] font-medium text-text-default-secondary'>%</span>
                      </div>
                      <div className='h-5 w-px bg-[#d7dce3]' />
                      <button
                        type='button'
                        aria-label='Zoom in'
                        onClick={handleZoomIn}
                        className='flex h-8 w-8 items-center justify-center text-[14px] font-medium leading-none text-text-default-base transition-colors hover:bg-[#f3f4f6]'
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
                        className='flex h-8 w-8 items-center justify-center rounded-md bg-background-default-secondary transition-colors hover:bg-[#f3f4f6] disabled:cursor-not-allowed disabled:opacity-40'
                      >
                        <Icon name='videoEditor-undo-icon' width={14} height={14} color='var(--color-icon-secondary)' />
                      </button>
                      <button
                        type='button'
                        aria-label='Redo'
                        disabled={!canRedo}
                        onClick={handleRedo}
                        className='flex h-8 w-8 items-center justify-center rounded-md bg-background-default-secondary transition-colors hover:bg-[#f3f4f6] disabled:cursor-not-allowed disabled:opacity-40'
                      >
                        <Icon name='videoEditor-redo-icon' width={14} height={14} color='var(--color-icon-secondary)' />
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
            <div className='flex min-h-[200px] justify-center overflow-hidden border-t border-[#e6e8ec] bg-background-default-secondary px-3 pb-3 pt-2'>
              <div className='flex w-full max-w-[740px] flex-col items-center gap-2 overflow-hidden'>
                {bottomActionMode === 'tool-apply-history' && activeTool === 'inpaint' && (
                  <InpaintBottomToolbar
                    canvas={editorCanvas}
                    active
                    baseImageSrc={imageSrc}
                    onCanvasCommit={handleCanvasCommit}
                    onClose={(nextImageSrc) => {
                      if (nextImageSrc) {
                        setImageSrc(nextImageSrc);
                        appendDoneHistoryItem(nextImageSrc);
                      }
                    }}
                  />
                )}
                {bottomActionMode === 'tool-apply-history' && activeTool === 'mark' && (
                  <MarkBottomToolbar
                    canvas={editorCanvas}
                    active={isInpaintCanvasMode(activeTool)}
                    onClose={(nextImageSrc) => {
                      if (nextImageSrc) setImageSrc(nextImageSrc);
                      handleExitTool();
                    }}
                  />
                )}
                {bottomActionMode === 'tool-apply-history' && activeTool === 'graffiti' && (
                  <GraffitiBottomToolbar
                    canvas={editorCanvas}
                    active={isInpaintCanvasMode(activeTool)}
                    onClose={(nextImageSrc) => {
                      if (nextImageSrc) setImageSrc(nextImageSrc);
                      handleExitTool();
                    }}
                  />
                )}
                {bottomActionMode === 'tool-apply-history' && activeTool === 'adjust' && (
                  <AdjustBottomToolbar
                    active={activeTool === 'adjust'}
                    onClose={handleExitTool}
                    onChange={setAdjustValue}
                    onSave={handleAdjustSave}
                  />
                )}
                {bottomActionMode === 'tool-apply-history' && activeTool === 'crop' && imageSize && (
                  <CropBottomToolbar
                    active={activeTool === 'crop'}
                    width={cropRect.w}
                    height={cropRect.h}
                    containerWidth={imageSize.width}
                    containerHeight={imageSize.height}
                    onDimensionChange={handleCropDimensionChange}
                    onClose={handleExitTool}
                    onSave={() => {
                      void handleCropSave();
                    }}
                  />
                )}
                {bottomActionMode === 'tool-apply-history' && activeTool === 'flip-rotate' && (
                  <FlipRotateBottomToolbar
                    active={activeTool === 'flip-rotate'}
                    imageSrc={imageSrc}
                    onClose={handleExitTool}
                    onApply={handleFlipRotateApply}
                  />
                )}
                {bottomActionMode === 'tool-apply-history' && activeTool === 'expand' && imageSize && (
                  <ExpandBottomToolbar
                    active={activeTool === 'expand'}
                    width={expandSize.w}
                    height={expandSize.h}
                    containerWidth={imageSize.width}
                    containerHeight={imageSize.height}
                    onDimensionChange={handleExpandDimensionChange}
                    onClose={handleExitTool}
                    onSend={handleExpandSend}
                  />
                )}
                {bottomActionMode === 'tool-apply-history' && activeTool === 'upscale' && (
                  <UpscaleBottomToolbar
                    active={activeTool === 'upscale'}
                    onClose={handleExitTool}
                    onSend={(payload) => {
                      void handleUpscaleSend(payload);
                    }}
                  />
                )}
                {bottomActionMode === 'tool-apply-history' && activeTool === 'grid-slice' && (
                  <GridSliceBottomToolbar
                    active
                    onClose={handleExitTool}
                    onSend={() => handleGridSliceSend()}
                    gridSlice={gridSlice}
                    onGridSliceChange={setGridSlice}
                    selectedCellCount={selectedGridCells.length}
                    selectedCells={selectedGridCells}
                  />
                )}
                {bottomActionMode === 'tool-apply-history' && activeTool === 'relight' && (
                  <RelightBottomToolbar active onClose={handleExitTool} imageSrc={imageSrc} />
                )}
                {bottomActionMode === 'tool-apply-history' && activeTool === 'multi-angle' && (
                  <MultiAngleBottomToolbar active onClose={handleExitTool} imageSrc={imageSrc} />
                )}
                {bottomActionMode === 'history-item' && (
                  <div className='flex w-full max-w-[740px] flex-col items-center gap-2'>
                    <div className='flex w-full items-center gap-2'>
                      <button
                        type='button'
                        className='flex h-[40px] flex-1 items-center justify-center whitespace-nowrap rounded-[8px] bg-[#21B57A] px-4 text-[12px] font-semibold text-white transition-colors hover:bg-[#1aa56f]'
                        onClick={handleApplyToNode}
                      >
                        Apply to Node
                      </button>
                      <button
                        type='button'
                        className='flex h-[40px] flex-1 items-center justify-center whitespace-nowrap rounded-[8px] border border-[#dbdbdb] bg-background-default-base px-4 text-[12px] font-medium text-text-default-base transition-colors hover:bg-background-default-base-hover'
                        onClick={handleAddNewNodeToCanvas}
                      >
                        Add new node to canvas
                      </button>
                    </div>
                  </div>
                )}
                {bottomActionMode === 'tool-apply-history' && !toolsAutoAddHistoryOnSend.has(activeTool) && (
                  <div className='flex flex-col items-center gap-1'>
                    <button
                      type='button'
                      className='flex h-[40px] items-center justify-center whitespace-nowrap rounded-[8px] bg-[#21B57A] px-4 text-[12px] font-semibold text-white transition-colors hover:bg-[#1aa56f]'
                      onClick={handleApplyToHistory}
                    >
                      Apply ↗ history
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className='h-full'>
            <RightToolPanel activeTool={activeTool} onSelect={handleToolSelect} />
          </div>
        </div>
      </div>
    </div>
  );
};

export default ImageEditorPage;

