import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  NodeToolbar as FlowNodeToolbar,
  NodeResizer,
  Position,
  useReactFlow,
  useStore,
  useViewport,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import { nanoid } from 'nanoid';
import NodeSkeleton, { zoomLevelShowContentSelector } from '@/apps/project/components/canvas/common/NodeSkeleton';
import { type CanvasWorkflowNodeData, getProjectCanvasViewportApi } from '@/apps/project/components/canvas/types';
import { useTranslation } from 'react-i18next';
import { useMixedEditorData } from '@/contexts/MixedEditorDataContext';
import { useMixedEditorActions } from '@/hooks/useMixedEditorActions';
import { useMixedEditorUI } from '@/hooks/useMixedEditorUI';
import { useCanvasData } from '@/contexts/CanvasDataContext';
import { useCanvasActions } from '@/hooks/useCanvasActions';
import type { ImageFlowNodeData } from '../../types';
import type { ImageEditorPickResultBox } from '../../types';
import Toolbar from './Toolbar';
import BottomToolbar from './BottomToolbar';
import NodeHeader from '../../common/NodeHeader';
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
import FlipRotateBottomToolbar, {
  bitmapTransformToPngDataUrl,
  swapsNodeDimensions,
  type FlipRotateBitmapOp,
} from './flipRotate/FlipRotateBottomToolbar';
import CropOverlay, { type CropRect } from './crop/CropOverlay';
import GridSliceOverlay from './gridSlice/GridSliceOverlay';
import ImageInpaintCanvas from './inpaint/ImageInpaintCanvas';
import { Image } from '@/components/base/image';
import Loading from '@/components/loading';
import { Canvas, classRegistry, filters, FabricImage } from 'fabric';
import type { T2DPipelineState, TWebGLUniformLocationMap } from 'fabric';
import RecognizedPickDropdown from '@/components/base/agent/RecognizedPickDropdown';

/** Default node width */
const imageFlowDefaultWidth = 260;
/** Default node height */
const imageFlowDefaultHeight = 160;
/** Minimum resizable node width */
const imageFlowMinWidth = 120;
/** Minimum resizable node height */
const imageFlowMinHeight = 80;
const enhanceDefaultGridSlice = { rows: 3, cols: 3 };
const recognizedOverlayPresets = [
  { key: 'mountain', label: '山脉', cxPct: 28, cyPct: 24, wPct: 32, hPct: 26 },
  { key: 'river', label: '河流', cxPct: 56, cyPct: 62, wPct: 38, hPct: 20 },
  { key: 'tree', label: '大树', cxPct: 76, cyPct: 42, wPct: 20, hPct: 34 },
] as const;

/** Main project canvas workflow image node type (see `canvas/index.tsx` nodeTypes). */
const canvasWorkflowImageNodeType = '1002';

const canvasImageNodeFallbackWidth = 300;
const canvasImageNodeFallbackHeight = 250;
const newCanvasImageGap = 40;

/** Must stay in sync with `canvas/dataNode/imageNode/ImageNode.tsx` `defaultNodeWidth` / `defaultNodeHeight`. */
const workflowCanvasImageDefaultWidth = 300;
const workflowCanvasImageDefaultHeight = 250;

/**
 * Display size for a workflow canvas image node from natural pixels (same rules as main canvas `ImageNode` on load).
 *
 * @param naturalWidth - Source width in px
 * @param naturalHeight - Source height in px
 * @returns Width/height for `node.style` so React Flow bounds match rendered DOM
 */
function computeWorkflowCanvasImageDisplaySize(
  naturalWidth: number,
  naturalHeight: number,
): { width: number; height: number } {
  if (naturalWidth <= 0 || naturalHeight <= 0) {
    return { width: workflowCanvasImageDefaultWidth, height: workflowCanvasImageDefaultHeight };
  }
  const isLandscape = naturalWidth >= naturalHeight;
  if (isLandscape) {
    const h = Math.max(
      Math.round(workflowCanvasImageDefaultWidth * (naturalHeight / naturalWidth)),
      workflowCanvasImageDefaultHeight,
    );
    const w = Math.round(h * (naturalWidth / naturalHeight));
    return { width: w, height: h };
  }
  return {
    width: workflowCanvasImageDefaultWidth,
    height: Math.round(workflowCanvasImageDefaultWidth * (naturalHeight / naturalWidth)),
  };
}

/**
 * Reads intrinsic image dimensions from a URL (http(s), data, or blob).
 *
 * @param src - Image URL
 * @throws When the image fails to load or has no dimensions
 */
function loadImageNaturalSize(src: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new window.Image();
    if (src.startsWith('http://') || src.startsWith('https://')) {
      img.crossOrigin = 'anonymous';
    }
    img.onload = () => {
      if (img.naturalWidth <= 0 || img.naturalHeight <= 0) {
        reject(new Error('invalid image dimensions'));
        return;
      }
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
    };
    img.onerror = () => reject(new Error('image load failed'));
    img.src = src;
  });
}

/**
 * Axis-aligned bounds for layout (uses style width/height when present).
 */
function projectCanvasNodeBounds(n: Node): { left: number; top: number; right: number; bottom: number } {
  const st = (n.style ?? {}) as { width?: number; height?: number };
  const w = typeof st.width === 'number' ? st.width : canvasImageNodeFallbackWidth;
  const h = typeof st.height === 'number' ? st.height : canvasImageNodeFallbackHeight;
  return {
    left: n.position.x,
    top: n.position.y,
    right: n.position.x + w,
    bottom: n.position.y + h,
  };
}

/**
 * Fallback position when the main canvas viewport API is unavailable (e.g. canvas panel unmounted).
 */
function suggestNewProjectCanvasImagePosition(canvasNodes: Node[]): { x: number; y: number } {
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
    return { x: maxRight + newCanvasImageGap, y: minTop };
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
  return { x: globalMaxRight + newCanvasImageGap, y: globalY };
}

/**
 * Builds a main-canvas workflow image node pre-filled with editor image URL/size.
 *
 * @param params.naturalSize - When set, the caller should use `updateNodeParams()` after `addNode()` to persist width/height
 */
function createProjectCanvasImageNodeFromEditor(params: {
  content: string;
  name: string;
  position: { x: number; y: number };
  width: number;
  height: number;
  zIndex: number;
  naturalSize?: { width: number; height: number };
}): Node {
  const newId = `${canvasWorkflowImageNodeType}-${Date.now()}-${nanoid(5)}`;
  return {
    id: newId,
    type: canvasWorkflowImageNodeType,
    position: params.position,
    selected: true,
    zIndex: params.zIndex,
    style: { width: params.width, height: params.height },
    data: {
      name: params.name,
      content: params.content,
      state: 'idle',
      handles: {
        target: [{ handleType: 'Image', number: 0 }],
        source: [{ handleType: 'Image', number: 0 }],
      },
    } satisfies CanvasWorkflowNodeData,
  };
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

/**
 * True when this image flow node is the chat record panel canvas-pick source (standard toolbars hide).
 */
function isChatRecordPanelPickSource(pickState: ImageFlowNodeData['pickState'] | undefined): boolean {
  return (
    pickState?.fromCanvas === true &&
    (pickState.consumeFrom === 'chatRecordPanel' || pickState.consumeFrom === 'chatRecordPanelMention')
  );
}

/** Modes that use the fabric inpaint / mark / graffiti / adjust surface. */
function isInpaintCanvasEditingMode(mode: EditingMode): boolean {
  return mode === 'inpaint' || mode === 'mark' || mode === 'graffiti' || mode === 'adjust';
}

function shouldShowImageFlowStandardToolbars(params: {
  selected: boolean;
  selectedImageFlowNodeCount: number;
  dragging: boolean;
  isEditing: boolean;
  hasImageContent: boolean;
  suppressForChatRecordPick: boolean;
}): boolean {
  return (
    params.selected &&
    params.selectedImageFlowNodeCount === 1 &&
    !params.dragging &&
    !params.isEditing &&
    params.hasImageContent &&
    !params.suppressForChatRecordPick
  );
}

function getTrimmedImageFlowNodeName(data: ImageFlowNodeData, fallback = 'image'): string {
  const raw = data.name;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : fallback;
}

interface EnhanceCell {
  row: number;
  col: number;
}

const isNeutralAdjustValue = (value: AdjustValue) => Object.values(value).every((v) => v === 0);

const toUnit = (value: number, divisor = 100) => Math.max(-1, Math.min(1, value / divisor));

type AdjustVignetteProps = { amount: number };

/** Adjust Vignette slider: radial darkening (positive) / slight edge brightening (negative), Canvas2D + WebGL */
class AdjustVignette extends filters.BaseFilter<'AdjustVignette', AdjustVignetteProps> {
  declare amount: AdjustVignetteProps['amount'];
  static type = 'AdjustVignette';
  static defaults: AdjustVignetteProps = { amount: 0 };
  static uniformLocations = ['uAmount'];

  getFragmentSource() {
    return `
      precision highp float;
      uniform sampler2D uTexture;
      uniform float uAmount;
      varying vec2 vTexCoord;
      void main() {
        vec2 uv = vTexCoord - vec2(0.5);
        float d = length(uv) * 1.4142135623730951;
        float dn = smoothstep(0.06, 1.0, d);
        float edge = pow(dn, 1.6);
        vec4 color = texture2D(uTexture, vTexCoord);
        color.rgb *= (1.0 - uAmount * edge);
        color.rgb = clamp(color.rgb, 0.0, 1.0);
        gl_FragColor = color;
      }
    `;
  }

  applyTo2d({ imageData: { data, width, height } }: T2DPipelineState) {
    const amount = this.amount;
    if (amount === 0) return;
    const smoothstep = (edge0: number, edge1: number, x: number) => {
      const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
      return t * t * (3 - 2 * t);
    };
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const nx = (x + 0.5) / width - 0.5;
        const ny = (y + 0.5) / height - 0.5;
        const d = Math.min(1, Math.hypot(nx * 2, ny * 2) / Math.SQRT2);
        const dn = smoothstep(0.06, 1.0, d);
        const edge = dn ** 1.6;
        const mul = 1 - amount * edge;
        const i = (y * width + x) * 4;
        data[i] = Math.max(0, Math.min(255, data[i]! * mul));
        data[i + 1] = Math.max(0, Math.min(255, data[i + 1]! * mul));
        data[i + 2] = Math.max(0, Math.min(255, data[i + 2]! * mul));
      }
    }
  }

  sendUniformData(gl: WebGLRenderingContext, uniformLocations: TWebGLUniformLocationMap) {
    gl.uniform1f(uniformLocations.uAmount, this.amount);
  }

  isNeutralState() {
    return this.amount === 0;
  }
}

classRegistry.setClass(AdjustVignette);

const buildAdjustFabricFilters = (value: AdjustValue): unknown[] => {
  const result: unknown[] = [];
  const brightness = toUnit(value.exposure * 0.9 + value.highlights * 0.25 - value.shadows * 0.2 + value.fade * 0.15);
  const contrast = toUnit(value.contrast * 0.9 + value.clarity * 0.35);
  const saturation = toUnit(value.saturation * 0.85 + value.vibrance * 0.45 - value.fade * 0.15);
  // Align Fabric hue rotation direction with toolbar hue gradient.
  const hueRotation = toUnit(-value.hue, 180);
  const blur = Math.max(0, Math.min(1, value.noiseReduction / 100));
  const noise = Math.max(0, value.grain) * 2.1;
  const tempUnit = toUnit(value.temperature);
  const tintUnit = toUnit(value.tint);
  const fadeAlpha = (Math.max(0, value.fade) / 100) * 0.35;

  if (brightness !== 0) result.push(new filters.Brightness({ brightness }));
  if (contrast !== 0) result.push(new filters.Contrast({ contrast }));
  if (saturation !== 0) result.push(new filters.Saturation({ saturation }));
  if (hueRotation !== 0) result.push(new filters.HueRotation({ rotation: hueRotation }));
  if (blur > 0) result.push(new filters.Blur({ blur }));
  if (noise > 0) result.push(new filters.Noise({ noise }));

  if (value.sharpness > 0) {
    const amount = Math.max(0, value.sharpness) / 100;
    result.push(new filters.Convolute({ matrix: [0, -amount, 0, -amount, 1 + amount * 4, -amount, 0, -amount, 0] }));
  }
  if (value.clarity > 0) {
    const amount = (Math.max(0, value.clarity) / 100) * 0.6;
    result.push(
      new filters.Convolute({
        matrix: [-amount, -amount, -amount, -amount, 1 + amount * 8, -amount, -amount, -amount, -amount],
      }),
    );
  }
  if (tempUnit !== 0 || tintUnit !== 0) {
    // Temperature: negative -> cool(blue), positive -> warm(yellow).
    // Tint: negative -> magenta, positive -> green.
    const rGain = 1 + tempUnit * 0.22 - tintUnit * 0.08;
    const gGain = 1 + tempUnit * 0.06 + tintUnit * 0.2;
    const bGain = 1 - tempUnit * 0.28 - tintUnit * 0.1;
    result.push(
      new filters.ColorMatrix({
        matrix: [rGain, 0, 0, 0, 0, 0, gGain, 0, 0, 0, 0, 0, bGain, 0, 0, 0, 0, 0, 1, 0],
      }),
    );
  }
  if (fadeAlpha > 0) {
    result.push(new filters.BlendColor({ color: '#ffffff', mode: 'screen', alpha: fadeAlpha }));
  }

  // Vignette: positive darkens corners, negative slightly brightens edges (radial, applied last)
  const vignetteAmount = toUnit(value.vignette);
  if (vignetteAmount !== 0) {
    result.push(new AdjustVignette({ amount: vignetteAmount }));
  }

  return result;
};

/** Image flow node: top toolbar + bottom toolbar + resizable image card */
const ImageNode: React.FC<NodeProps> = ({ id, selected, dragging, data }) => {
  const { setCenter } = useReactFlow();
  const { zoom } = useViewport();
  const showContent = useStore(zoomLevelShowContentSelector);
  const nodeData = data as ImageFlowNodeData;
  const pickResultBoxes = (nodeData.pickState?.resultBoxes ?? []) as ImageEditorPickResultBox[];
  const legacySrc = (data as unknown as { src?: string }).src;
  const imageContent = nodeData.content ?? legacySrc ?? '';
  /** Pixel tools (inpaint, crop, …) only apply when the tile has image content. */
  const canUseRasterToolbars = Boolean(imageContent);
  const { nodes, hostNodeId, setNodeDraggable } = useMixedEditorData();
  const {
    updateNodeData,
    updateNode,
    replaceNodeWithFile,
    createInpaintResultNodeRight,
    createInpaintResultNodesRight,
    createEnhanceResultNodesRight,
  } = useMixedEditorActions();
  const { setExpandViewportLock } = useMixedEditorUI();
  const {
    nodes: projectCanvasNodes,
  } = useCanvasData();
  const {
    updateNode: updateProjectCanvasNode,
    addNode: addProjectCanvasNode,
  } = useCanvasActions();
  const quickEditPickPendingListForThis = nodes.reduce<
    NonNullable<NonNullable<ImageFlowNodeData['pickState']>['pending']>[]
  >((acc, n) => {
    const ps = (n.data as Partial<ImageFlowNodeData> | undefined)?.pickState;
    const fromList = (ps?.pendingList ?? []).filter((item) => item.targetNodeId === id);
    if (fromList.length > 0) {
      acc.push(...fromList);
      return acc;
    }
    const legacy = ps?.pending ?? null;
    if (legacy?.targetNodeId === id) acc.push(legacy);
    return acc;
  }, []);
  const { t } = useTranslation();
  const [editingMode, setEditingMode] = useState<EditingMode>(null);
  const [cropRect, setCropRect] = useState<CropRect>({
    x: 0,
    y: 0,
    w: imageFlowDefaultWidth,
    h: imageFlowDefaultHeight,
  });
  const [expandSize, setExpandSize] = useState<{ w: number; h: number }>({
    w: imageFlowDefaultWidth,
    h: imageFlowDefaultHeight,
  });
  const [expandOrigin, setExpandOrigin] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [inpaintCanvas, setInpaintCanvas] = useState<Canvas | null>(null);
  const [adjustValue, setAdjustValue] = useState<AdjustValue>(defaultAdjustValue);
  const [enhanceGridSlice, setEnhanceGridSlice] = useState<{ rows: number; cols: number }>(enhanceDefaultGridSlice);
  const [enhanceSelectedCells, setEnhanceSelectedCells] = useState<string[]>([]);
  /** Get the latest node state including ReactFlow runtime width/height */
  const nodeFromStore = useStore(useCallback((state) => state.nodes.find((n) => n.id === id), [id]));
  const st = (nodeFromStore?.style ?? {}) as { width?: number; height?: number };
  /** Prefer runtime dimensions, fall back to style values, then defaults */
  const storeWidth = typeof nodeFromStore?.width === 'number' ? nodeFromStore.width : undefined;
  const storeHeight = typeof nodeFromStore?.height === 'number' ? nodeFromStore.height : undefined;
  const styleWidth = typeof st.width === 'number' ? st.width : undefined;
  const styleHeight = typeof st.height === 'number' ? st.height : undefined;
  const width = storeWidth ?? styleWidth ?? imageFlowDefaultWidth;
  const height = storeHeight ?? styleHeight ?? imageFlowDefaultHeight;
  const resolutionText = `${Math.max(1, Math.round(width))}x${Math.max(1, Math.round(height))}`;

  /** Write the updated title back to node data.name after inline editing */
  const handleTitleChange = (value: string) => {
    updateNodeData(id, { name: value });
  };

  /** Center the viewport on this node; Expand mode uses a lower zoom to leave room for the expand frame */
  const focusCurrentNode = (zoom = 1.2) => {
    if (!nodeFromStore?.position) return;
    const centerX = nodeFromStore.position.x + width / 2;
    const centerY = nodeFromStore.position.y + height / 2;
    setCenter(centerX, centerY, { zoom, duration: 220 });
  };

  const handleInpaintFocus = () => {
    focusCurrentNode();
    setEditingMode('inpaint');
  };

  const handleQuickEditOpen = () => {
    setEditingMode('quickEdit');
  };

  const handleMarkFocus = () => {
    focusCurrentNode();
    setEditingMode('mark');
  };

  const handleGraffitiFocus = () => {
    focusCurrentNode();
    setEditingMode('graffiti');
  };

  const handleEnhanceOpen = () => {
    setEditingMode('upscale');
  };

  const handleGridSliceOpen = () => {
    focusCurrentNode();
    setEnhanceGridSlice(enhanceDefaultGridSlice);
    setEnhanceSelectedCells([]);
    setEditingMode('enhance');
  };

  const handleEnhanceGridSliceChange = (next: { rows: number; cols: number }) => {
    setEnhanceGridSlice(next);
    setEnhanceSelectedCells((prev) => {
      return prev.filter((key) => {
        const [row, col] = key.split('-').map(Number);
        if (!Number.isFinite(row) || !Number.isFinite(col)) return false;
        return row >= 1 && row <= next.rows && col >= 1 && col <= next.cols;
      });
    });
  };

  const handleEnhanceCellToggle = (row: number, col: number) => {
    const key = `${row}-${col}`;
    setEnhanceSelectedCells((prev) => (prev.includes(key) ? prev.filter((item) => item !== key) : [...prev, key]));
  };

  const handleCropOpen = () => {
    focusCurrentNode();
    setCropRect({ x: 0, y: 0, w: width, h: height });
    setEditingMode('crop');
  };

  const handleExpandOpen = () => {
    const cw = Math.max(1, Math.round(width));
    const ch = Math.max(1, Math.round(height));
    const pad = 40;
    setExpandSize({ w: cw + pad * 2, h: ch + pad * 2 });
    setExpandOrigin({ x: -pad, y: -pad });
    setEditingMode('expand');
    focusCurrentNode(0.6);
  };

  const handleExpandDimensionChange = (w: number, h: number, keepCentered = false) => {
    const cw = Math.max(1, Math.round(width));
    const ch = Math.max(1, Math.round(height));
    const ow = Math.max(cw, Math.round(w));
    const oh = Math.max(ch, Math.round(h));
    if (keepCentered) {
      setExpandOrigin({ x: (cw - ow) / 2, y: (ch - oh) / 2 });
    }
    setExpandSize({ w: ow, h: oh });
  };

  const handleExpandFrameChange = useCallback(
    (next: ExpandFrame) => {
      const cw = Math.max(1, Math.round(width));
      const ch = Math.max(1, Math.round(height));
      setExpandSize({ w: Math.max(cw, next.w), h: Math.max(ch, next.h) });
      setExpandOrigin({ x: next.ox, y: next.oy });
    },
    [width, height],
  );

  const handleAdjustOpen = () => {
    setAdjustValue(defaultAdjustValue);
    setEditingMode('adjust');
  };

  const handleRelightOpen = () => {
    setEditingMode('relight');
  };

  const handleFlipRotateOpen = () => {
    setEditingMode('flipRotate');
  };

  const handleFlipRotateApply = useCallback(
    async (op: FlipRotateBitmapOp) => {
      const src = imageContent;
      if (!src) return;
      const { dataUrl } = await bitmapTransformToPngDataUrl(src, op);
      if (swapsNodeDimensions(op)) {
        updateNode(id, {
          data: { content: dataUrl },
          style: { width: height, height: width },
        });
      } else {
        updateNodeData(id, { content: dataUrl });
      }
    },
    [height, id, imageContent, updateNode, updateNodeData, width],
  );

  /** Center when the aspect ratio changes; when resizing via input, keep current position and only clamp if out of bounds */
  const handleCropDimensionChange = (w: number, h: number, keepCentered = false) => {
    setCropRect((prev) => {
      if (keepCentered) {
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
  };

  const handleMultiAngleOpen = () => {
    setEditingMode('multiAngle');
  };

  // Editing modes (crop / inpaint / enhance etc.) must be exited via
  // their own exit button; clicking empty space to deselect does not
  // close them. While in an editing mode we lock this user's drag on
  // this tile (so pointer gestures route to the mode's overlay, not to
  // moving the tile). The lock is LOCAL (overlay-only) — collaborators
  // keep their default drag behavior. Exiting clears the overlay entry
  // (= ReactFlow default: draggable), so there's no "saved draggable
  // value" to strand if something goes wrong mid-flight.
  useEffect(() => {
    if (editingMode !== null) {
      setNodeDraggable(id, false);
      return () => setNodeDraggable(id, null);
    }
    return undefined;
  }, [id, setNodeDraggable, editingMode]);

  const exitEditing = () => {
    setEditingMode(null);
  };

  const handleInpaintClose = (nextImageSrc?: string) => {
    exitEditing();
    if (nextImageSrc) {
      createInpaintResultNodeRight(id, nextImageSrc, 3000);
    }
  };

  const handleEnhanceClose = () => exitEditing();
  const handleUpscaleClose = () => exitEditing();

  const handleCropClose = () => exitEditing();

  const handleExpandClose = () => exitEditing();

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

      // Keep consistent with node preview: base image is rendered with object-cover in current node box.
      const scale = Math.max(width / naturalW, height / naturalH);
      const drawnW = naturalW * scale;
      const drawnH = naturalH * scale;
      const offsetXInNode = (width - drawnW) / 2;
      const offsetYInNode = (height - drawnH) / 2;

      // Node image area sits inside expand frame at (-ox, -oy); outside remains transparent.
      const nodeLeftInFrame = -frame.ox;
      const nodeTopInFrame = -frame.oy;
      ctx.drawImage(image, nodeLeftInFrame + offsetXInNode, nodeTopInFrame + offsetYInNode, drawnW, drawnH);

      return {
        src: outputCanvas.toDataURL('image/png'),
        width: outW,
        height: outH,
      };
    },
    [height, width],
  );

  const handleExpandSend = async (payload: {
    width: number;
    height: number;
    resolution: ExpandResolution;
    ratio: string;
  }) => {
    const currentSrc = imageContent;
    const frame = {
      w: Math.max(1, Math.round(payload.width)),
      h: Math.max(1, Math.round(payload.height)),
      ox: expandOrigin.x,
      oy: expandOrigin.y,
    };
    handleExpandClose();
    if (!currentSrc) return;
    try {
      const expanded = await generateExpandedImage(currentSrc, frame);
      if (expanded) {
        createInpaintResultNodeRight(id, expanded.src, 3000, { width: expanded.width, height: expanded.height });
        return;
      }
      createInpaintResultNodeRight(id, currentSrc, 3000, { width: frame.w, height: frame.h });
    } catch {
      createInpaintResultNodeRight(id, currentSrc, 3000, { width: frame.w, height: frame.h });
    }
  };

  const generateCroppedImage = useCallback(
    async (src: string, rect: CropRect): Promise<{ src: string; width: number; height: number } | null> => {
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

      // Match the node display: Image uses object-cover
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

      const outputCanvas = document.createElement('canvas');
      outputCanvas.width = Math.max(1, Math.round(sw));
      outputCanvas.height = Math.max(1, Math.round(sh));
      const ctx = outputCanvas.getContext('2d');
      if (!ctx) return null;

      ctx.drawImage(image, sx, sy, sw, sh, 0, 0, outputCanvas.width, outputCanvas.height);
      const outW = outputCanvas.width;
      const outH = outputCanvas.height;
      return {
        src: outputCanvas.toDataURL('image/png'),
        width: outW,
        height: outH,
      };
    },
    [height, width],
  );

  const handleCropSave = async () => {
    const currentRect = cropRect;
    const currentSrc = imageContent;
    exitEditing();
    if (!currentSrc) return;

    try {
      const cropped = await generateCroppedImage(currentSrc, currentRect);
      if (cropped) {
        createInpaintResultNodeRight(id, cropped.src, 3000, { width: cropped.width, height: cropped.height });
      }
    } catch {
      // ignore crop failure; keep current behavior without breaking edit flow
    }
  };

  const handleMultiAngleClose = () => exitEditing();

  const handleAdjustClose = () => exitEditing();

  const handleRelightClose = () => exitEditing();

  const handleFlipRotateClose = () => exitEditing();

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

  const handleAdjustSave = async (value: AdjustValue) => {
    setAdjustValue(value);
    handleAdjustClose();
    if (!imageContent) return;
    if (isNeutralAdjustValue(value)) {
      createInpaintResultNodeRight(id, imageContent, 3000);
      return;
    }

    try {
      const nextImageSrc = await generateAdjustedImage(imageContent, value);
      createInpaintResultNodeRight(id, nextImageSrc ?? imageContent, 3000);
    } catch {
      createInpaintResultNodeRight(id, imageContent, 3000);
    }
  };

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

      // Match display: map the visible area to the source image using object-cover, then slice by grid
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
          return {
            row: cell.row,
            col: cell.col,
            src,
            width: Math.max(1, Math.round(sw)),
            height: Math.max(1, Math.round(sh)),
          };
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

  const handleEnhanceSend = async (payload: {
    resolution: 'none' | '2k' | '4k' | '8k';
    gridSlice: { rows: number; cols: number };
    selectedCells: string[];
    promptEnabled: boolean;
    prompt: string;
  }) => {
    // Exit edit mode and restore viewport after sending
    handleEnhanceClose();

    if (!imageContent) return;

    const rows = Math.max(1, payload.gridSlice.rows);
    const cols = Math.max(1, payload.gridSlice.cols);
    const targetCells = buildEnhanceCells(rows, cols, payload.selectedCells);

    try {
      const results = await generateEnhanceGridSlices(imageContent, rows, cols, targetCells);
      if (results.length > 0) {
        createEnhanceResultNodesRight(id, results, 3000);
        return;
      }
      createInpaintResultNodesRight(id, imageContent, Math.max(1, targetCells.length), 3000);
    } catch {
      createInpaintResultNodesRight(id, imageContent, Math.max(1, targetCells.length), 3000);
    }
  };

  const handleUpscaleSend = async (_payload: {
    resolution: '2k' | '4k' | '8k';
    promptEnabled: boolean;
    prompt: string;
  }) => {
    handleUpscaleClose();
    if (!imageContent) return;
    createInpaintResultNodeRight(id, imageContent, 3000);
  };

  const handleQuickEditClose = () => exitEditing();

  const handleQuickEditSend = (_content: string) => {
    handleQuickEditClose();
    if (!imageContent) return;
    createInpaintResultNodeRight(id, imageContent, 3000);
  };

  const isEditing = editingMode !== null;
  const isChatRecordPickSource = isChatRecordPanelPickSource(nodeData.pickState);
  const selectedCount = nodes.filter((n) => n.selected).length;
  const showStandardToolbars = shouldShowImageFlowStandardToolbars({
    selected,
    selectedImageFlowNodeCount: selectedCount,
    dragging,
    isEditing,
    hasImageContent: canUseRasterToolbars,
    suppressForChatRecordPick: isChatRecordPickSource,
  });
  const showInpaintCanvas = isInpaintCanvasEditingMode(editingMode);
  const handleCreateNewCanvasImageNode = useCallback(() => {
    if (!imageContent) return;
    void (async () => {
      let displayW = Math.max(1, Math.round(width));
      let displayH = Math.max(1, Math.round(height));
      let naturalSize: { width: number; height: number } | undefined;
      try {
        const nat = await loadImageNaturalSize(imageContent);
        const d = computeWorkflowCanvasImageDisplaySize(nat.width, nat.height);
        displayW = d.width;
        displayH = d.height;
        naturalSize = { width: nat.width, height: nat.height };
      } catch {
        // CORS or decode failure: keep editor tile dimensions so the node still appears
      }
      const viewportApi = getProjectCanvasViewportApi();
      const center = viewportApi?.getViewportCenterFlow();
      const position =
        center != null
          ? { x: center.x - displayW / 2, y: center.y - displayH / 2 }
          : suggestNewProjectCanvasImagePosition(projectCanvasNodes);
      const maxZ = projectCanvasNodes.reduce(
        (m, n) => Math.max(m, (n as Node & { zIndex?: number }).zIndex ?? 0),
        0,
      );
      const newNode = createProjectCanvasImageNodeFromEditor({
        content: imageContent,
        name: getTrimmedImageFlowNodeName(nodeData),
        position,
        width: displayW,
        height: displayH,
        zIndex: maxZ + 1,
        naturalSize,
      });
      addProjectCanvasNode(newNode, { select: true });
    })();
  }, [addProjectCanvasNode, height, imageContent, nodeData, projectCanvasNodes, width]);

  /**
   * NodeResizer drag handler — persist new size to the Yjs `style.{width,height}`.
   *
   * Fired on every resize frame AND on release (matches canvas TextNode).
   * Each frame of a single drag merges into one undo entry via the
   * UndoManager's 500ms captureTimeout. Without this callback the resize
   * visual updates the DOM but never lands in Yjs, so the node snaps
   * back on the next render.
   */
  const handleResize = useCallback(
    (_: unknown, params: { width: number; height: number }) => {
      updateNode(id, { style: { width: params.width, height: params.height } });
    },
    [id, updateNode],
  );

  /**
   * Apply the tile's content back to the main-canvas host node that
   * opened this editor (never to a sibling host). Target is fixed
   * from `hostNodeId` on the Data Context — it was set at mount and
   * cannot be hijacked by whatever the user happened to select on
   * the main canvas after the editor opened.
   *
   * Repeated clicks are allowed (overwrite-latest semantics); each
   * click creates one undo entry on the main canvas stack.
   */
  const handleAddToNodeClick = () => {
    if (!imageContent || !hostNodeId) return;
    const sourceName = getTrimmedImageFlowNodeName(nodeData);
    updateProjectCanvasNode(hostNodeId, {
      data: {
        content: imageContent,
        name: sourceName,
        state: 'idle',
        nodeSelectedResultData: null,
        pickState: null,
      } as Partial<CanvasWorkflowNodeData>,
    });
  };

  /** Expand frame may exceed the measured node height; NodeToolbar offset is in screen pixels so canvas zoom must be factored in */
  const expandToolbarBottomOffset = useMemo(
    () => 12 + Math.max(0, expandOrigin.y + expandSize.h - height) * zoom,
    [expandOrigin.y, expandSize.h, height, zoom],
  );
  /** Horizontal offset of the expand frame center relative to the node center (node coords → screen pixels) */
  const expandToolbarTranslateX = useMemo(
    () => (expandOrigin.x + expandSize.w / 2 - width / 2) * zoom,
    [expandOrigin.x, expandSize.w, width, zoom],
  );

  useEffect(() => {
    if (editingMode !== 'expand') return undefined;
    setExpandViewportLock(id, true);
    return () => setExpandViewportLock(id, false);
  }, [id, editingMode, setExpandViewportLock]);

  return (
    <>
      <FlowNodeToolbar isVisible={showStandardToolbars} position={Position.Top} offset={50} align='center'>
        <Toolbar
          nodeId={id}
          onReplace={replaceNodeWithFile}
          onCrop={(_nid) => handleCropOpen()}
          onExpand={(_nid) => handleExpandOpen()}
          onAdjust={(_nid) => handleAdjustOpen()}
          onInpaint={(_nid) => handleInpaintFocus()}
          onQuickEdit={(_nid) => handleQuickEditOpen()}
          onMark={(_nid) => handleMarkFocus()}
          onEnhance={(_nid) => handleEnhanceOpen()}
          onMultiAngle={(_nid) => handleMultiAngleOpen()}
          onRelight={(_nid) => handleRelightOpen()}
          onGridSlice={(_nid) => handleGridSliceOpen()}
          onFlipRotate={(_nid) => handleFlipRotateOpen()}
          onGraffiti={(_nid) => handleGraffitiFocus()}
        />
      </FlowNodeToolbar>
      <FlowNodeToolbar isVisible={showStandardToolbars} position={Position.Bottom} offset={12} align='center'>
        <BottomToolbar
          onAddToNodeClick={handleAddToNodeClick}
          onCreateNewNodeClick={handleCreateNewCanvasImageNode}
          imageSrc={imageContent}
          disableAddToNode={!imageContent || !hostNodeId}
          disableCreateNewNode={!imageContent}
          disableDownload={!imageContent}
        />
      </FlowNodeToolbar>
      <FlowNodeToolbar isVisible={editingMode === 'upscale'} position={Position.Bottom} offset={12} align='center'>
        <UpscaleBottomToolbar
          active={editingMode === 'upscale'}
          onClose={handleUpscaleClose}
          onSend={handleUpscaleSend}
        />
      </FlowNodeToolbar>
      <FlowNodeToolbar isVisible={editingMode === 'quickEdit'} position={Position.Bottom} offset={12} align='center'>
        <QuickEditBottomToolbar
          nodeId={id}
          active={editingMode === 'quickEdit'}
          onClose={handleQuickEditClose}
          onSend={handleQuickEditSend}
        />
      </FlowNodeToolbar>
      <FlowNodeToolbar
        isVisible={editingMode === 'inpaint' || editingMode === 'mark' || editingMode === 'graffiti'}
        position={Position.Bottom}
        offset={12}
        align='center'
      >
        {editingMode === 'inpaint' ? (
          <InpaintBottomToolbar
            nodeId={id}
            canvas={inpaintCanvas}
            active={showInpaintCanvas}
            baseImageSrc={imageContent}
            onClose={handleInpaintClose}
          />
        ) : editingMode === 'mark' ? (
          <MarkBottomToolbar
            nodeId={id}
            canvas={inpaintCanvas}
            active={showInpaintCanvas}
            onClose={handleInpaintClose}
          />
        ) : (
          <GraffitiBottomToolbar
            nodeId={id}
            canvas={inpaintCanvas}
            active={showInpaintCanvas}
            onClose={handleInpaintClose}
          />
        )}
      </FlowNodeToolbar>
      <FlowNodeToolbar isVisible={editingMode === 'enhance'} position={Position.Bottom} offset={12} align='center'>
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
      <FlowNodeToolbar isVisible={editingMode === 'crop'} position={Position.Bottom} offset={12} align='center'>
        <CropBottomToolbar
          active={editingMode === 'crop'}
          width={cropRect.w}
          height={cropRect.h}
          containerWidth={width}
          containerHeight={height}
          onDimensionChange={handleCropDimensionChange}
          onClose={handleCropClose}
          onSave={handleCropSave}
        />
      </FlowNodeToolbar>
      <FlowNodeToolbar
        isVisible={editingMode === 'expand'}
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
      <FlowNodeToolbar isVisible={editingMode === 'multiAngle'} position={Position.Bottom} offset={12} align='center'>
        <MultiAngleBottomToolbar
          active={editingMode === 'multiAngle'}
          onClose={handleMultiAngleClose}
          imageSrc={imageContent}
        />
      </FlowNodeToolbar>
      <FlowNodeToolbar isVisible={editingMode === 'adjust'} position={Position.Bottom} offset={12} align='center'>
        <AdjustBottomToolbar
          active={editingMode === 'adjust'}
          onClose={handleAdjustClose}
          onChange={setAdjustValue}
          onSave={handleAdjustSave}
        />
      </FlowNodeToolbar>
      <FlowNodeToolbar isVisible={editingMode === 'relight'} position={Position.Bottom} offset={12} align='center'>
        <RelightBottomToolbar active={editingMode === 'relight'} onClose={handleRelightClose} imageSrc={imageContent} />
      </FlowNodeToolbar>
      <FlowNodeToolbar isVisible={editingMode === 'flipRotate'} position={Position.Bottom} offset={12} align='center'>
        <FlipRotateBottomToolbar
          active={editingMode === 'flipRotate'}
          imageSrc={imageContent}
          onClose={handleFlipRotateClose}
          onApply={handleFlipRotateApply}
        />
      </FlowNodeToolbar>
      <div
        className={editingMode === 'expand' ? 'relative overflow-visible' : 'relative'}
        style={{ width, height, minWidth: imageFlowMinWidth, minHeight: imageFlowMinHeight }}
      >
        <div className='absolute -translate-y-full left-0 right-0 -top-0 overflow-hidden'>
          <NodeHeader
            title={nodeData.name || t('project.toolbar.imageNode')}
            resolutionText={resolutionText}
            editable
            onTitleChange={handleTitleChange}
          />
        </div>
        <NodeResizer
          isVisible={selected && !isEditing}
          keepAspectRatio
          minWidth={imageFlowMinWidth}
          minHeight={imageFlowMinHeight}
          onResize={handleResize}
          onResizeEnd={handleResize}
        />
        <div className='relative h-full w-full overflow-hidden bg-white shadow-sm' data-agent-image-viewport={id}>
          {!showContent && !isEditing ? (
            <NodeSkeleton />
          ) : showInpaintCanvas ? (
            <ImageInpaintCanvas
              src={imageContent}
              width={width}
              height={height}
              drawBackgroundOnCanvas={editingMode !== 'inpaint'}
              drawLayerOpacity={editingMode === 'inpaint' ? 0.55 : 1}
              onImageReady={editingMode === 'adjust' ? handleAdjustPreviewImageReady : undefined}
              onCanvasReady={setInpaintCanvas}
            />
          ) : imageContent ? (
            <Image
              src={imageContent}
              alt={nodeData.name}
              preview={false}
              lazy={false}
              className='h-full w-full'
              imgClassName='block h-full w-full object-cover'
            />
          ) : (
            <Loading inline backgroundColor='#ffffff' width='100%' height='100%' />
          )}
          {quickEditPickPendingListForThis.map((pending) => (
            <div
              key={pending.placeholderId}
              className='pointer-events-none absolute z-[7] inline-flex max-w-[126px] min-w-0 items-center gap-1 whitespace-nowrap rounded-full border border-[var(--color-border-default-base)] bg-[var(--color-background-default-secondary)] px-2 py-0.5 text-xs font-medium text-[var(--color-text-default-base)] shadow-sm -translate-x-1/2 -translate-y-1/2'
              style={{
                left: pending.overlayAnchor ? `${pending.overlayAnchor.xPct}%` : '50%',
                top: pending.overlayAnchor ? `${pending.overlayAnchor.yPct}%` : '50%',
              }}
            >
              <span className='mr-1'>⏳</span>识别中...
            </div>
          ))}
          {pickResultBoxes.map((box, boxIdx) => (
            <div
              key={box.placeholderId ?? `${box.cxPct}-${box.cyPct}-${boxIdx}`}
              className='absolute z-[5] rounded-md border-2 border-[rgb(99,102,241)] bg-[rgb(99,102,241)]/15 shadow-[0_0_0_1px_rgba(255,255,255,0.25)_inset] box-border'
              style={{
                left: `${box.cxPct}%`,
                top: `${box.cyPct}%`,
                width: `${box.wPct}%`,
                height: `${box.hPct}%`,
                transform: 'translate(-50%, -50%)',
              }}
            >
              <div className='absolute -left-1 -top-8 z-[8] pointer-events-auto'>
                <RecognizedPickDropdown
                  currentLabel={box.name}
                  options={recognizedOverlayPresets.map((item) => ({ key: item.key, label: item.label }))}
                  onSelect={(presetKey) => {
                    const preset = recognizedOverlayPresets.find((item) => item.key === presetKey);
                    if (!preset || !box.placeholderId) return;
                    const nextBoxes = pickResultBoxes.map((item) =>
                      item.placeholderId === box.placeholderId
                        ? {
                          ...item,
                          name: preset.label,
                          cxPct: preset.cxPct,
                          cyPct: preset.cyPct,
                          wPct: preset.wPct,
                          hPct: preset.hPct,
                        }
                        : item,
                    );
                    updateNode(id, { data: { pickState: { resultBoxes: nextBoxes.length ? nextBoxes : null } } }, { history: 'skip' });
                    if (!box.sourceNodeId || !box.content) return;
                    updateNode(
                      box.sourceNodeId,
                      {
                        data: {
                          pickState: {
                            selection: {
                              targetNodeId: id,
                              placeholderId: box.placeholderId,
                              content: box.content,
                              name: preset.label,
                            },
                          },
                        },
                      },
                      { history: 'skip' },
                    );
                  }}
                />
              </div>
            </div>
          ))}
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
      </div>
    </>
  );
};

export default memo(ImageNode);
