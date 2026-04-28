import React, { useEffect, useState } from 'react';
import { Canvas, Circle, PencilBrush, Path, IText, controlsUtils, Group, FabricImage, type FabricObject } from 'fabric';
import Slider from '@/components/base/slider';
import Tooltip from '@/components/base/tooltip';
import { Icon } from '@/components/base/icon';
import { Button } from '@/components/base/button';
import Dropdown from '@/components/base/dropdown';
import Divider from '@/components/base/divider';

type MarkTool = 'brush' | 'circle' | 'rectangle' | 'arrow' | 'text';

type MarkBottomToolbarProps = {
  canvas: Canvas | null;
  active: boolean;
  onCanvasCommit?: () => void;
  onClose: (nextImageSrc?: string) => void;
  nodeId?: string;
};

const iconBtnClass =
  'nodrag nopan flex h-8 w-8 items-center justify-center rounded-[4px] text-icon-base transition-colors hover:bg-background-default-base-hover';
const iconBtnActiveClass = 'bg-background-default-base-hover';
const shapeInitialSize = 2;
const minShapeDragPx = 8;
const markLabelClass = 'nodrag nopan inline-flex h-8 items-center gap-1';
const markSliderWrapClass =
  'nodrag nopan mx-1 flex h-8 w-[96px] shrink-0 [&_.slider-container]:flex [&_.slider-container]:h-full [&_.slider-container]:w-full [&_.slider-container]:items-center';
const colorOptions = ['#9CA3AF', '#0C0C0D', '#FFD600', '#FF9230', '#FF375F', '#DB34F2', '#6D7CFF', '#00DAC3', '#30D158'];

const markControlVisual = {
  padding: 0,
  cornerStyle: 'circle' as const,
  cornerSize: 6,
  touchCornerSize: 12,
  transparentCorners: false,
  cornerColor: '#ffffff',
  cornerStrokeColor: '#A5A6F6',
  borderColor: '#A5A6F6',
  borderDashArray: [4, 4] as [number, number],
  borderScaleFactor: 1,
};

const hideMarkRotationControl = (o: FabricObject) => {
  if (o.controls?.mtr) o.controls.mtr.visible = false;
};

const applyMarkControlVisual = (canvas: Canvas) => {
  canvas.getObjects().forEach((item) => {
    if (item instanceof FabricImage) return;
    const obj = item as FabricObject;
    obj.set({ ...markControlVisual, hoverCursor: 'move', moveCursor: 'move' });
    hideMarkRotationControl(obj);
    item.setCoords();
  });
};

const finalizeMarkObject = (obj: unknown, options?: { perPixelTargetFind?: boolean }) => {
  if (!obj || typeof obj !== 'object' || !('set' in obj) || typeof (obj as FabricObject).set !== 'function') return;
  const o = obj as FabricObject;
  const isText = o instanceof IText;
  const defaultPerPixel = !isText;
  o.set({
    selectable: true,
    evented: true,
    hasControls: true,
    hasBorders: true,
    lockRotation: true,
    hoverCursor: 'move',
    moveCursor: 'move',
    perPixelTargetFind: options?.perPixelTargetFind ?? defaultPerPixel,
    ...markControlVisual,
  });
  hideMarkRotationControl(o);
  if (o instanceof Group) {
    o.set({ subTargetCheck: false });
  }
  o.setCoords();
};

const drawArrowPath = (
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  thetaDeg: number,
  headlen: number,
): string => {
  const angle = (Math.atan2(fromY - toY, fromX - toX) * 180) / Math.PI;
  const angle1 = ((angle + thetaDeg) * Math.PI) / 180;
  const angle2 = ((angle - thetaDeg) * Math.PI) / 180;
  const topX = headlen * Math.cos(angle1);
  const topY = headlen * Math.sin(angle1);
  const botX = headlen * Math.cos(angle2);
  const botY = headlen * Math.sin(angle2);
  let path = ` M ${fromX} ${fromY}`;
  path += ` L ${toX} ${toY}`;
  let arrowX = toX + topX;
  let arrowY = toY + topY;
  path += ` M ${arrowX} ${arrowY}`;
  path += ` L ${toX} ${toY}`;
  arrowX = toX + botX;
  arrowY = toY + botY;
  path += ` L ${arrowX} ${arrowY}`;
  return path;
};

const buildArrowMark = (
  sx: number,
  sy: number,
  ex: number,
  ey: number,
  strokeColor: string,
  brushSize: number,
): Path => {
  const strokeWidth = Math.min(20, Math.max(1, Math.round(brushSize * 0.35)));
  const pathData = drawArrowPath(sx, sy, ex, ey, 30, 18);
  return new Path(pathData, {
    stroke: strokeColor,
    fill: 'rgba(255, 255, 255, 0)',
    strokeWidth,
    strokeLineCap: 'round',
    strokeLineJoin: 'round',
    selectable: false,
    evented: false,
    erasable: true,
    globalCompositeOperation: 'source-over',
  });
};

const MarkBottomToolbar: React.FC<MarkBottomToolbarProps> = ({ canvas, active, onCanvasCommit, onClose }) => {
  const [activeTool, setActiveTool] = useState<MarkTool>('brush');
  const [brushSize, setBrushSize] = useState(8);
  const [brushColor, setBrushColor] = useState('#9CA3AF');
  const [colorOpen, setColorOpen] = useState(false);

  const getBrush = React.useCallback(
    (target: Canvas) => {
      const brush = new PencilBrush(target);
      brush.color = brushColor;
      brush.width = brushSize;
      (brush as unknown as { globalCompositeOperation?: GlobalCompositeOperation }).globalCompositeOperation = 'source-over';
      return brush;
    },
    [brushSize, brushColor],
  );

  const handleToolChange = (tool: MarkTool) => {
    setActiveTool(tool);
    if (!canvas || !active) return;
    canvas.isDrawingMode = tool === 'brush';
    if (tool === 'brush') canvas.freeDrawingBrush = getBrush(canvas);
  };

  const handleBrushSizeChange = (size: number) => {
    setBrushSize(size);
    if (!canvas || !active) return;
    if (activeTool === 'brush') canvas.freeDrawingBrush = getBrush(canvas);
  };

  const handleExitClick = () => {
    onClose();
  };

  const handleSaveClick = () => {
    if (!canvas) {
      onClose();
      return;
    }
    canvas.discardActiveObject();
    canvas.requestRenderAll();
    window.requestAnimationFrame(() => {
      try {
        const nextImageSrc = canvas.toDataURL({
          format: 'png',
          multiplier: 1,
          enableRetinaScaling: false,
        });
        onClose(nextImageSrc);
      } catch {
        onClose();
      }
    });
  };

  const handleColorChange = (color: string) => {
    setBrushColor(color);
    setColorOpen(false);
    if (!canvas || !active) return;
    if (activeTool === 'brush') canvas.freeDrawingBrush = getBrush(canvas);
  };

  const renderColorDropdown = () => (
    <div className='px-2 py-4 bg-[var(--color-background-default-base)] rounded-full shadow-lg'>
      <div className='flex flex-col gap-[2px]'>
        {colorOptions.map((value) => (
          <div
            key={value}
            role='button'
            tabIndex={0}
            className='p-1 flex items-center justify-center w-full rounded-[2px] py-1.5 cursor-pointer'
            onClick={() => handleColorChange(value)}
            onKeyDown={(e) => e.key === 'Enter' && handleColorChange(value)}
          >
            <span
              className='w-5 h-5 rounded-full border border-[var(--color-border-default-base)] shrink-0 transition-transform hover:scale-110'
              style={{ backgroundColor: value }}
            />
          </div>
        ))}
      </div>
    </div>
  );

  useEffect(() => {
    if (!canvas || !active) return;
    canvas.isDrawingMode = activeTool === 'brush';
    canvas.selection = false;
    canvas.skipTargetFind = false;
    canvas.defaultCursor = activeTool === 'text' ? 'crosshair' : 'default';
    if (activeTool === 'brush') {
      canvas.freeDrawingBrush = getBrush(canvas);
      canvas.freeDrawingCursor = 'crosshair';
    }
    applyMarkControlVisual(canvas);

    let mouseFrom: { x: number; y: number } | null = null;
    let arrowEnd: { x: number; y: number } | null = null;
    let shapeDragEnd: { x: number; y: number } | null = null;
    let previewObject: Circle | Path | null = null;

    const shapeStrokeWidth = Math.max(1, Math.min(20, Math.round(brushSize * 0.35)));

    const clampToCanvas = (point: { x: number; y: number }): { x: number; y: number } => {
      const maxX = Math.max(0, canvas.getWidth());
      const maxY = Math.max(0, canvas.getHeight());
      return {
        x: Math.min(maxX, Math.max(0, point.x)),
        y: Math.min(maxY, Math.max(0, point.y)),
      };
    };

    const getPointer = (fabricOptions: unknown): { x: number; y: number } | null => {
      const nativeE = (fabricOptions as { e?: unknown })?.e;
      if (nativeE && typeof canvas.getScenePoint === 'function') {
        try {
          const sp = canvas.getScenePoint(nativeE as never);
          if (typeof sp?.x === 'number' && typeof sp?.y === 'number') {
            return clampToCanvas({ x: sp.x, y: sp.y });
          }
        } catch {
          void 0;
        }
      }

      const e = nativeE ?? fabricOptions;
      const scenePoint = (fabricOptions as { scenePoint?: { x?: unknown; y?: unknown } })?.scenePoint;
      if (typeof scenePoint?.x === 'number' && typeof scenePoint?.y === 'number') {
        return clampToCanvas({ x: scenePoint.x, y: scenePoint.y });
      }
      const absolutePointer = (fabricOptions as { absolutePointer?: { x?: unknown; y?: unknown } })?.absolutePointer;
      if (typeof absolutePointer?.x === 'number' && typeof absolutePointer?.y === 'number') {
        return clampToCanvas({ x: absolutePointer.x, y: absolutePointer.y });
      }

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

      const clientX = (e as { clientX?: unknown })?.clientX;
      const clientY = (e as { clientY?: unknown })?.clientY;
      const el =
        (canvas as unknown as { lowerCanvasEl?: HTMLElement; upperCanvasEl?: HTMLElement; getElement?: () => HTMLElement }).lowerCanvasEl ??
        (canvas as unknown as { lowerCanvasEl?: HTMLElement; upperCanvasEl?: HTMLElement; getElement?: () => HTMLElement }).upperCanvasEl ??
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
      const nextPath = e.path as { erasable?: boolean; globalCompositeOperation?: GlobalCompositeOperation };
      nextPath.erasable = true;
      nextPath.globalCompositeOperation = 'source-over';
      finalizeMarkObject(e.path, { perPixelTargetFind: true });
      onCanvasCommit?.();
    };

    const addTextAtPointer = (e: unknown) => {
      const evt = e as { target?: unknown };
      const hit = evt.target;
      if (hit instanceof IText) return;
      if (hit != null && !(hit instanceof FabricImage)) return;

      const p = getPointer(e);
      if (!p) return;

      const text = new IText('My text', {
        left: p.x,
        top: p.y,
        originX: 'center',
        originY: 'center',
        fontSize: 24,
        fontWeight: 'normal',
        fontStyle: 'normal',
        underline: false,
        linethrough: false,
        textAlign: 'left',
        charSpacing: 0,
        lineHeight: 1.16,
        fill: brushColor,
        editable: true,
      });
      const changeWidth = controlsUtils.changeWidth;
      text.controls.ml.actionHandler = changeWidth;
      text.controls.mr.actionHandler = changeWidth;
      text.controls.tl.cursorStyle = 'nwse-resize';
      text.controls.br.cursorStyle = 'nwse-resize';
      text.controls.tr.cursorStyle = 'nesw-resize';
      text.controls.bl.cursorStyle = 'nesw-resize';

      canvas.add(text);
      finalizeMarkObject(text);
      canvas.setActiveObject(text);
      canvas.requestRenderAll();
      onCanvasCommit?.();
    };

    const onMouseDown = (e: unknown) => {
      if (activeTool === 'text') {
        addTextAtPointer(e);
        return;
      }
      if (activeTool !== 'circle' && activeTool !== 'rectangle' && activeTool !== 'arrow') return;
      const shapeEvt = e as { target?: unknown };
      if (shapeEvt.target != null && !(shapeEvt.target instanceof FabricImage)) {
        return;
      }
      const p = getPointer(e);
      if (!p) return;
      mouseFrom = p;

      if (activeTool === 'arrow') {
        shapeDragEnd = null;
        const ex = p.x + shapeInitialSize;
        const ey = p.y + shapeInitialSize;
        arrowEnd = { x: ex, y: ey };
        previewObject = buildArrowMark(p.x, p.y, ex, ey, brushColor, brushSize);
        canvas.discardActiveObject();
        canvas.add(previewObject);
        canvas.requestRenderAll();
        return;
      }

      if (activeTool === 'rectangle') {
        shapeDragEnd = p;
        const fromX = p.x;
        const fromY = p.y;
        const toX = p.x + shapeInitialSize;
        const toY = p.y + shapeInitialSize;
        const path = `M ${fromX} ${fromY} L ${toX} ${fromY} L ${toX} ${toY} L ${fromX} ${toY} Z`;
        previewObject = new Path(path, {
          fill: 'rgba(255, 255, 255, 0)',
          stroke: brushColor,
          strokeWidth: shapeStrokeWidth,
          strokeLineJoin: 'miter',
          globalCompositeOperation: 'source-over',
          selectable: false,
          evented: false,
          erasable: true,
        });
      } else {
        shapeDragEnd = p;
        previewObject = new Circle({
          left: p.x + shapeInitialSize,
          top: p.y + shapeInitialSize,
          radius: shapeInitialSize,
          fill: 'rgba(255, 255, 255, 0)',
          stroke: brushColor,
          strokeWidth: shapeStrokeWidth,
          globalCompositeOperation: 'source-over',
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
      if (activeTool !== 'circle' && activeTool !== 'rectangle' && activeTool !== 'arrow') return;
      if (!mouseFrom) return;
      const p = getPointer(e);
      if (!p) return;
      if (previewObject) canvas.remove(previewObject);

      if (activeTool === 'arrow') {
        arrowEnd = { x: p.x, y: p.y };
        previewObject = buildArrowMark(mouseFrom.x, mouseFrom.y, p.x, p.y, brushColor, brushSize);
        canvas.add(previewObject);
        canvas.requestRenderAll();
        return;
      }

      if (activeTool === 'rectangle') {
        shapeDragEnd = p;
        const fromX = mouseFrom.x;
        const fromY = mouseFrom.y;
        const toX = p.x;
        const toY = p.y;
        const path = `M ${fromX} ${fromY} L ${toX} ${fromY} L ${toX} ${toY} L ${fromX} ${toY} Z`;
        previewObject = new Path(path, {
          fill: 'rgba(255, 255, 255, 0)',
          stroke: brushColor,
          strokeWidth: shapeStrokeWidth,
          strokeLineJoin: 'miter',
          globalCompositeOperation: 'source-over',
          selectable: false,
          evented: false,
          erasable: true,
        });
      } else {
        shapeDragEnd = p;
        const dx = p.x - mouseFrom.x;
        const dy = p.y - mouseFrom.y;
        const radius = Math.max(1, Math.max(Math.abs(dx), Math.abs(dy)) / 2);
        const signX = dx >= 0 ? 1 : -1;
        const signY = dy >= 0 ? 1 : -1;
        const left = mouseFrom.x + signX * radius;
        const top = mouseFrom.y + signY * radius;
        previewObject = new Circle({
          left,
          top,
          radius,
          fill: 'rgba(255, 255, 255, 0)',
          stroke: brushColor,
          strokeWidth: shapeStrokeWidth,
          globalCompositeOperation: 'source-over',
          selectable: false,
          evented: false,
          erasable: true,
        });
      }

      canvas.add(previewObject);
      canvas.requestRenderAll();
    };

    const onBrushDownBefore = (opt: { e?: unknown; target?: FabricObject }) => {
      if (activeTool !== 'brush') return;
      const btn = (opt.e as MouseEvent | undefined)?.button;
      if (typeof btn === 'number' && btn !== 0) return;
      const t = opt.target;
      if (t && !(t instanceof FabricImage)) {
        canvas.isDrawingMode = false;
      }
    };

    const onBrushMoveCursor = (opt: { target?: FabricObject }) => {
      if (activeTool !== 'brush') return;
      const c = canvas as unknown as { _isCurrentlyDrawing?: boolean };
      if (c._isCurrentlyDrawing) return;
      if (!canvas.isDrawingMode) return;

      const drawCursor = canvas.freeDrawingCursor || 'crosshair';
      const t = opt.target;
      const onMark = t != null && !(t instanceof FabricImage);
      canvas.setCursor(onMark ? 'move' : drawCursor);
    };

    const onMouseUp = () => {
      if (activeTool === 'brush') {
        canvas.isDrawingMode = true;
        canvas.freeDrawingBrush = getBrush(canvas);
      }
      if (activeTool === 'arrow' && previewObject && mouseFrom && arrowEnd) {
        const d = Math.hypot(arrowEnd.x - mouseFrom.x, arrowEnd.y - mouseFrom.y);
        if (d < minShapeDragPx) {
          canvas.remove(previewObject);
          previewObject = null;
          mouseFrom = null;
          arrowEnd = null;
          shapeDragEnd = null;
          canvas.requestRenderAll();
          return;
        }
      }
      if ((activeTool === 'circle' || activeTool === 'rectangle') && previewObject && mouseFrom && shapeDragEnd) {
        const d = Math.hypot(shapeDragEnd.x - mouseFrom.x, shapeDragEnd.y - mouseFrom.y);
        if (d < minShapeDragPx) {
          canvas.remove(previewObject);
          previewObject = null;
          mouseFrom = null;
          shapeDragEnd = null;
          arrowEnd = null;
          canvas.requestRenderAll();
          return;
        }
      }
      if (previewObject) {
        const added = previewObject;
        finalizeMarkObject(added, { perPixelTargetFind: true });
        onCanvasCommit?.();
      }
      mouseFrom = null;
      arrowEnd = null;
      shapeDragEnd = null;
      previewObject = null;
      canvas.requestRenderAll();
    };

    canvas.on('mouse:down:before', onBrushDownBefore);
    canvas.on('mouse:move', onBrushMoveCursor);
    canvas.on('path:created', onPathCreated);
    canvas.on('mouse:down', onMouseDown);
    canvas.on('mouse:move', onMouseMove);
    canvas.on('mouse:up', onMouseUp);
    return () => {
      canvas.off('mouse:down:before', onBrushDownBefore);
      canvas.off('mouse:move', onBrushMoveCursor);
      canvas.off('path:created', onPathCreated);
      canvas.off('mouse:down', onMouseDown);
      canvas.off('mouse:move', onMouseMove);
      canvas.off('mouse:up', onMouseUp);
      canvas.isDrawingMode = false;
      canvas.selection = false;
      canvas.skipTargetFind = false;
      canvas.defaultCursor = 'default';
    };
  }, [canvas, active, activeTool, getBrush, brushColor, brushSize, onCanvasCommit]);

  return (
    <div className='nodrag nopan pointer-events-auto flex flex-col items-center gap-3'>
      <div
        className='nodrag nopan pointer-events-auto flex h-[40px] items-center gap-1 rounded-[8px] border border-[#DBDBDB] bg-background-default-base px-[12px] py-[4px] shadow-[0_1px_3px_rgba(0,0,0,0.08)]'
        onMouseDown={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className={markLabelClass}>
          <Icon name='imageEditor-mark-title-icon' width={22} height={22} color='var(--bg-icon-base)' />
          <span className='text-text-default-base text-sm font-bold'>Mark</span>
        </div>
        <Divider type='vertical' className='mx-2 h-[18px] bg-[#D0D0D0]' />
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
            <Icon name='imageEditor-flow-inpaint-rectangle-icon' width={18} height={18} />
          </button>
        </Tooltip>
        <Tooltip title='Arrow' placement='top' offset={4}>
          <button
            type='button'
            className={`${iconBtnClass} ${activeTool === 'arrow' ? iconBtnActiveClass : ''}`}
            aria-label='Mark arrow'
            onClick={() => handleToolChange('arrow')}
          >
            <Icon name='imageEditor-mark-arrow-tool-icon' width={17} height={17} />
          </button>
        </Tooltip>
        <Divider type='vertical' className='mx-2 h-[18px] bg-[#D0D0D0]' />
        <Tooltip title='Brush' placement='top' offset={4}>
          <button
            type='button'
            className={`${iconBtnClass} ${activeTool === 'brush' ? iconBtnActiveClass : ''}`}
            aria-label='Mark brush'
            onClick={() => handleToolChange('brush')}
          >
            <Icon name='imageEditor-flow-inpaint-brush-icon' width={20} height={20} />
          </button>
        </Tooltip>
        <div className='nodrag nopan flex h-8 items-center pl-0.5'>
          <Dropdown
            trigger='click'
            placement='top'
            offset={12}
            open={colorOpen}
            onOpenChange={setColorOpen}
            items={[]}
            popupRender={renderColorDropdown}
          >
            <button
              type='button'
              className='nodrag nopan block h-6 w-6 rounded-full border border-white shadow-[inset_0_0_0_1px_rgba(0,0,0,0.06)]'
              style={{ backgroundColor: brushColor }}
              aria-label='Mark color'
            />
          </Dropdown>
        </div>
        <div className={markSliderWrapClass} onPointerDown={(e) => e.stopPropagation()}>
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
        <Tooltip title='Text' placement='top' offset={4}>
          <button
            type='button'
            className={`${iconBtnClass} ${activeTool === 'text' ? iconBtnActiveClass : ''}`}
            aria-label='Mark text'
            onClick={() => handleToolChange('text')}
          >
            <Icon name='imageEditor-mark-text-tool-icon' width={14} height={16} />
          </button>
        </Tooltip>
        <Divider type='vertical' className='mx-2 h-[18px] bg-[#D0D0D0]' />
        <Button
          type='primary'
          shape='round'
          className='nodrag nopan !h-[28px] !bg-[#2FB344] !px-3 !text-[13px] !font-semibold !text-white hover:!bg-[#28A13D]'
          onClick={handleSaveClick}
        >
          <Icon name='imageEditor-mark-save-icon' width={18} height={18} />
          <span className='pl-2'>Save</span>
        </Button>
        <Divider type='vertical' className='mx-2 h-[18px] bg-[#D0D0D0]' />
        <Tooltip title='Exit' placement='top' offset={4}>
          <button type='button' className={iconBtnClass} onClick={handleExitClick} aria-label='Close inpaint toolbar'>
            <Icon name='imageEditor-multi-angle-close-icon' width={20} height={20} />
          </button>
        </Tooltip>
      </div>
    </div>
  );
};

export default MarkBottomToolbar;

