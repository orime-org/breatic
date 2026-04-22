import React, { useEffect, useState } from 'react';
import { Canvas, Circle, Pattern, Rect, Path } from 'fabric';
import { EraserBrush } from '@erase2d/fabric';
import Slider from '@/components/base/slider';
import Tooltip from '@/components/base/tooltip';
import { Icon } from '@/components/base/icon';
import { Button } from '@/components/base/button';
import Divider from '@/components/base/divider';
import AgentComposerInput from '@/components/base/agent/AgentInput';

export type InpaintTool = 'brush' | 'circle' | 'rectangle' | 'eraser';

type InpaintBottomToolbarProps = {
  canvas: Canvas | null;
  active: boolean;
  baseImageSrc?: string;
  onClose: (nextImageSrc?: string) => void;
  nodeId?: string;
};

const iconBtnClass =
  'nodrag nopan flex h-8 w-8 items-center justify-center rounded-[4px] text-icon-base transition-colors hover:bg-background-default-base-hover';
const iconBtnActiveClass = 'bg-background-default-base-hover';
const iconBtnDisabledClass = 'cursor-not-allowed text-icon-disabled hover:bg-transparent opacity-50';
const getHistoryBtnClass = (enabled: boolean) => `${iconBtnClass} ${enabled ? '' : iconBtnDisabledClass}`;
const inpaintLabelClass = 'nodrag nopan inline-flex h-8 items-center gap-1';
/** Aligned with h-8 tool buttons: range track height is less than thumb, must be vertically centered within .slider-container */
const inpaintSliderWrapClass =
  'nodrag nopan mx-1 flex h-8 w-[88px] shrink-0 [&_.slider-container]:flex [&_.slider-container]:h-full [&_.slider-container]:w-full [&_.slider-container]:items-center';
const disabledLeftSlotClass =
  'inline-flex h-[40px] items-center gap-1.5 rounded-full border border-[#C8C8C8] px-4 text-[12px] font-semibold !text-text-disabled-base cursor-not-allowed bg-[var(--color-background-default-base)]';
const inpaintDisplayOpacity = 0.55;
const mosaicTileSize = 8;

const createMosaicTile = (): HTMLCanvasElement => {
  const tile = document.createElement('canvas');
  tile.width = mosaicTileSize;
  tile.height = mosaicTileSize;
  const ctx = tile.getContext('2d');
  if (ctx) {
    ctx.fillStyle = '#c4cad4';
    ctx.fillRect(0, 0, mosaicTileSize, mosaicTileSize);
    ctx.fillStyle = '#d5dae2';
    ctx.fillRect(0, 0, mosaicTileSize / 2, mosaicTileSize / 2);
    ctx.fillRect(mosaicTileSize / 2, mosaicTileSize / 2, mosaicTileSize / 2, mosaicTileSize / 2);
  }
  return tile;
};

/** Initial size when circle/rectangle is first pressed, independent of brush thickness */
const shapeInitialSize = 2;

const InpaintBottomToolbar: React.FC<InpaintBottomToolbarProps> = ({
  canvas,
  active,
  baseImageSrc,
  onClose,
  nodeId: _nodeId,
}) => {
  const [activeTool, setActiveTool] = useState<InpaintTool>('brush');
  const [brushSize, setBrushSize] = useState(8);
  const [history, setHistory] = useState<{ undo: unknown[]; redo: unknown[] }>({ undo: [], redo: [] });
  const [inputEmpty, setInputEmpty] = useState(true);
  const canUndo = history.undo.length > 0;
  const canRedo = history.redo.length > 0;
  const getMosaicPattern = React.useCallback(() => {
    const tile = createMosaicTile();
    return new Pattern({ source: tile, repeat: 'repeat' });
  }, []);

  const getEraser = React.useCallback(
    (target: Canvas) => {
      const eraser = new EraserBrush(target);
      eraser.width = brushSize;
      return eraser;
    },
    [brushSize],
  );

  const handleToolChange = (tool: InpaintTool) => {
    setActiveTool(tool);
    if (!canvas || !active) return;
    // brush switched to object-layer real-time drawing to achieve the same immediate blending as circle/rectangle
    canvas.isDrawingMode = tool === 'eraser';
    if (tool === 'eraser') canvas.freeDrawingBrush = getEraser(canvas);
  };

  const handleBrushSizeChange = (size: number) => {
    setBrushSize(size);
    if (!canvas || !active) return;
    if (activeTool === 'eraser') canvas.freeDrawingBrush = getEraser(canvas);
  };

  // Exit: quit Inpaint without modifying the current node image or creating a new node.
  const handleExitClick = () => {
    onClose();
  };

  // Send: apply the current paint result and exit; the parent decides to write/add a node based on nextImageSrc.
  const handleSendClick = () => {
    if (!canvas) {
      onClose();
      return;
    }
    canvas.discardActiveObject();
    canvas.requestRenderAll();
    window.requestAnimationFrame(() => {
      try {
        const overlaySrc = canvas.toDataURL({
          format: 'png',
          multiplier: 1,
          enableRetinaScaling: false,
        });
        if (!baseImageSrc) {
          onClose(overlaySrc);
          return;
        }

        const compose = async () => {
          const [baseImg, overlayImg] = await Promise.all([
            new Promise<HTMLImageElement>((resolve, reject) => {
              const img = new window.Image();
              img.crossOrigin = 'anonymous';
              img.onload = () => resolve(img);
              img.onerror = () => reject(new Error('base image load failed'));
              img.src = baseImageSrc;
            }),
            new Promise<HTMLImageElement>((resolve, reject) => {
              const img = new window.Image();
              img.onload = () => resolve(img);
              img.onerror = () => reject(new Error('overlay image load failed'));
              img.src = overlaySrc;
            }),
          ]);

          const w = canvas.getWidth() || 1;
          const h = canvas.getHeight() || 1;
          const mergeCanvas = document.createElement('canvas');
          mergeCanvas.width = w;
          mergeCanvas.height = h;
          const ctx = mergeCanvas.getContext('2d');
          if (!ctx) throw new Error('2d context unavailable');

          const baseScale = Math.max(w / Math.max(1, baseImg.naturalWidth), h / Math.max(1, baseImg.naturalHeight));
          const baseDrawW = Math.max(1, baseImg.naturalWidth) * baseScale;
          const baseDrawH = Math.max(1, baseImg.naturalHeight) * baseScale;
          const baseX = (w - baseDrawW) / 2;
          const baseY = (h - baseDrawH) / 2;
          ctx.drawImage(baseImg, baseX, baseY, baseDrawW, baseDrawH);
          ctx.globalAlpha = inpaintDisplayOpacity;
          ctx.drawImage(overlayImg, 0, 0, w, h);
          ctx.globalAlpha = 1;
          onClose(mergeCanvas.toDataURL('image/png'));
        };

        void compose().catch(() => onClose(overlaySrc));
      } catch {
        onClose();
      }
    });
  };

  const handleUndoClick = () => {
    if (!canvas || !canUndo) return;
    const item = history.undo[history.undo.length - 1];
    if (!item) return;
    canvas.remove(item as never);
    canvas.requestRenderAll();
    setHistory((prev) => ({
      undo: prev.undo.slice(0, -1),
      redo: [...prev.redo, item],
    }));
  };

  const handleRedoClick = () => {
    if (!canvas || !canRedo) return;
    const item = history.redo[history.redo.length - 1];
    if (!item) return;
    canvas.add(item as never);
    canvas.requestRenderAll();
    setHistory((prev) => ({
      undo: [...prev.undo, item],
      redo: prev.redo.slice(0, -1),
    }));
  };

  // Clear history only when entering Inpaint (active/canvas becomes available);
  // brushSize changes etc. should not affect undo/redo of already-drawn content.
  useEffect(() => {
    if (!canvas || !active) return;
    setHistory({ undo: [], redo: [] });
  }, [canvas, active]);

  useEffect(() => {
    if (!canvas || !active) return;
    canvas.isDrawingMode = activeTool === 'eraser';
    if (activeTool === 'eraser') canvas.freeDrawingBrush = getEraser(canvas);

    // drawingboard.js approach: record start point on mouse down, update end point on mouse move and rebuild preview object
    let mouseFrom: { x: number; y: number } | null = null;
    let brushPoints: Array<{ x: number; y: number }> | null = null;
    let previewObject: Rect | Circle | Path | null = null;

    const clampToCanvas = (point: { x: number; y: number }): { x: number; y: number } => {
      const maxX = Math.max(0, canvas.getWidth());
      const maxY = Math.max(0, canvas.getHeight());
      return {
        x: Math.min(maxX, Math.max(0, point.x)),
        y: Math.min(maxY, Math.max(0, point.y)),
      };
    };

    const getPointer = (fabricOptions: unknown): { x: number; y: number } | null => {
      const e = (fabricOptions as { e?: unknown })?.e ?? fabricOptions;

      // Prefer Fabric-computed coordinates to avoid offsetX jitter causing direction reversal at edges/cross-element
      const scenePoint = (fabricOptions as { scenePoint?: { x?: unknown; y?: unknown } })?.scenePoint;
      if (typeof scenePoint?.x === 'number' && typeof scenePoint?.y === 'number') {
        return clampToCanvas({ x: scenePoint.x, y: scenePoint.y });
      }
      const absolutePointer = (fabricOptions as { absolutePointer?: { x?: unknown; y?: unknown } })?.absolutePointer;
      if (typeof absolutePointer?.x === 'number' && typeof absolutePointer?.y === 'number') {
        return clampToCanvas({ x: absolutePointer.x, y: absolutePointer.y });
      }

      // Prefer replicating drawingboard.js: use offsetX/offsetY directly
      const offsetX = (e as { offsetX?: unknown })?.offsetX;
      const offsetY = (e as { offsetY?: unknown })?.offsetY;
      if (typeof offsetX === 'number' && typeof offsetY === 'number') {
        const zoom =
          typeof (canvas as unknown as { getZoom?: () => number }).getZoom === 'function'
            ? (canvas as unknown as { getZoom?: () => number }).getZoom?.()
            : 1;
        const z = typeof zoom === 'number' && zoom > 0 ? zoom : 1;
        return clampToCanvas({ x: offsetX / z, y: offsetY / z });
      }

      // Fallback: use client coordinates + canvas DOM size to convert to fabric coordinates
      const clientX = (e as { clientX?: unknown })?.clientX;
      const clientY = (e as { clientY?: unknown })?.clientY;
      const el =
        (
          canvas as unknown as {
            lowerCanvasEl?: HTMLElement;
            upperCanvasEl?: HTMLElement;
            getElement?: () => HTMLElement;
          }
        ).lowerCanvasEl ??
        (
          canvas as unknown as {
            lowerCanvasEl?: HTMLElement;
            upperCanvasEl?: HTMLElement;
            getElement?: () => HTMLElement;
          }
        ).upperCanvasEl ??
        (canvas as unknown as { getElement?: () => HTMLElement }).getElement?.();

      if (typeof clientX !== 'number' || typeof clientY !== 'number' || !el || !('getBoundingClientRect' in el))
        return null;
      const rect = el.getBoundingClientRect();
      const cw = canvas.getWidth();
      const ch = canvas.getHeight();
      if (rect.width <= 0 || rect.height <= 0) return null;

      const x = ((clientX - rect.left) / rect.width) * cw;
      const y = ((clientY - rect.top) / rect.height) * ch;
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      return clampToCanvas({ x, y });
    };

    const onPathCreated = (e: { path?: unknown }) => {
      if (!e.path) return;
      const nextPath = e.path as { erasable?: boolean; opacity?: number };
      nextPath.erasable = true;
      nextPath.opacity = 1;
      setHistory((prev) => ({ undo: [...prev.undo, e.path as unknown], redo: [] }));
    };

    const buildBrushPreviewObject = (points: Array<{ x: number; y: number }>): Circle | Path => {
      if (points.length <= 1) {
        const p = points[0] ?? { x: 0, y: 0 };
        return new Circle({
          left: p.x,
          top: p.y,
          radius: Math.max(1, brushSize / 2),
          originX: 'center',
          originY: 'center',
          fill: getMosaicPattern(),
          opacity: 1,
          stroke: 'rgba(0, 0, 0, 0)',
          strokeWidth: 0,
          globalCompositeOperation: 'lighten',
          selectable: false,
          evented: false,
          erasable: true,
        });
      }
      const path =
        'M ' +
        points[0]!.x +
        ' ' +
        points[0]!.y +
        points
          .slice(1)
          .map((point) => ` L ${point.x} ${point.y}`)
          .join('');
      return new Path(path, {
        fill: '',
        stroke: getMosaicPattern(),
        strokeWidth: brushSize,
        strokeLineCap: 'round',
        strokeLineJoin: 'round',
        opacity: 1,
        globalCompositeOperation: 'lighten',
        selectable: false,
        evented: false,
        erasable: true,
        objectCaching: false,
      });
    };

    const onMouseDown = (e: unknown) => {
      if (activeTool !== 'brush' && activeTool !== 'circle' && activeTool !== 'rectangle') return;
      const p = getPointer(e);
      if (!p) return;
      mouseFrom = p;

      if (activeTool === 'brush') {
        brushPoints = [p];
        previewObject = buildBrushPreviewObject(brushPoints);
        canvas.discardActiveObject();
        canvas.add(previewObject);
        canvas.requestRenderAll();
        return;
      }

      if (activeTool === 'rectangle') {
        const fromX = p.x;
        const fromY = p.y;
        const toX = p.x + shapeInitialSize;
        const toY = p.y + shapeInitialSize;
        const path =
          'M ' +
          fromX +
          ' ' +
          fromY +
          ' L ' +
          toX +
          ' ' +
          fromY +
          ' L ' +
          toX +
          ' ' +
          toY +
          ' L ' +
          fromX +
          ' ' +
          toY +
          ' z';
        previewObject = new Path(path, {
          fill: getMosaicPattern(),
          opacity: 1,
          stroke: 'rgba(0, 0, 0, 0)',
          strokeWidth: 0,
          globalCompositeOperation: 'lighten',
          selectable: false,
          evented: false,
          erasable: true,
        });
      } else {
        previewObject = new Circle({
          // Make circle follow mouse direction: treat mouseFrom as “a corner of the bounding square”
          // fabric defaults origin=center, so left/top must be the circle center
          left: p.x + shapeInitialSize,
          top: p.y + shapeInitialSize,
          radius: shapeInitialSize,
          fill: getMosaicPattern(),
          opacity: 1,
          stroke: 'rgba(0, 0, 0, 0)',
          strokeWidth: 0,
          globalCompositeOperation: 'lighten',
          selectable: false,
          evented: false,
          erasable: true,
        });
      }

      canvas.discardActiveObject();
      canvas.add(previewObject);
      canvas.requestRenderAll();
    };

    const onMouseMove = (e: unknown) => {
      if (activeTool !== 'brush' && activeTool !== 'circle' && activeTool !== 'rectangle') return;
      if (!mouseFrom) return;
      const p = getPointer(e);
      if (!p) return;
      if (previewObject) canvas.remove(previewObject);

      if (activeTool === 'brush') {
        if (!brushPoints) return;
        brushPoints.push(p);
        previewObject = buildBrushPreviewObject(brushPoints);
        canvas.add(previewObject);
        canvas.requestRenderAll();
        return;
      }

      if (activeTool === 'rectangle') {
        const fromX = mouseFrom.x;
        const fromY = mouseFrom.y;
        const toX = p.x;
        const toY = p.y;
        const path =
          'M ' +
          fromX +
          ' ' +
          fromY +
          ' L ' +
          toX +
          ' ' +
          fromY +
          ' L ' +
          toX +
          ' ' +
          toY +
          ' L ' +
          fromX +
          ' ' +
          toY +
          ' z';
        previewObject = new Path(path, {
          fill: getMosaicPattern(),
          opacity: 1,
          stroke: 'rgba(0, 0, 0, 0)',
          strokeWidth: 0,
          globalCompositeOperation: 'lighten',
          selectable: false,
          evented: false,
          erasable: true,
        });
      } else {
        const dx = p.x - mouseFrom.x;
        const dy = p.y - mouseFrom.y;

        // Use the larger axis to determine radius so the circle always grows toward the mouse
        const radius = Math.max(1, Math.max(Math.abs(dx), Math.abs(dy)) / 2);
        const signX = dx >= 0 ? 1 : -1;
        const signY = dy >= 0 ? 1 : -1;

        // fabric defaults origin=center: left/top is the circle center
        const left = mouseFrom.x + signX * radius;
        const top = mouseFrom.y + signY * radius;
        previewObject = new Circle({
          left,
          top,
          radius,
          fill: getMosaicPattern(),
          opacity: 1,
          stroke: 'rgba(0, 0, 0, 0)',
          strokeWidth: 0,
          globalCompositeOperation: 'lighten',
          selectable: false,
          evented: false,
          erasable: true,
        });
      }

      canvas.add(previewObject);
      canvas.requestRenderAll();
    };

    const onMouseUp = () => {
      if (previewObject) {
        const added = previewObject;
        setHistory((prev) => ({ undo: [...prev.undo, added], redo: [] }));
      }
      mouseFrom = null;
      brushPoints = null;
      previewObject = null;
      canvas.requestRenderAll();
    };

    canvas.on('path:created', onPathCreated);
    canvas.on('mouse:down', onMouseDown);
    canvas.on('mouse:move', onMouseMove);
    canvas.on('mouse:up', onMouseUp);
    return () => {
      canvas.off('path:created', onPathCreated);
      canvas.off('mouse:down', onMouseDown);
      canvas.off('mouse:move', onMouseMove);
      canvas.off('mouse:up', onMouseUp);
      canvas.isDrawingMode = false;
    };
  }, [canvas, active, activeTool, brushSize, getEraser, getMosaicPattern]);

  return (
    <div className='nodrag nopan pointer-events-auto flex flex-col items-center gap-3'>
      <div
        className='nodrag nopan pointer-events-auto flex h-[40px] items-center gap-1 rounded-[8px] border border-[#DBDBDB] bg-background-default-base px-[12px] py-[4px] shadow-[0_1px_3px_rgba(0,0,0,0.08)]'
        onMouseDown={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className={inpaintLabelClass}>
          <Icon name='project-excalidraw-top-inpaint-icon' width={20} height={20} color='var(--bg-icon-base)' />
          <span className='text-sm font-bold text-text-default-base'>Inpaint</span>
        </div>
        <Divider type='vertical' className='mx-2 h-[18px] bg-[#D0D0D0]' />
        <Tooltip title='Brush' placement='top' offset={4}>
          <button
            type='button'
            className={`${iconBtnClass} ${activeTool === 'brush' ? iconBtnActiveClass : ''}`}
            aria-label='Brush inpaint'
            onClick={() => handleToolChange('brush')}
          >
            <Icon name='imageEditor-flow-inpaint-brush-icon' width={20} height={20} />
          </button>
        </Tooltip>
        <div className={inpaintSliderWrapClass} onPointerDown={(e) => e.stopPropagation()}>
          <Slider
            className='nodrag nopan !w-full'
            value={brushSize}
            min={1}
            max={100}
            activeColor='#5A5A5A'
            inactiveColor='#E3E3E3'
            trackHeight={6}
            thumbWidth={20}
            thumbHeight={16}
            thumbColor='#B3B3B3'
            onChange={handleBrushSizeChange}
          />
        </div>
        <Tooltip title='Circle' placement='top' offset={4}>
          <button
            type='button'
            className={`${iconBtnClass} ${activeTool === 'circle' ? iconBtnActiveClass : ''}`}
            aria-label='Circle select'
            onClick={() => handleToolChange('circle')}
          >
            <Icon name='imageEditor-flow-inpaint-circle-icon' width={20} height={20} />
          </button>
        </Tooltip>
        <Tooltip title='Rectangle' placement='top' offset={4}>
          <button
            type='button'
            className={`${iconBtnClass} ${activeTool === 'rectangle' ? iconBtnActiveClass : ''}`}
            aria-label='Rect select'
            onClick={() => handleToolChange('rectangle')}
          >
            <Icon name='imageEditor-flow-inpaint-rectangle-icon' width={20} height={20} />
          </button>
        </Tooltip>
        <Tooltip title='Eraser' placement='top' offset={4}>
          <button
            type='button'
            className={`${iconBtnClass} ${activeTool === 'eraser' ? iconBtnActiveClass : ''}`}
            aria-label='Eraser inpaint'
            onClick={() => handleToolChange('eraser')}
          >
            <Icon name='imageEditor-flow-inpaint-eraser-icon' width={22} height={22} />
          </button>
        </Tooltip>
        <Divider type='vertical' className='mx-2 h-[18px] bg-[#D0D0D0]' />
        <Tooltip title='Undo' placement='top' offset={4}>
          <button
            type='button'
            className={getHistoryBtnClass(canUndo)}
            aria-label='Undo inpaint'
            onClick={handleUndoClick}
            disabled={!canUndo}
          >
            <Icon name='imageEditor-flow-inpaint-undo-icon' width={20} height={20} />
          </button>
        </Tooltip>
        <Tooltip title='Redo' placement='top' offset={4}>
          <button
            type='button'
            className={getHistoryBtnClass(canRedo)}
            aria-label='Redo inpaint'
            onClick={handleRedoClick}
            disabled={!canRedo}
          >
            <Icon name='imageEditor-flow-inpaint-redo-icon' width={20} height={20} />
          </button>
        </Tooltip>
        <Divider type='vertical' className='mx-2 h-[18px] bg-[#D0D0D0]' />
        <Tooltip title='Exit' placement='top' offset={4}>
          <button type='button' className={iconBtnClass} onClick={handleExitClick} aria-label='Close inpaint toolbar'>
            <Icon name='imageEditor-multi-angle-close-icon' width={18} height={18} />
          </button>
        </Tooltip>
      </div>

      <div className='pointer-events-auto w-[470px] h-[150px] rounded-[8px] border border-[#DBDBDB] bg-background-default-base shadow-[0_1px_3px_rgba(0,0,0,0.08)] overflow-hidden'>
        <div className='flex h-full flex-col px-3 py-2'>
          <AgentComposerInput
            className='flex-1 !cursor-text'
            placeholder='Please describe the modifications you want here.'
            disabled={!active}
            onEnterSend={handleSendClick}
            onEmptyChange={setInputEmpty}
            upstreamItems={[]}
            uploadItems={[]}
          />
          <div className='mt-2 flex items-center justify-between gap-2'>
            <Button
              type='default'
              shape='round'
              disabled
              className={disabledLeftSlotClass}
              aria-label='Nano Banana Pro disabled'
            >
              <Icon
                name='imageEditor-nano-banana-pro-icon'
                width={16}
                height={17}
                color='var(--color-bg-icon-tertiary-hover)'
              />
              <span className='text-text-disabled-base'>Nano Banana Pro</span>
            </Button>
            <div className='flex-1' />
            <div className='flex items-center gap-2'>
              <div className='flex h-[28px] items-center gap-1 text-text-disabled-base text-xs font-bold'>
                <Icon name='imageEditor-nano-banana-credit-icon' width={18} height={18} />
                <span>120</span>
              </div>
              <Button
                type='primary'
                size='medium'
                shape='round'
                disabled={!active || !canvas || inputEmpty}
                icon={<Icon name='project-chat-send-icon' width={18} height={16} color='#fff' />}
                onClick={handleSendClick}
                className='!h-[28px] w-[52px] shrink-0 !border-[#35C838] !bg-[#35C838] !py-[2px] !pl-[16px] !pr-[12px] hover:!border-[#35C838] hover:!bg-[#35C838] disabled:!border-[#CDCDCD] disabled:!bg-[#CDCDCD]'
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default InpaintBottomToolbar;
