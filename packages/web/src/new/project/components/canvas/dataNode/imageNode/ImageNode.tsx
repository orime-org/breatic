/**
 * Local image node (type `1002`) — inline editing on the canvas (mixed-editor parity): toolbars + fabric surface + overlays.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  addEdge,
  NodeToolbar as FlowNodeToolbar,
  Position,
  useReactFlow,
  useStore,
  useViewport,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import { nanoid } from 'nanoid';
import { useTranslation } from 'react-i18next';
import { Icon } from '@/components/base/icon';
import { cn } from '@/utils/classnames';
import { message } from '@/components/base/message';
import CanvasOutputPendingProgressOverlay from '../../common/CanvasOutputPendingProgressOverlay';
import { Canvas, FabricImage } from 'fabric';
import type { LocalCanvasNodeData } from '@/new/project/types';
import LocalNodeHeader from '../../common/LocalNodeHeader';
import LocalDataNodeHandle from '../../common/LocalDataNodeHandle';
import LocalNodeSkeleton, { zoomLevelShowContentSelector } from '../../common/LocalNodeSkeleton';
import { selectFlowCanvasSelectedCount } from '../../flow/flowCanvasSelection';
import LocalImageNodeContent from './LocalImageNodeContent';
import Toolbar from './Toolbar';
import BottomToolbar from './BottomToolbar';
import { useCanvasNodeActions } from '../../context/CanvasNodeActionsContext';
import MarkBottomToolbar from './mark/MarkBottomToolbar';
import GraffitiBottomToolbar from './graffiti/GraffitiBottomToolbar';
import InpaintBottomToolbar from './inpaint/InpaintBottomToolbar';
import QuickEditBottomToolbar from './quickEdit/QuickEditBottomToolbar';
import GridSliceBottomToolbar from './gridSlice/GridSliceBottomToolbar';
import UpscaleBottomToolbar from './upscale/UpscaleBottomToolbar';
import MultiAngleBottomToolbar from './multiAngle/MultiAngleBottomToolbar';
import CropBottomToolbar from './crop/CropBottomToolbar';
import ExpandBottomToolbar, { type ExpandResolution } from './expand/ExpandBottomToolbar';
import ExpandOverlay, { type ExpandFrame } from './expand/ExpandOverlay';
import AdjustBottomToolbar, { defaultAdjustValue, type AdjustValue } from './adjust/AdjustBottomToolbar';
import RelightBottomToolbar from './relight/RelightBottomToolbar';
import FlipRotateBottomToolbar, { bitmapTransformToPngDataUrl, type FlipRotateBitmapOp } from './flipRotate/FlipRotateBottomToolbar';
import CropOverlay, { type CropRect } from './crop/CropOverlay';
import GridSliceOverlay from './gridSlice/GridSliceOverlay';
import ImageInpaintCanvas from './inpaint/ImageInpaintCanvas';
import { buildAdjustFabricFilters, isNeutralAdjustValue } from './adjust/adjustFilters';
import { localCropImageToObjectUrl } from './crop/localCropImageToObjectUrl';
import { CANVAS_SPAWNED_OUTPUT_GAP_PX } from '../../canvasSpawnLayout';

const defaultImageHandles: NonNullable<LocalCanvasNodeData['handles']> = {
  target: [{ handleType: 'Image', number: 0 }],
  source: [{ handleType: 'Image', number: 0 }],
};

function shouldShowImageFlowStandardToolbars(params: {
  selected: boolean;
  /** Exactly one selectable node on the canvas (excl. connect-end anchor) — hide per-node bars when box-selecting many. */
  flowCanvasSelectedCount: number;
  dragging: boolean;
  isEditing: boolean;
  hasImageContent: boolean;
  suppressForChatRecordPick: boolean;
}): boolean {
  return (
    params.selected &&
    params.flowCanvasSelectedCount === 1 &&
    !params.dragging &&
    !params.isEditing &&
    params.hasImageContent &&
    !params.suppressForChatRecordPick
  );
}

type EditingMode =
  | 'inpaint'
  | 'mark'
  | 'graffiti'
  | 'enhance'
  | 'upscale'
  | 'quickEdit'
  | 'multiAngle'
  | 'crop'
  | 'expand'
  | 'adjust'
  | 'relight'
  | 'flipRotate'
  | null;

function isInpaintCanvasEditingMode(mode: EditingMode): boolean {
  return mode === 'inpaint' || mode === 'mark' || mode === 'graffiti' || mode === 'adjust';
}

const targetHandleId = 'Image_0_0';
const sourceHandleId = 'Image_0_0';

const defaultNodeWidth = 300;
const defaultNodeHeight = 250;
const imageFlowHandleId = 'Image_0_0';
const enhanceDefaultGridSlice = { rows: 3, cols: 3 };

/**
 * Reads intrinsic pixel size for a raster `src` (blob / data / http).
 *
 * @returns `{ w, h }` or `null` if decode fails.
 */
async function readNaturalImageSize(src: string): Promise<{ w: number; h: number } | null> {
  const image = new window.Image();
  image.crossOrigin = 'anonymous';
  image.src = src;
  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('image load failed'));
    });
  } catch {
    return null;
  }
  const w = image.naturalWidth;
  const h = image.naturalHeight;
  if (!w || !h) return null;
  return { w, h };
}

function computeDisplaySize(naturalWidth: number, naturalHeight: number): { width: number; height: number } {
  if (naturalWidth <= 0 || naturalHeight <= 0) {
    return { width: defaultNodeWidth, height: defaultNodeHeight };
  }
  const isLandscape = naturalWidth >= naturalHeight;
  if (isLandscape) {
    const h = Math.max(Math.round(defaultNodeWidth * (naturalHeight / naturalWidth)), defaultNodeHeight);
    return { width: Math.round(h * (naturalWidth / naturalHeight)), height: h };
  }
  return {
    width: defaultNodeWidth,
    height: Math.round(defaultNodeWidth * (naturalHeight / naturalWidth)),
  };
}

interface EnhanceCell {
  row: number;
  col: number;
}

const ImageNode: React.FC<NodeProps<Node<LocalCanvasNodeData>>> = ({ id, type, data, selected, dragging }) => {
  const { t } = useTranslation();
  const { setNodes, setCenter, getNodes, setEdges } = useReactFlow();
  const { zoom } = useViewport();
  const { duplicateMediaNode } = useCanvasNodeActions();
  const showContent = useStore(zoomLevelShowContentSelector);
  const flowCanvasSelectedCount = useStore(useCallback((s) => selectFlowCanvasSelectedCount(s), []));
  const nodeFromStore = useStore(useCallback((state) => state.nodes.find((n) => n.id === id), [id]));

  const title = data.name?.trim() ? data.name : 'Image';
  const url = data.url?.trim() ?? '';
  const [nodeHovered, setNodeHovered] = useState(false);
  const [contentHeight, setContentHeight] = useState<number | null>(null);
  const [contentWidth, setContentWidth] = useState<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [editingMode, setEditingMode] = useState<EditingMode>(null);
  const [cropRect, setCropRect] = useState<CropRect>({ x: 0, y: 0, w: defaultNodeWidth, h: defaultNodeHeight });
  const [expandSize, setExpandSize] = useState<{ w: number; h: number }>({
    w: defaultNodeWidth,
    h: defaultNodeHeight,
  });
  const [expandOrigin, setExpandOrigin] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [inpaintCanvas, setInpaintCanvas] = useState<Canvas | null>(null);
  const [adjustValue, setAdjustValue] = useState<AdjustValue>(defaultAdjustValue);
  const [enhanceGridSlice, setEnhanceGridSlice] = useState(enhanceDefaultGridSlice);
  const [enhanceSelectedCells, setEnhanceSelectedCells] = useState<string[]>([]);
  const [quickEditPendingPicks, setQuickEditPendingPicks] = useState<Array<{ id: string }>>([]);
  const [quickEditRecognizedPicks, setQuickEditRecognizedPicks] = useState<Array<{ id: string; name: string }>>([]);

  const applyContentSizeFromDimensions = useCallback((naturalWidth: number, naturalHeight: number) => {
    const d = computeDisplaySize(naturalWidth, naturalHeight);
    setContentWidth(d.width);
    setContentHeight(d.height);
  }, []);

  useEffect(() => {
    if (!url.trim()) {
      setContentWidth(null);
      setContentHeight(null);
    }
  }, [url]);

  const outerW = url ? (contentWidth ?? defaultNodeWidth) : defaultNodeWidth;
  const outerH = url ? (contentHeight ?? defaultNodeHeight) : defaultNodeHeight;
  const width = Math.max(1, Math.round(outerW));
  const height = Math.max(1, Math.round(outerH));

  /** Keep React Flow node `style` in sync so `NodeToolbar` anchors and selection use the real shell size. */
  useEffect(() => {
    const st = (nodeFromStore?.style ?? {}) as { width?: unknown; height?: unknown };
    const sw = typeof st.width === 'number' && Number.isFinite(st.width) ? st.width : -1;
    const sh = typeof st.height === 'number' && Number.isFinite(st.height) ? st.height : -1;
    if (sw === width && sh === height) return;
    setNodes((nds) =>
      nds.map((n) => {
        if (n.id !== id) return n;
        const prevStyle = (n.style ?? {}) as Record<string, unknown>;
        return { ...n, style: { ...prevStyle, width, height } };
      }),
    );
  }, [height, id, nodeFromStore?.style, setNodes, width]);

  const applyUrlToNode = useCallback(
    (nextUrl: string) => {
      setNodes((nds) =>
        nds.map((n) => {
          if (n.id !== id) return n;
          const prev = (n.data ?? {}) as LocalCanvasNodeData;
          const oldUrl = prev.url?.trim();
          if (oldUrl?.startsWith('blob:') && oldUrl !== nextUrl) URL.revokeObjectURL(oldUrl);
          return { ...n, data: { ...prev, url: nextUrl } };
        }),
      );
    },
    [id, setNodes],
  );

  /**
   * Spawns a placeholder image node to the right (same gap + edge as generator send), runs `produce`, then fills URL and clears pending.
   */
  const commitImageToolOutputViaPlaceholder = useCallback(
    async (opts: {
      nameSuffix: string;
      /** When output pixel size is known before `produce` (e.g. crop). */
      resultNaturalSize?: { w: number; h: number } | null;
      produce: () => Promise<{ nextUrl: string; naturalOverride?: { w: number; h: number } } | null>;
    }) => {
      const { nameSuffix, resultNaturalSize, produce } = opts;
      const all = getNodes() as Node<LocalCanvasNodeData>[];
      const source = all.find((n) => n.id === id);
      if (!source) return;

      const prev = (source.data ?? {}) as LocalCanvasNodeData;
      const baseName = prev.name?.trim() ? prev.name.trim() : 'Image';
      const sourceStyle = (source.style ?? {}) as { width?: number; height?: number };
      const sourceShellW =
        typeof sourceStyle.width === 'number' && Number.isFinite(sourceStyle.width) ? sourceStyle.width : Math.round(outerW);

      const shellDims = resultNaturalSize
        ? computeDisplaySize(resultNaturalSize.w, resultNaturalSize.h)
        : { width: defaultNodeWidth, height: defaultNodeHeight };
      const shellW = Math.max(1, Math.round(shellDims.width));
      const shellH = Math.max(1, Math.round(shellDims.height));

      const newId = `1002-${Date.now()}-${nanoid(5)}`;
      const maxZ = all.reduce((m, n) => Math.max(m, (n as Node & { zIndex?: number }).zIndex ?? 0), 0);
      const edgeId = `e-${id}-${imageFlowHandleId}-${newId}-${imageFlowHandleId}`;

      const placeholderNode: Node<LocalCanvasNodeData> = {
        id: newId,
        type: '1002',
        position: { x: source.position.x + sourceShellW + CANVAS_SPAWNED_OUTPUT_GAP_PX, y: source.position.y },
        zIndex: maxZ + 1,
        selected: true,
        style: { width: shellW, height: shellH },
        data: {
          name: `${baseName} (${nameSuffix})`,
          url: '',
          handles: defaultImageHandles,
          localOutputPending: true,
        },
      };

      setNodes((nds) => [...nds.map((n) => ({ ...n, selected: false })), placeholderNode]);
      setEdges((eds) => {
        if (eds.some((e) => e.id === edgeId)) return eds;
        return addEdge(
          {
            id: edgeId,
            source: id,
            target: newId,
            sourceHandle: imageFlowHandleId,
            targetHandle: imageFlowHandleId,
            type: 'default',
          },
          eds,
        );
      });

      try {
        const result = await produce();
        if (!result) {
          setNodes((nds) => nds.filter((n) => n.id !== newId));
          setEdges((eds) => eds.filter((e) => e.id !== edgeId));
          return;
        }
        const natural = result.naturalOverride ?? (await readNaturalImageSize(result.nextUrl));
        const dims = natural ? computeDisplaySize(natural.w, natural.h) : { width: defaultNodeWidth, height: defaultNodeHeight };
        const fw = Math.max(1, Math.round(dims.width));
        const fh = Math.max(1, Math.round(dims.height));
        setNodes((nds) => {
          const top = nds.reduce((m, x) => Math.max(m, (x as Node & { zIndex?: number }).zIndex ?? 0), 0);
          return nds.map((n) => {
            if (n.id !== newId) {
              return { ...n, selected: false };
            }
            return {
              ...n,
              zIndex: top + 1,
              selected: true,
              style: { ...(n.style as Record<string, unknown>), width: fw, height: fh },
              data: {
                ...(n.data ?? {}),
                url: result.nextUrl,
                localOutputPending: false,
              } as LocalCanvasNodeData,
            };
          });
        });
      } catch {
        setNodes((nds) => nds.filter((n) => n.id !== newId));
        setEdges((eds) => eds.filter((e) => e.id !== edgeId));
      }
    },
    [getNodes, id, outerW, setEdges, setNodes],
  );

  const replaceNodeWithFile = useCallback(
    (_nid: string, file: File) => {
      const resourceUrl = URL.createObjectURL(file);
      applyUrlToNode(resourceUrl);
    },
    [applyUrlToNode],
  );

  const handlePlaceholderClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      setNodes((nds) => nds.map((n) => ({ ...n, selected: n.id === id })));
    },
    [id, setNodes],
  );

  const handlePlaceholderDoubleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    fileInputRef.current?.click();
  }, []);

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = '';
      if (!file) return;
      replaceNodeWithFile(id, file);
    },
    [id, replaceNodeWithFile],
  );

  const focusCurrentNode = useCallback(
    (z = 1.2) => {
      if (!nodeFromStore?.position) return;
      const centerX = nodeFromStore.position.x + width / 2;
      const centerY = nodeFromStore.position.y + height / 2;
      setCenter(centerX, centerY, { zoom: z, duration: 220 });
    },
    [height, id, nodeFromStore?.position, setCenter, width],
  );

  const exitEditing = useCallback(() => {
    setEditingMode(null);
  }, []);

  useEffect(() => {
    if (editingMode === null) return undefined;
    setNodes((nds) => nds.map((n) => (n.id === id ? { ...n, draggable: false } : n)));
    return () => {
      setNodes((nds) => nds.map((n) => (n.id === id ? { ...n, draggable: true } : n)));
    };
  }, [editingMode, id, setNodes]);

  const handleInpaintFocus = useCallback(() => {
    focusCurrentNode();
    setEditingMode('inpaint');
  }, [focusCurrentNode]);

  const handleQuickEditOpen = useCallback(() => {
    setQuickEditPendingPicks([]);
    setQuickEditRecognizedPicks([]);
    setEditingMode('quickEdit');
  }, []);

  const handleMarkFocus = useCallback(() => {
    focusCurrentNode();
    setEditingMode('mark');
  }, [focusCurrentNode]);

  const handleGraffitiFocus = useCallback(() => {
    focusCurrentNode();
    setEditingMode('graffiti');
  }, [focusCurrentNode]);

  const handleEnhanceOpen = useCallback(() => {
    setEditingMode('upscale');
  }, []);

  const handleGridSliceOpen = useCallback(() => {
    focusCurrentNode();
    setEnhanceGridSlice(enhanceDefaultGridSlice);
    setEnhanceSelectedCells([]);
    setEditingMode('enhance');
  }, [focusCurrentNode]);

  const handleEnhanceGridSliceChange = useCallback((next: { rows: number; cols: number }) => {
    setEnhanceGridSlice(next);
    setEnhanceSelectedCells((prev) =>
      prev.filter((key) => {
        const [row, col] = key.split('-').map(Number);
        if (!Number.isFinite(row) || !Number.isFinite(col)) return false;
        return row >= 1 && row <= next.rows && col >= 1 && col <= next.cols;
      }),
    );
  }, []);

  const handleEnhanceCellToggle = useCallback((row: number, col: number) => {
    const key = `${row}-${col}`;
    setEnhanceSelectedCells((prev) => (prev.includes(key) ? prev.filter((item) => item !== key) : [...prev, key]));
  }, []);

  const handleCropOpen = useCallback(() => {
    focusCurrentNode();
    setCropRect({ x: 0, y: 0, w: width, h: height });
    setEditingMode('crop');
  }, [focusCurrentNode, height, width]);

  const handleExpandOpen = useCallback(() => {
    const cw = Math.max(1, Math.round(width));
    const ch = Math.max(1, Math.round(height));
    const pad = 40;
    setExpandSize({ w: cw + pad * 2, h: ch + pad * 2 });
    setExpandOrigin({ x: -pad, y: -pad });
    setEditingMode('expand');
    focusCurrentNode(0.6);
  }, [focusCurrentNode, height, width]);

  const handleExpandDimensionChange = useCallback(
    (w: number, h: number, keepCentered = false) => {
      const cw = Math.max(1, Math.round(width));
      const ch = Math.max(1, Math.round(height));
      const ow = Math.max(cw, Math.round(w));
      const oh = Math.max(ch, Math.round(h));
      if (keepCentered) {
        setExpandOrigin({ x: (cw - ow) / 2, y: (ch - oh) / 2 });
      }
      setExpandSize({ w: ow, h: oh });
    },
    [height, width],
  );

  const handleExpandFrameChange = useCallback(
    (next: ExpandFrame) => {
      const cw = Math.max(1, Math.round(width));
      const ch = Math.max(1, Math.round(height));
      setExpandSize({ w: Math.max(cw, next.w), h: Math.max(ch, next.h) });
      setExpandOrigin({ x: next.ox, y: next.oy });
    },
    [height, width],
  );

  const handleAdjustOpen = useCallback(() => {
    setAdjustValue(defaultAdjustValue);
    setEditingMode('adjust');
  }, []);

  const handleRelightOpen = useCallback(() => {
    setEditingMode('relight');
  }, []);

  const handleFlipRotateOpen = useCallback(() => {
    setEditingMode('flipRotate');
  }, []);

  const handleMultiAngleOpen = useCallback(() => {
    setEditingMode('multiAngle');
  }, []);

  const handleInpaintClose = useCallback(
    (nextImageSrc?: string) => {
      exitEditing();
      if (nextImageSrc) {
        void commitImageToolOutputViaPlaceholder({
          nameSuffix: 'edited',
          produce: async () => ({ nextUrl: nextImageSrc }),
        });
      }
    },
    [commitImageToolOutputViaPlaceholder, exitEditing],
  );

  const handleEnhanceClose = useCallback(() => exitEditing(), [exitEditing]);
  const handleUpscaleClose = useCallback(() => exitEditing(), [exitEditing]);
  const handleCropClose = useCallback(() => exitEditing(), [exitEditing]);
  const handleExpandClose = useCallback(() => exitEditing(), [exitEditing]);
  const handleMultiAngleClose = useCallback(() => exitEditing(), [exitEditing]);
  const handleAdjustClose = useCallback(() => exitEditing(), [exitEditing]);
  const handleRelightClose = useCallback(() => exitEditing(), [exitEditing]);
  const handleFlipRotateClose = useCallback(() => exitEditing(), [exitEditing]);
  const handleQuickEditClose = useCallback(() => exitEditing(), [exitEditing]);

  const computeSourceCropRect = useCallback(
    async (src: string, rect: CropRect): Promise<{ x: number; y: number; w: number; h: number } | null> => {
      const image = new window.Image();
      image.crossOrigin = 'anonymous';
      image.src = src;
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error('crop image load failed'));
      });
      const naturalW = image.naturalWidth;
      const naturalH = image.naturalHeight;
      if (!naturalW || !naturalH) return null;
      const scale = Math.max(width / naturalW, height / naturalH);
      const drawnW = naturalW * scale;
      const drawnH = naturalH * scale;
      const offsetX = (width - drawnW) / 2;
      const offsetY = (height - drawnH) / 2;
      const sx = Math.max(0, Math.min(naturalW, (rect.x - offsetX) / scale));
      const sy = Math.max(0, Math.min(naturalH, (rect.y - offsetY) / scale));
      const sRight = Math.max(0, Math.min(naturalW, (rect.x + rect.w - offsetX) / scale));
      const sBottom = Math.max(0, Math.min(naturalH, (rect.y + rect.h - offsetY) / scale));
      const sw = Math.max(1, sRight - sx);
      const sh = Math.max(1, sBottom - sy);
      return { x: Math.round(sx), y: Math.round(sy), w: Math.max(1, Math.round(sw)), h: Math.max(1, Math.round(sh)) };
    },
    [height, width],
  );

  const handleCropSave = useCallback(async () => {
    const currentRect = cropRect;
    const currentSrc = url;
    exitEditing();
    if (!currentSrc) return;
    try {
      const sourceRect = await computeSourceCropRect(currentSrc, currentRect);
      if (!sourceRect) {
        message.warning('Could not read image dimensions for crop.');
        return;
      }
      await commitImageToolOutputViaPlaceholder({
        nameSuffix: 'crop',
        resultNaturalSize: { w: sourceRect.w, h: sourceRect.h },
        produce: async () => {
          const nextUrl = await localCropImageToObjectUrl(currentSrc, {
            x: sourceRect.x,
            y: sourceRect.y,
            width: sourceRect.w,
            height: sourceRect.h,
          });
          return { nextUrl, naturalOverride: { w: sourceRect.w, h: sourceRect.h } };
        },
      });
    } catch {
      message.warning('Crop failed. Remote images may be blocked by CORS.');
    }
  }, [commitImageToolOutputViaPlaceholder, computeSourceCropRect, cropRect, exitEditing, url]);

  const generateExpandedImage = useCallback(
    async (
      src: string,
      frame: { w: number; h: number; ox: number; oy: number },
    ): Promise<{ src: string; width: number; height: number } | null> => {
      const image = new window.Image();
      image.crossOrigin = 'anonymous';
      image.src = src;
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error('expand image load failed'));
      });
      const naturalW = image.naturalWidth;
      const naturalH = image.naturalHeight;
      if (!naturalW || !naturalH) return null;
      const outW = Math.max(1, Math.round(frame.w));
      const outH = Math.max(1, Math.round(frame.h));
      const outputCanvas = document.createElement('canvas');
      outputCanvas.width = outW;
      outputCanvas.height = outH;
      const ctx = outputCanvas.getContext('2d');
      if (!ctx) return null;
      const scale = Math.max(width / naturalW, height / naturalH);
      const drawnW = naturalW * scale;
      const drawnH = naturalH * scale;
      const offsetXInNode = (width - drawnW) / 2;
      const offsetYInNode = (height - drawnH) / 2;
      const nodeLeftInFrame = -frame.ox;
      const nodeTopInFrame = -frame.oy;
      ctx.drawImage(image, nodeLeftInFrame + offsetXInNode, nodeTopInFrame + offsetYInNode, drawnW, drawnH);
      return { src: outputCanvas.toDataURL('image/png'), width: outW, height: outH };
    },
    [height, width],
  );

  const handleExpandSend = useCallback(
    async (payload: { width: number; height: number; resolution: ExpandResolution; ratio: string }) => {
      const currentSrc = url;
      const frame = {
        w: Math.max(1, Math.round(payload.width)),
        h: Math.max(1, Math.round(payload.height)),
        ox: expandOrigin.x,
        oy: expandOrigin.y,
      };
      handleExpandClose();
      if (!currentSrc) return;
      try {
        await commitImageToolOutputViaPlaceholder({
          nameSuffix: 'expand',
          produce: async () => {
            const expanded = await generateExpandedImage(currentSrc, frame);
            if (!expanded) return null;
            return { nextUrl: expanded.src, naturalOverride: { w: expanded.width, h: expanded.height } };
          },
        });
      } catch {
        message.warning('Expand preview failed.');
      }
    },
    [commitImageToolOutputViaPlaceholder, expandOrigin.x, expandOrigin.y, generateExpandedImage, handleExpandClose, url],
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
      handleAdjustClose();
      if (!url) return;
      if (isNeutralAdjustValue(value)) return;
      try {
        await commitImageToolOutputViaPlaceholder({
          nameSuffix: 'adjust',
          produce: async () => {
            const nextImageSrc = await generateAdjustedImage(url, value);
            return nextImageSrc ? { nextUrl: nextImageSrc } : null;
          },
        });
      } catch {
        message.warning('Adjust export failed.');
      }
    },
    [commitImageToolOutputViaPlaceholder, generateAdjustedImage, handleAdjustClose, url],
  );

  const handleFlipRotateApply = useCallback(
    async (op: FlipRotateBitmapOp) => {
      const src = url;
      if (!src) return;
      await commitImageToolOutputViaPlaceholder({
        nameSuffix: 'flip-rotate',
        produce: async () => {
          const { dataUrl, outWidth, outHeight } = await bitmapTransformToPngDataUrl(src, op);
          return { nextUrl: dataUrl, naturalOverride: { w: outWidth, h: outHeight } };
        },
      });
    },
    [commitImageToolOutputViaPlaceholder, url],
  );

  const buildEnhanceCells = useCallback((rows: number, cols: number, selectedCells: string[]): EnhanceCell[] => {
    if (selectedCells.length > 0) {
      const parsed = selectedCells
        .map((key) => {
          const [row, col] = key.split('-').map(Number);
          return { row, col };
        })
        .filter(
          (cell) =>
            Number.isFinite(cell.row) &&
            Number.isFinite(cell.col) &&
            cell.row >= 1 &&
            cell.row <= rows &&
            cell.col >= 1 &&
            cell.col <= cols,
        );
      if (parsed.length > 0) {
        return parsed.sort((a, b) => a.row - b.row || a.col - b.col);
      }
    }
    return Array.from({ length: rows }, (_, rowIndex) =>
      Array.from({ length: cols }, (_, colIndex) => ({ row: rowIndex + 1, col: colIndex + 1 })),
    ).flat();
  }, []);

  const generateEnhanceGridSlices = useCallback(
    async (
      src: string,
      rows: number,
      cols: number,
      targetCells: EnhanceCell[],
    ): Promise<Array<{ row: number; col: number; src: string; width: number; height: number }>> => {
      const image = new window.Image();
      image.crossOrigin = 'anonymous';
      image.src = src;
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error('enhance image load failed'));
      });
      const naturalW = image.naturalWidth;
      const naturalH = image.naturalHeight;
      if (!naturalW || !naturalH) return [];
      const scale = Math.max(width / naturalW, height / naturalH);
      const drawnW = naturalW * scale;
      const drawnH = naturalH * scale;
      const offsetX = (width - drawnW) / 2;
      const offsetY = (height - drawnH) / 2;
      const viewCellW = width / Math.max(1, cols);
      const viewCellH = height / Math.max(1, rows);
      return targetCells.map((cell) => {
        const viewX = (cell.col - 1) * viewCellW;
        const viewY = (cell.row - 1) * viewCellH;
        const sx = Math.max(0, Math.min(naturalW, (viewX - offsetX) / scale));
        const sy = Math.max(0, Math.min(naturalH, (viewY - offsetY) / scale));
        const sRight = Math.max(0, Math.min(naturalW, (viewX + viewCellW - offsetX) / scale));
        const sBottom = Math.max(0, Math.min(naturalH, (viewY + viewCellH - offsetY) / scale));
        const sw = Math.max(1, sRight - sx);
        const sh = Math.max(1, sBottom - sy);
        const outputCanvas = document.createElement('canvas');
        outputCanvas.width = Math.max(1, Math.round(sw));
        outputCanvas.height = Math.max(1, Math.round(sh));
        const ctx = outputCanvas.getContext('2d');
        if (!ctx) {
          return { row: cell.row, col: cell.col, src, width: Math.max(1, Math.round(sw)), height: Math.max(1, Math.round(sh)) };
        }
        ctx.drawImage(image, sx, sy, sw, sh, 0, 0, outputCanvas.width, outputCanvas.height);
        return {
          row: cell.row,
          col: cell.col,
          src: outputCanvas.toDataURL('image/png'),
          width: outputCanvas.width,
          height: outputCanvas.height,
        };
      });
    },
    [height, width],
  );

  const handleEnhanceSend = useCallback(
    async (payload: {
      resolution: 'none' | '2k' | '4k' | '8k';
      gridSlice: { rows: number; cols: number };
      selectedCells: string[];
      promptEnabled: boolean;
      prompt: string;
    }) => {
      void payload;
      handleEnhanceClose();
      if (!url) return;
      const rows = Math.max(1, payload.gridSlice.rows);
      const cols = Math.max(1, payload.gridSlice.cols);
      const targetCells = buildEnhanceCells(rows, cols, payload.selectedCells);
      try {
        const results = await generateEnhanceGridSlices(url, rows, cols, targetCells);
        if (results.length === 0) return;
        const ts = Date.now();
        const newIds = results.map((_, i) => `1002-${ts}-${nanoid(5)}-${i}`);
        setNodes((nds) => {
          const source = nds.find((n) => n.id === id);
          if (!source) return nds;
          const baseName = ((source.data ?? {}) as LocalCanvasNodeData).name?.trim() || 'Image';
          const startX = source.position.x + outerW + CANVAS_SPAWNED_OUTPUT_GAP_PX;
          const startY = source.position.y;
          const maxZ = nds.reduce((m, n) => Math.max(m, (n as Node & { zIndex?: number }).zIndex ?? 0), 0);
          const newNodes: Node[] = results.map((item, i) => {
            const dims = computeDisplaySize(item.width, item.height);
            return {
              id: newIds[i]!,
              type: '1002',
              position: { x: startX, y: startY + i * (dims.height + 16) },
              zIndex: maxZ + 1 + i,
              selected: true,
              style: { width: dims.width, height: dims.height },
              data: {
                name: `${baseName} (${item.row}-${item.col})`,
                url: item.src,
                handles: defaultImageHandles,
              } satisfies LocalCanvasNodeData,
            };
          });
          return [...nds.map((n) => ({ ...n, selected: false })), ...newNodes];
        });
        setEdges((eds) => {
          let next = eds;
          for (const nid of newIds) {
            const eid = `e-${id}-${imageFlowHandleId}-${nid}-${imageFlowHandleId}`;
            if (next.some((e) => e.id === eid)) continue;
            next = addEdge(
              {
                id: eid,
                source: id,
                target: nid,
                sourceHandle: imageFlowHandleId,
                targetHandle: imageFlowHandleId,
                type: 'default',
              },
              next,
            );
          }
          return next;
        });
      } catch {
        message.warning('Grid slice failed.');
      }
    },
    [buildEnhanceCells, generateEnhanceGridSlices, handleEnhanceClose, id, outerW, setEdges, setNodes, url],
  );

  const handleUpscaleSend = useCallback(
    async (_payload: { resolution: '2k' | '4k' | '8k'; promptEnabled: boolean; prompt: string }) => {
      void _payload;
      handleUpscaleClose();
      message.warning('Image upscale uses the connected project editor and worker; local canvas keeps preview tools only.');
    },
    [handleUpscaleClose],
  );

  const handleQuickEditSend = useCallback(
    (_content: string) => {
      handleQuickEditClose();
      message.warning('Quick edit dispatches to the agent in the full project; use inpaint/mark for local edits.');
    },
    [handleQuickEditClose],
  );

  const isEditing = editingMode !== null;
  const showStandardToolbars = shouldShowImageFlowStandardToolbars({
    selected: Boolean(selected),
    flowCanvasSelectedCount,
    dragging: Boolean(dragging),
    isEditing,
    hasImageContent: Boolean(url),
    suppressForChatRecordPick: false,
  });
  const soloFlowChrome = Boolean(selected) && flowCanvasSelectedCount === 1;
  const showInpaintCanvas = isInpaintCanvasEditingMode(editingMode);

  const expandToolbarBottomOffset = useMemo(
    () => 12 + Math.max(0, expandOrigin.y + expandSize.h - height) * zoom,
    [expandOrigin.y, expandSize.h, height, zoom],
  );
  const expandToolbarTranslateX = useMemo(
    () => (expandOrigin.x + expandSize.w / 2 - width / 2) * zoom,
    [expandOrigin.x, expandSize.w, width, zoom],
  );

  return (
    <>
      <FlowNodeToolbar position={Position.Top} align='center' offset={50} isVisible={showStandardToolbars}>
        <Toolbar
          nodeId={id}
          onReplace={replaceNodeWithFile}
          onCrop={(_nid) => {
            void _nid;
            handleCropOpen();
          }}
          onExpand={(_nid) => {
            void _nid;
            handleExpandOpen();
          }}
          onAdjust={(_nid) => {
            void _nid;
            handleAdjustOpen();
          }}
          onInpaint={(_nid) => {
            void _nid;
            handleInpaintFocus();
          }}
          onQuickEdit={(_nid) => {
            void _nid;
            handleQuickEditOpen();
          }}
          onMark={(_nid) => {
            void _nid;
            handleMarkFocus();
          }}
          onEnhance={(_nid) => {
            void _nid;
            handleEnhanceOpen();
          }}
          onMultiAngle={(_nid) => {
            void _nid;
            handleMultiAngleOpen();
          }}
          onRelight={(_nid) => {
            void _nid;
            handleRelightOpen();
          }}
          onGridSlice={(_nid) => {
            void _nid;
            handleGridSliceOpen();
          }}
          onFlipRotate={(_nid) => {
            void _nid;
            handleFlipRotateOpen();
          }}
          onGraffiti={(_nid) => {
            void _nid;
            handleGraffitiFocus();
          }}
        />
      </FlowNodeToolbar>
      <FlowNodeToolbar position={Position.Bottom} align='center' offset={16} isVisible={showStandardToolbars}>
        <BottomToolbar
          imageSrc={url}
          onCreateNewNodeClick={() => {
            duplicateMediaNode(id);
          }}
        />
      </FlowNodeToolbar>
      <FlowNodeToolbar isVisible={editingMode === 'upscale' && soloFlowChrome} position={Position.Bottom} offset={12} align='center'>
        <UpscaleBottomToolbar active={editingMode === 'upscale'} onClose={handleUpscaleClose} onSend={handleUpscaleSend} />
      </FlowNodeToolbar>
      <FlowNodeToolbar isVisible={editingMode === 'quickEdit' && soloFlowChrome} position={Position.Bottom} offset={12} align='center'>
        <QuickEditBottomToolbar
          active={editingMode === 'quickEdit'}
          imageSrc={url}
          pendingPicks={quickEditPendingPicks}
          recognizedPicks={quickEditRecognizedPicks}
          onStartPick={() => {
            setQuickEditPendingPicks((p) => [...p, { id: nanoid(6) }]);
          }}
          onRemovePickBox={(pickId) => {
            setQuickEditPendingPicks((p) => p.filter((x) => x.id !== pickId));
            setQuickEditRecognizedPicks((p) => p.filter((x) => x.id !== pickId));
          }}
          onClose={handleQuickEditClose}
          onSend={handleQuickEditSend}
        />
      </FlowNodeToolbar>
      <FlowNodeToolbar
        isVisible={
          soloFlowChrome && (editingMode === 'inpaint' || editingMode === 'mark' || editingMode === 'graffiti')
        }
        position={Position.Bottom}
        offset={12}
        align='center'
      >
        {editingMode === 'inpaint' ? (
          <InpaintBottomToolbar
            canvas={inpaintCanvas}
            active={showInpaintCanvas}
            baseImageSrc={url}
            onClose={handleInpaintClose}
          />
        ) : editingMode === 'mark' ? (
          <MarkBottomToolbar canvas={inpaintCanvas} active={showInpaintCanvas} onClose={handleInpaintClose} />
        ) : (
          <GraffitiBottomToolbar canvas={inpaintCanvas} active={showInpaintCanvas} onClose={handleInpaintClose} />
        )}
      </FlowNodeToolbar>
      <FlowNodeToolbar isVisible={editingMode === 'enhance' && soloFlowChrome} position={Position.Bottom} offset={12} align='center'>
        <GridSliceBottomToolbar
          active={editingMode === 'enhance'}
          onClose={handleEnhanceClose}
          onSend={handleEnhanceSend}
          gridSlice={enhanceGridSlice}
          onGridSliceChange={handleEnhanceGridSliceChange}
          selectedCellCount={enhanceSelectedCells.length}
          selectedCells={enhanceSelectedCells}
        />
      </FlowNodeToolbar>
      <FlowNodeToolbar isVisible={editingMode === 'crop' && soloFlowChrome} position={Position.Bottom} offset={12} align='center'>
        <CropBottomToolbar
          active={editingMode === 'crop'}
          width={cropRect.w}
          height={cropRect.h}
          containerWidth={width}
          containerHeight={height}
          onDimensionChange={(w, h, kc) => {
            setCropRect((prev) => {
              if (kc) {
                return {
                  x: Math.max(0, Math.round((width - w) / 2)),
                  y: Math.max(0, Math.round((height - h) / 2)),
                  w,
                  h,
                };
              }
              const maxX = Math.max(0, width - w);
              const maxY = Math.max(0, height - h);
              return {
                x: Math.min(maxX, Math.max(0, prev.x)),
                y: Math.min(maxY, Math.max(0, prev.y)),
                w,
                h,
              };
            });
          }}
          onClose={handleCropClose}
          onSave={handleCropSave}
        />
      </FlowNodeToolbar>
      <FlowNodeToolbar
        isVisible={editingMode === 'expand' && soloFlowChrome}
        position={Position.Bottom}
        offset={expandToolbarBottomOffset}
        align='center'
      >
        <div
          className='pointer-events-auto'
          style={expandToolbarTranslateX !== 0 ? { transform: `translateX(${expandToolbarTranslateX}px)` } : undefined}
        >
          <ExpandBottomToolbar
            active={editingMode === 'expand'}
            width={expandSize.w}
            height={expandSize.h}
            containerWidth={width}
            containerHeight={height}
            onDimensionChange={handleExpandDimensionChange}
            onClose={handleExpandClose}
            onSend={handleExpandSend}
          />
        </div>
      </FlowNodeToolbar>
      <FlowNodeToolbar isVisible={editingMode === 'multiAngle' && soloFlowChrome} position={Position.Bottom} offset={12} align='center'>
        <MultiAngleBottomToolbar
          active={editingMode === 'multiAngle'}
          onClose={handleMultiAngleClose}
          imageSrc={url}
          onSend={() =>
            message.warning('Multi-angle generation uses the project worker; preview angles locally in the toolbar.')
          }
        />
      </FlowNodeToolbar>
      <FlowNodeToolbar isVisible={editingMode === 'adjust' && soloFlowChrome} position={Position.Bottom} offset={12} align='center'>
        <AdjustBottomToolbar
          active={editingMode === 'adjust'}
          onClose={handleAdjustClose}
          onChange={setAdjustValue}
          onSave={handleAdjustSave}
        />
      </FlowNodeToolbar>
      <FlowNodeToolbar isVisible={editingMode === 'relight' && soloFlowChrome} position={Position.Bottom} offset={12} align='center'>
        <RelightBottomToolbar
          active={editingMode === 'relight'}
          onClose={handleRelightClose}
          imageSrc={url}
          onSend={() => message.warning('Relight export uses the project worker.')}
        />
      </FlowNodeToolbar>
      <FlowNodeToolbar isVisible={editingMode === 'flipRotate' && soloFlowChrome} position={Position.Bottom} offset={12} align='center'>
        <FlipRotateBottomToolbar
          active={editingMode === 'flipRotate'}
          imageSrc={url}
          onClose={handleFlipRotateClose}
          onApply={handleFlipRotateApply}
          onSave={handleFlipRotateClose}
        />
      </FlowNodeToolbar>
      <div className='relative w-0 min-w-0' style={{ width: outerW, height: outerH }}>
        <input
          ref={fileInputRef}
          type='file'
          accept='.png,.jpg,.jpeg,.webp,.tiff'
          className='hidden'
          aria-hidden
          onChange={handleFileChange}
        />
        <div className='absolute left-0 right-0 top-0 min-w-0 -translate-y-full overflow-hidden text-left text-foreground/60'>
          <LocalNodeHeader nodeId={id} nodeType={String(type)} title={title} />
        </div>
        <div
          className={
            (editingMode === 'expand' ? 'relative overflow-visible ' : 'relative ') +
            'flex min-h-0 flex-col rounded-[8px] bg-background-default-base outline outline-2 pointer-events-auto ' +
            (selected ? 'outline-solid outline-border-utilities-selected' : 'outline-transparent')
          }
          style={{ width: outerW, height: outerH }}
          onMouseEnter={() => setNodeHovered(true)}
          onMouseLeave={() => setNodeHovered(false)}
        >
          <LocalDataNodeHandle
            type='target'
            position={Position.Left}
            handleId={targetHandleId}
            nodeId={id}
            selected={selected}
            nodeHovered={nodeHovered}
            isInsideLockedGroup={false}
          />
          <LocalDataNodeHandle
            type='source'
            position={Position.Right}
            handleId={sourceHandleId}
            nodeId={id}
            selected={selected}
            nodeHovered={nodeHovered}
            isInsideLockedGroup={false}
          />
          <div className={cn('min-h-0 flex-1')}>
            {!url ? (
              <div className='flex h-full w-full min-h-0 items-center justify-center overflow-hidden rounded-[8px]'>
                <div
                  className='flex h-full w-full cursor-pointer flex-col items-center justify-center gap-2'
                  onClick={handlePlaceholderClick}
                  onDoubleClick={handlePlaceholderDoubleClick}
                >
                  <Icon name='project-image-node-placeholder' width={42} height={42} className='text-text-default-tertiary' />
                  <div className='text-center text-[12px] font-normal text-text-default-tertiary'>
                    {t('project.toolbar.imageNodePlaceholder')
                      .split('\n')
                      .map((line, i) => (
                        <div key={i}>{line}</div>
                      ))}
                  </div>
                </div>
              </div>
            ) : !showContent && !isEditing ? (
              <LocalNodeSkeleton />
            ) : showInpaintCanvas ? (
              <ImageInpaintCanvas
                src={url}
                width={width}
                height={height}
                drawBackgroundOnCanvas={editingMode !== 'inpaint'}
                drawLayerOpacity={editingMode === 'inpaint' ? 0.55 : 1}
                onImageReady={editingMode === 'adjust' ? handleAdjustPreviewImageReady : undefined}
                onCanvasReady={setInpaintCanvas}
              />
            ) : (
              <LocalImageNodeContent
                key={url}
                src={url}
                selected={selected}
                isInsideLockedGroup={false}
                imageCursorClassName='cursor-grab'
                onImageLoad={applyContentSizeFromDimensions}
              />
            )}
          </div>
          {editingMode === 'crop' && (
            <CropOverlay containerWidth={width} containerHeight={height} value={cropRect} onChange={setCropRect} />
          )}
          {editingMode === 'expand' && (
            <ExpandOverlay
              containerWidth={width}
              containerHeight={height}
              outerWidth={expandSize.w}
              outerHeight={expandSize.h}
              originX={expandOrigin.x}
              originY={expandOrigin.y}
              onFrameChange={handleExpandFrameChange}
            />
          )}
          {editingMode === 'enhance' && (
            <GridSliceOverlay
              rows={enhanceGridSlice.rows}
              cols={enhanceGridSlice.cols}
              selectedCells={enhanceSelectedCells}
              onToggleCell={handleEnhanceCellToggle}
            />
          )}
          {data.localOutputPending ? (
            <CanvasOutputPendingProgressOverlay
              progressPct={typeof data.localOutputProgressPct === 'number' ? data.localOutputProgressPct : undefined}
            >
              <Icon name='project-image-node-placeholder' width={40} height={40} className='text-text-default-tertiary' />
            </CanvasOutputPendingProgressOverlay>
          ) : null}
        </div>
      </div>
    </>
  );
};

export default memo(ImageNode);
