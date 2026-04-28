import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, FabricImage } from 'fabric';
import { RiAddLine, RiSubtractLine } from 'react-icons/ri';
import { useParams } from 'react-router-dom';
import { Icon } from '@/components/base/icon';
import Loading from '@/components/loading/Loading';
import RecognizedPickDropdown from '@/components/base/agent/RecognizedPickDropdown';
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
import QuickEditBottomToolbar from './components/quickEdit/QuickEditBottomToolbar';

type ImageEditorPageProps = {
  nodeId?: string;
};

type BottomActionMode = 'history-item' | 'tool-apply-history';
type QuickEditPickBox = {
  id: string;
  cxPct: number;
  cyPct: number;
  wPct: number;
  hPct: number;
  name: string;
};
type QuickEditPendingPick = {
  id: string;
  cxPct: number;
  cyPct: number;
  wPct: number;
  hPct: number;
};
const recognizedOverlayPresets = [
  { key: 'mountain', label: '山脉', cxPct: 28, cyPct: 24, wPct: 26, hPct: 26 },
  { key: 'river', label: '河流', cxPct: 56, cyPct: 62, wPct: 30, hPct: 22 },
  { key: 'tree', label: '大树', cxPct: 76, cyPct: 42, wPct: 18, hPct: 28 },
] as const;

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
  const [activeTool, setActiveTool] = useState<ImageEditorToolMode | null>(null);
  const [cropRect, setCropRect] = useState<CropRect>({ x: 0, y: 0, w: 1, h: 1 });
  const [adjustValue, setAdjustValue] = useState<AdjustValue>(defaultAdjustValue);
  const [expandSize, setExpandSize] = useState<{ w: number; h: number }>({ w: 1, h: 1 });
  const [expandOrigin, setExpandOrigin] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [bottomActionMode, setBottomActionMode] = useState<BottomActionMode>('history-item');
  const mockTaskTimersRef = useRef<number[]>([]);
  const [gridSlice, setGridSlice] = useState<GridSliceValue>({ rows: 2, cols: 2 });
  const [selectedGridCells, setSelectedGridCells] = useState<string[]>([]);
  const [quickEditPickBoxes, setQuickEditPickBoxes] = useState<QuickEditPickBox[]>([]);
  const [quickEditPendingPicks, setQuickEditPendingPicks] = useState<QuickEditPendingPick[]>([]);
  const [quickEditPickEnabled, setQuickEditPickEnabled] = useState(false);
  const quickEditPickTimersRef = useRef<number[]>([]);
  const [toolSessionSeed, setToolSessionSeed] = useState(0);

  const currentSelectedItem = historyList[selectedHistoryIndex];
  const currentSelectedSrc = currentSelectedItem?.src ?? imageSrc;
  const toolsAutoAddHistoryOnSend = useMemo(
    () =>
      new Set<ImageEditorToolMode>([
        'inpaint',
        'quick-edit',
        'expand',
        'grid-slice',
        'graffiti',
        'relight',
        'multi-angle',
        'upscale',
      ]),
    [],
  );

  const enqueueMockHistoryTask = useCallback(
    ({
      src,
      delayMs,
    }: {
      src?: string;
      delayMs: number;
    }) => {
      const loadingSrc = src || currentSelectedSrc || imageSrc;
      const loadingItem: ImageHistoryItem = {
        src: loadingSrc,
        status: 'loading',
      };
      let loadingIndex = -1;
      setHistoryList((prev) => {
        const next = [...prev, loadingItem];
        loadingIndex = next.length - 1;
        return next;
      });
      setSelectedHistoryIndex(Math.max(0, loadingIndex));
      setBottomActionMode('tool-apply-history');
      setToolSessionSeed((prev) => prev + 1);
      const timer = window.setTimeout(() => {
        setHistoryList((prev) =>
          prev.map((entry, idx) =>
            idx === loadingIndex
              ? {
                ...entry,
                src: loadingSrc,
                status: 'done',
                errorMessage: undefined,
              }
              : entry,
          ),
        );
      }, delayMs);
      mockTaskTimersRef.current.push(timer);
    },
    [currentSelectedSrc, imageSrc],
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

  /**
   * When image dimensions change while the crop tool is active, reset the crop rectangle
   * to cover the full image (e.g. after Apply history produces a smaller image).
   */
  useEffect(() => {
    if (activeTool !== 'crop' || !imageSize) return;
    setCropRect({ x: 0, y: 0, w: imageSize.width, h: imageSize.height });
  }, [imageSize, activeTool]);

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
      // Guard against recording an "empty canvas" baseline while the background image
      // is still loading in non-inpaint modes. That empty state would make undo appear
      // to remove the photo itself.
      if (activeTool !== 'inpaint') {
        const hasImageObject = canvas.getObjects().some((obj) => obj.type === 'image');
        if (!hasImageObject) return;
      }
      const snapshot = JSON.stringify(canvas.toDatalessJSON());
      const current = historyRef.current[historyIndexRef.current];
      if (snapshot === current) return;
      const nextHistory = historyRef.current.slice(0, historyIndexRef.current + 1);
      nextHistory.push(snapshot);
      historyRef.current = nextHistory;
      historyIndexRef.current = nextHistory.length - 1;
      updateHistoryAvailability();
    },
    [activeTool, updateHistoryAvailability],
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
      if (activeTool === tool) {
        setActiveTool(null);
        setBottomActionMode('history-item');
        setQuickEditPickBoxes([]);
        setQuickEditPendingPicks([]);
        setQuickEditPickEnabled(false);
        return;
      }
      const implementedTools = new Set<ImageEditorToolMode>([
        'inpaint',
        'quick-edit',
        'mark',
        'graffiti',
        'adjust',
        'crop',
        'flip-rotate',
        'expand',
        'upscale',
        'erase',
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
      if (tool !== 'quick-edit') {
        setQuickEditPickBoxes([]);
        setQuickEditPendingPicks([]);
        setQuickEditPickEnabled(false);
      }
    },
    [activeTool, imageSize],
  );

  const handleQuickEditCanvasPick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (!imageSize) return;
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
    const id = `quick-pick-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const pendingPick: QuickEditPendingPick = {
      id,
      cxPct,
      cyPct,
      wPct,
      hPct,
    };
    setQuickEditPendingPicks((prev) => [...prev, pendingPick]);

    const timer = window.setTimeout(() => {
      setQuickEditPendingPicks((prev) => prev.filter((pick) => pick.id !== id));
      setQuickEditPickBoxes((prev) => [...prev, { ...pendingPick, name: recognizedOverlayPresets[0].label }]);
    }, 1200);
    quickEditPickTimersRef.current.push(timer);
  }, [imageSize]);

  const handleRemoveQuickEditPickBox = useCallback((id: string) => {
    setQuickEditPickBoxes((prev) => prev.filter((box) => box.id !== id));
    setQuickEditPendingPicks((prev) => prev.filter((pick) => pick.id !== id));
  }, []);

  const handleGridCellToggle = useCallback((row: number, col: number) => {
    const cellKey = `${row}-${col}`;
    setSelectedGridCells((prev) =>
      prev.includes(cellKey) ? prev.filter((item) => item !== cellKey) : [...prev, cellKey],
    );
  }, []);

  const generateGridSliceResultImage = useCallback(
    async (src: string, rows: number, cols: number, selectedCells: string[]): Promise<string | null> => {
      if (!src) return null;
      const image = new window.Image();
      image.crossOrigin = 'anonymous';
      image.src = src;
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error('grid slice image load failed'));
      });

      const iw = Math.max(1, image.naturalWidth || image.width || 1);
      const ih = Math.max(1, image.naturalHeight || image.height || 1);
      const out = document.createElement('canvas');
      out.width = iw;
      out.height = ih;
      const ctx = out.getContext('2d');
      if (!ctx) return null;

      const safeRows = Math.max(1, rows);
      const safeCols = Math.max(1, cols);
      const selectedSet = new Set(selectedCells);
      const cellW = iw / safeCols;
      const cellH = ih / safeRows;

      // Build a new image by drawing only unselected grid cells.
      for (let row = 1; row <= safeRows; row += 1) {
        for (let col = 1; col <= safeCols; col += 1) {
          const key = `${row}-${col}`;
          if (selectedSet.has(key)) continue;
          const x = Math.round((col - 1) * cellW);
          const y = Math.round((row - 1) * cellH);
          const w = Math.max(1, Math.round(col * cellW) - x);
          const h = Math.max(1, Math.round(row * cellH) - y);
          ctx.drawImage(image, x, y, w, h, x, y, w, h);
        }
      }

      return out.toDataURL('image/png');
    },
    [],
  );

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
    setBottomActionMode('tool-apply-history');
    setToolSessionSeed((prev) => prev + 1);
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
        return;
      }
      if (isNeutralAdjustValue(value)) {
        return;
      }
      const next = await generateAdjustedImage(imageSrc, value);
      if (next) setImageSrc(next);
      setBottomActionMode('tool-apply-history');
      setToolSessionSeed((prev) => prev + 1);
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
      enqueueMockHistoryTask({
        src: expanded || imageSrc,
        delayMs: 1600,
      });
    },
    [enqueueMockHistoryTask, expandOrigin.x, expandOrigin.y, generateExpandedImage, imageSrc],
  );

  const handleUpscaleSend = useCallback(
    async (_payload: { resolution: '2k' | '4k' | '8k'; promptEnabled: boolean; prompt: string }) => {
      enqueueMockHistoryTask({ delayMs: 1800 });
    },
    [enqueueMockHistoryTask],
  );

  const handleQuickEditSend = useCallback(
    (_content: string) => {
      enqueueMockHistoryTask({
        src: imageSrc || currentSelectedSrc,
        delayMs: 1600,
      });
    },
    [currentSelectedSrc, enqueueMockHistoryTask, imageSrc],
  );

  const handleApplyToNode = useCallback(() => {
    setHostHistoryIndex(selectedHistoryIndex);
  }, [selectedHistoryIndex]);

  const handleAddNewNodeToCanvas = useCallback(() => {
    void 0;
  }, []);

  const handleExitTool = useCallback(() => {
    setActiveTool(null);
    setBottomActionMode('history-item');
    setQuickEditPickBoxes([]);
    setQuickEditPendingPicks([]);
    setQuickEditPickEnabled(false);
  }, []);

  const handleApplyToHistory = useCallback(async () => {
    if (!activeTool) return;
    if (activeTool === 'cutout' || activeTool === 'erase') {
      enqueueMockHistoryTask({
        delayMs: 1500,
      });
      return;
    }

    let src = imageSrc || currentSelectedSrc;
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
    // Same as Inpaint/enqueueMockHistoryTask after send: keep tool strip + bottom toolbar for current tool.
    setBottomActionMode('tool-apply-history');
    setToolSessionSeed((prev) => prev + 1);
  }, [
    activeTool,
    adjustValue,
    currentSelectedSrc,
    editorCanvas,
    enqueueMockHistoryTask,
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
    setActiveTool(null);
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

  const handleGridSliceSend = useCallback(async () => {
    const src = imageSrc || currentSelectedSrc;
    if (!src) return;
    const generated =
      (await generateGridSliceResultImage(
        src,
        Math.max(1, gridSlice.rows),
        Math.max(1, gridSlice.cols),
        selectedGridCells,
      )) ?? src;
    enqueueMockHistoryTask({ src: generated, delayMs: 1600 });
  }, [
    currentSelectedSrc,
    enqueueMockHistoryTask,
    generateGridSliceResultImage,
    gridSlice.cols,
    gridSlice.rows,
    imageSrc,
    selectedGridCells,
  ]);

  useEffect(() => {
    return () => {
      mockTaskTimersRef.current.forEach((timer) => window.clearTimeout(timer));
      mockTaskTimersRef.current = [];
      quickEditPickTimersRef.current.forEach((timer) => window.clearTimeout(timer));
      quickEditPickTimersRef.current = [];
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
          <div className='h-full min-h-0'>
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
                        onBackgroundRendered={handleCanvasCommit}
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
                      {activeTool === 'quick-edit' && quickEditPickEnabled && (
                        <div
                          className='absolute inset-0 z-20 cursor-crosshair'
                          role='button'
                          tabIndex={0}
                          aria-label='Quick edit pick surface'
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
                                transform: 'translate(-50%, calc(-100% - 10px))',
                              }}
                            >
                              <div className='inline-flex items-center gap-1.5 rounded-full border border-[#DBDBDB] bg-background-default-base px-2 py-1 shadow-[0_1px_3px_rgba(0,0,0,0.08)]'>
                                <span className='h-2.5 w-2.5 animate-spin rounded-full border border-[var(--color-icon-base)] border-t-transparent' />
                                <span className='text-[10px] font-medium leading-none text-text-default-base whitespace-nowrap'>
                                  Identifying...
                                </span>
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
                              <div className='absolute -left-1 -top-8 z-[8] pointer-events-auto'>
                                <RecognizedPickDropdown
                                  currentLabel={box.name}
                                  options={recognizedOverlayPresets.map((item) => ({ key: item.key, label: item.label }))}
                                  onSelect={(presetKey) => {
                                    const preset = recognizedOverlayPresets.find((item) => item.key === presetKey);
                                    if (!preset) return;
                                    setQuickEditPickBoxes((prev) =>
                                      prev.map((item) =>
                                        item.id === box.id
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
                                  }}
                                />
                              </div>
                            </div>
                          ))}
                        </div>
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
                    key={`inpaint-${toolSessionSeed}`}
                    canvas={editorCanvas}
                    active
                    baseImageSrc={imageSrc}
                    onCanvasCommit={handleCanvasCommit}
                    onClose={(nextImageSrc) => {
                      if (nextImageSrc) {
                        setImageSrc(nextImageSrc);
                        enqueueMockHistoryTask({
                          src: nextImageSrc,
                          delayMs: 1200,
                        });
                        return;
                      }
                      handleExitTool();
                    }}
                  />
                )}
                {bottomActionMode === 'tool-apply-history' && activeTool === 'quick-edit' && (
                  <QuickEditBottomToolbar
                    key={`quick-edit-${toolSessionSeed}`}
                    active
                    imageSrc={imageSrc}
                    pendingPicks={quickEditPendingPicks}
                    recognizedPicks={quickEditPickBoxes}
                    onStartPick={() => setQuickEditPickEnabled(true)}
                    onRemovePickBox={handleRemoveQuickEditPickBox}
                    onClose={handleExitTool}
                    onSend={handleQuickEditSend}
                  />
                )}
                {bottomActionMode === 'tool-apply-history' && activeTool === 'mark' && (
                  <MarkBottomToolbar
                    key={`mark-${toolSessionSeed}`}
                    canvas={editorCanvas}
                    active={isInpaintCanvasMode(activeTool)}
                    onCanvasCommit={handleCanvasCommit}
                    onClose={(nextImageSrc) => {
                      if (nextImageSrc) {
                        setImageSrc(nextImageSrc);
                        setBottomActionMode('tool-apply-history');
                        setToolSessionSeed((prev) => prev + 1);
                        return;
                      }
                      handleExitTool();
                    }}
                  />
                )}
                {bottomActionMode === 'tool-apply-history' && activeTool === 'graffiti' && (
                  <GraffitiBottomToolbar
                    key={`graffiti-${toolSessionSeed}`}
                    canvas={editorCanvas}
                    active={isInpaintCanvasMode(activeTool)}
                    onCanvasCommit={handleCanvasCommit}
                    onClose={(nextImageSrc) => {
                      if (nextImageSrc) {
                        setImageSrc(nextImageSrc);
                        enqueueMockHistoryTask({
                          src: nextImageSrc,
                          delayMs: 1400,
                        });
                        return;
                      }
                      handleExitTool();
                    }}
                  />
                )}
                {bottomActionMode === 'tool-apply-history' && activeTool === 'adjust' && (
                  <AdjustBottomToolbar
                    key={`adjust-${toolSessionSeed}`}
                    active={activeTool === 'adjust'}
                    onClose={handleExitTool}
                    onChange={setAdjustValue}
                    onSave={handleAdjustSave}
                  />
                )}
                {bottomActionMode === 'tool-apply-history' && activeTool === 'crop' && imageSize && (
                  <CropBottomToolbar
                    key={`crop-${toolSessionSeed}`}
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
                    key={`flip-rotate-${toolSessionSeed}`}
                    active={activeTool === 'flip-rotate'}
                    imageSrc={imageSrc}
                    onClose={handleExitTool}
                    onApply={handleFlipRotateApply}
                  />
                )}
                {bottomActionMode === 'tool-apply-history' && activeTool === 'expand' && imageSize && (
                  <ExpandBottomToolbar
                    key={`expand-${toolSessionSeed}`}
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
                    key={`upscale-${toolSessionSeed}`}
                    active={activeTool === 'upscale'}
                    onClose={handleExitTool}
                    onSend={(payload) => {
                      void handleUpscaleSend(payload);
                    }}
                  />
                )}
                {bottomActionMode === 'tool-apply-history' && activeTool === 'grid-slice' && (
                  <GridSliceBottomToolbar
                    key={`grid-slice-${toolSessionSeed}`}
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
                  <RelightBottomToolbar
                    key={`relight-${toolSessionSeed}`}
                    active
                    onClose={handleExitTool}
                    imageSrc={imageSrc}
                    onSend={() =>
                      enqueueMockHistoryTask({
                        delayMs: 1800,
                      })
                    }
                  />
                )}
                {bottomActionMode === 'tool-apply-history' && activeTool === 'multi-angle' && (
                  <MultiAngleBottomToolbar
                    key={`multi-angle-${toolSessionSeed}`}
                    active
                    onClose={handleExitTool}
                    imageSrc={imageSrc}
                    onSend={() =>
                      enqueueMockHistoryTask({
                        delayMs: 1800,
                      })
                    }
                  />
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
                {bottomActionMode === 'tool-apply-history' &&
                  activeTool != null &&
                  !toolsAutoAddHistoryOnSend.has(activeTool) && (
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

