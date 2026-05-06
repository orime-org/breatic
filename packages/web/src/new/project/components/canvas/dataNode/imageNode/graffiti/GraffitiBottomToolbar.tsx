import React, { useEffect, useState } from 'react';
import { Canvas, Circle, PencilBrush, Path } from 'fabric';
import { EraserBrush } from '@erase2d/fabric';
import Slider from '@/ui/slider';
import Tooltip from '@/ui/tooltip';
import { Icon } from '@/ui/icon';
import { Button } from '@/ui/button';
import Dropdown from '@/ui/dropdown';
import Divider from '@/ui/divider';
import AgentComposerInput from '@/components/base/agent/AgentInput';

type GraffitiTool = 'brush' | 'circle' | 'rectangle' | 'eraser';

type GraffitiBottomToolbarProps = {
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
const graffitiLabelClass = 'nodrag nopan inline-flex h-8 items-center gap-1';
const graffitiSliderWrapClass =
  'nodrag nopan mx-1 flex h-8 w-[96px] shrink-0 [&_.slider-container]:flex [&_.slider-container]:h-full [&_.slider-container]:w-full [&_.slider-container]:items-center';
const colorOptions = ['#9CA3AF', '#0C0C0D', '#FFD600', '#FF9230', '#FF375F', '#DB34F2', '#6D7CFF', '#00DAC3', '#30D158'];
const disabledLeftSlotClass =
  'inline-flex h-[40px] items-center gap-1.5 rounded-full border border-[#C8C8C8] px-4 text-[12px] font-semibold !text-text-disabled-base cursor-not-allowed bg-[var(--color-background-default-base)]';

const GraffitiBottomToolbar: React.FC<GraffitiBottomToolbarProps> = ({
  canvas,
  active,
  onCanvasCommit,
  onClose,
  nodeId: _nodeId,
}) => {
  const [activeTool, setActiveTool] = useState<GraffitiTool>('brush');
  const [brushSize, setBrushSize] = useState(8);
  const [brushColor, setBrushColor] = useState('#FF375F');
  const [colorOpen, setColorOpen] = useState(false);
  const [inputEmpty, setInputEmpty] = useState(true);

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

  const getEraser = React.useCallback(
    (target: Canvas) => {
      const eraser = new EraserBrush(target);
      eraser.width = brushSize;
      return eraser;
    },
    [brushSize],
  );

  const handleToolChange = (tool: GraffitiTool) => {
    setActiveTool(tool);
    if (!canvas || !active) return;
    canvas.isDrawingMode = tool === 'brush' || tool === 'eraser';
    if (tool === 'brush') canvas.freeDrawingBrush = getBrush(canvas);
    if (tool === 'eraser') canvas.freeDrawingBrush = getEraser(canvas);
  };

  const handleBrushSizeChange = (size: number) => {
    setBrushSize(size);
    if (!canvas || !active) return;
    if (activeTool === 'brush') canvas.freeDrawingBrush = getBrush(canvas);
    if (activeTool === 'eraser') canvas.freeDrawingBrush = getEraser(canvas);
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
    canvas.isDrawingMode = activeTool === 'brush' || activeTool === 'eraser';
    canvas.selection = false;
    canvas.skipTargetFind = true;
    canvas.defaultCursor = 'crosshair';
    if (activeTool === 'brush') {
      canvas.freeDrawingBrush = getBrush(canvas);
      canvas.freeDrawingCursor = 'crosshair';
    }
    if (activeTool === 'eraser') {
      canvas.freeDrawingBrush = getEraser(canvas);
      canvas.freeDrawingCursor = 'crosshair';
    }

    let mouseFrom: { x: number; y: number } | null = null;
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
        (canvas as unknown as { lowerCanvasEl?: HTMLElement; upperCanvasEl?: HTMLElement; getElement?: () => HTMLElement }).lowerCanvasEl
        ?? (canvas as unknown as { lowerCanvasEl?: HTMLElement; upperCanvasEl?: HTMLElement; getElement?: () => HTMLElement }).upperCanvasEl
        ?? (canvas as unknown as { getElement?: () => HTMLElement }).getElement?.();

      if (typeof clientX !== 'number' || typeof clientY !== 'number' || !el || !('getBoundingClientRect' in el)) return null;
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
      const nextPath = e.path as {
        erasable?: boolean;
        globalCompositeOperation?: GlobalCompositeOperation;
        selectable?: boolean;
        evented?: boolean;
      };
      nextPath.erasable = true;
      nextPath.globalCompositeOperation = 'source-over';
      nextPath.selectable = false;
      nextPath.evented = false;
      onCanvasCommit?.();
    };

    const onMouseDown = (e: unknown) => {
      if (activeTool !== 'circle' && activeTool !== 'rectangle') return;
      const p = getPointer(e);
      if (!p) return;
      mouseFrom = p;

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
      if (activeTool !== 'circle' && activeTool !== 'rectangle') return;
      if (!mouseFrom) return;
      const p = getPointer(e);
      if (!p) return;
      if (previewObject) canvas.remove(previewObject);

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

    const onMouseUp = () => {
      if (activeTool === 'brush' || activeTool === 'eraser') {
        canvas.isDrawingMode = true;
        canvas.freeDrawingBrush = activeTool === 'brush' ? getBrush(canvas) : getEraser(canvas);
      }
      if ((activeTool === 'circle' || activeTool === 'rectangle') && previewObject && mouseFrom && shapeDragEnd) {
        const d = Math.hypot(shapeDragEnd.x - mouseFrom.x, shapeDragEnd.y - mouseFrom.y);
        if (d < minShapeDragPx) {
          canvas.remove(previewObject);
          previewObject = null;
          mouseFrom = null;
          shapeDragEnd = null;
          canvas.requestRenderAll();
          return;
        }
      }
      if (previewObject) {
        onCanvasCommit?.();
      }
      mouseFrom = null;
      shapeDragEnd = null;
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
      canvas.selection = false;
      canvas.skipTargetFind = false;
      canvas.defaultCursor = 'default';
    };
  }, [canvas, active, activeTool, getBrush, getEraser, brushColor, brushSize, onCanvasCommit]);

  return (
    <div className='nodrag nopan pointer-events-auto flex flex-col items-center gap-3'>
      <div
        className='nodrag nopan pointer-events-auto flex h-[40px] items-center gap-1 rounded-[8px] border border-[#DBDBDB] bg-background-default-base px-[12px] py-[4px] shadow-[0_1px_3px_rgba(0,0,0,0.08)]'
        onMouseDown={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className={graffitiLabelClass}>
          <Icon name='imageEditor-more-graffiti-icon' width={22} height={22} color='var(--bg-icon-base)' />
          <span className='text-text-default-base text-sm font-bold'>Graffiti</span>
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
        <Tooltip title='Brush' placement='top' offset={4}>
          <button
            type='button'
            className={`${iconBtnClass} ${activeTool === 'brush' ? iconBtnActiveClass : ''}`}
            aria-label='Graffiti brush'
            onClick={() => handleToolChange('brush')}
          >
            <Icon name='imageEditor-flow-inpaint-brush-icon' width={20} height={20} />
          </button>
        </Tooltip>
        <div className='nodrag nopan flex h-8 items-center pl-0.5'>
          <Dropdown trigger='click' placement='top' offset={12} open={colorOpen} onOpenChange={setColorOpen} items={[]} popupRender={renderColorDropdown}>
            <button
              type='button'
              className='nodrag nopan block h-6 w-6 rounded-full border border-white shadow-[inset_0_0_0_1px_rgba(0,0,0,0.06)]'
              style={{ backgroundColor: brushColor }}
              aria-label='Graffiti color'
            />
          </Dropdown>
        </div>
        <div className={graffitiSliderWrapClass} onPointerDown={(e) => e.stopPropagation()}>
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
        <Divider type='vertical' className='mx-2 h-[18px] bg-[#D0D0D0]' />
        <Tooltip title='Eraser' placement='top' offset={4}>
          <button
            type='button'
            className={`${iconBtnClass} ${activeTool === 'eraser' ? iconBtnActiveClass : ''}`}
            aria-label='Graffiti eraser'
            onClick={() => handleToolChange('eraser')}
          >
            <Icon name='imageEditor-flow-inpaint-eraser-icon' width={22} height={22} />
          </button>
        </Tooltip>
        <Divider type='vertical' className='mx-2 h-[18px] bg-[#D0D0D0]' />
        <Tooltip title='Exit' placement='top' offset={4}>
          <button type='button' className={iconBtnClass} onClick={handleExitClick} aria-label='Close graffiti toolbar'>
            <Icon name='imageEditor-multi-angle-close-icon' width={20} height={20} />
          </button>
        </Tooltip>
      </div>
      <div className='pointer-events-auto h-[150px] w-[470px] overflow-hidden rounded-[8px] border border-[#DBDBDB] bg-background-default-base shadow-[0_1px_3px_rgba(0,0,0,0.08)]'>
        <div className='flex h-full flex-col px-3 py-2'>
          <AgentComposerInput
            className='flex-1 !cursor-text'
            placeholder='Please describe the modifications you want here.'
            disabled={!active}
            onEnterSend={handleSaveClick}
            onEmptyChange={setInputEmpty}
            upstreamItems={[]}
            uploadItems={[]}
          />
          <div className='mt-2 flex items-center justify-between gap-2'>
            <Button type='default' shape='round' disabled className={disabledLeftSlotClass} aria-label='Nano Banana Pro disabled'>
              <Icon name='imageEditor-nano-banana-pro-icon' width={16} height={17} color='var(--color-bg-icon-tertiary-hover)' />
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
                onClick={handleSaveClick}
                className='!h-[28px] w-[52px] shrink-0 !border-[#35C838] !bg-[#35C838] !py-[2px] !pl-[16px] !pr-[12px] hover:!border-[#35C838] hover:!bg-[#35C838] disabled:!border-[#CDCDCD] disabled:!bg-[#CDCDCD]'
                aria-label='Send'
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default GraffitiBottomToolbar;

