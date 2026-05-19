import * as React from 'react';

import { useInpaintStore } from '@/stores';

interface InpaintCanvasProps {
  /** Background image URL — drawn beneath the mask preview. */
  imageUrl: string;
  /** Natural image size, used as the mask coordinate system. */
  width: number;
  height: number;
}

/**
 * Inpaint mask editor overlay. Renders the source image with the live
 * mask painted on top. Strokes are appended to `useInpaintStore` so undo
 * / redo + final export run against a single source of truth.
 *
 * PR 11 ships the structural overlay + pointer wiring; the visual
 * polish (cursor preview, dashed marquee, multi-canvas compositing)
 * arrives with the inpaint provider integration.
 */
export function InpaintCanvas({ imageUrl, width, height }: InpaintCanvasProps) {
  const tool = useInpaintStore((s) => s.tool);
  const brushSize = useInpaintStore((s) => s.brushSize);
  const opacity = useInpaintStore((s) => s.opacity);
  const strokes = useInpaintStore((s) => s.strokes);
  const beginStroke = useInpaintStore((s) => s.beginStroke);
  const appendPoint = useInpaintStore((s) => s.appendPoint);
  const endStroke = useInpaintStore((s) => s.endStroke);
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const [drawing, setDrawing] = React.useState(false);

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = tool === 'brush' ? '#ff3366' : '#ffffff';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    strokes.forEach((s) => {
      if (s.points.length === 0) return;
      ctx.globalAlpha = s.alpha;
      ctx.lineWidth = Math.max(1, s.radius * 2);
      ctx.beginPath();
      const first = s.points[0];
      ctx.moveTo(first.x, first.y);
      for (let i = 1; i < s.points.length; i++) {
        ctx.lineTo(s.points[i].x, s.points[i].y);
      }
      ctx.stroke();
    });
  }, [strokes, tool]);

  const pointFromEvent = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const scaleX = width / rect.width;
    const scaleY = height / rect.height;
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY,
    };
  };

  return (
    <div
      data-testid='inpaint-canvas-root'
      className='relative inline-block'
      style={{ width, height }}
    >
      <img
        src={imageUrl}
        alt=''
        width={width}
        height={height}
        className='block select-none'
        data-testid='inpaint-canvas-image'
      />
      <canvas
        ref={canvasRef}
        width={width}
        height={height}
        data-testid='inpaint-canvas-mask'
        className='absolute inset-0'
        onPointerDown={(e) => {
          setDrawing(true);
          beginStroke({ radius: brushSize / 2, alpha: opacity });
          appendPoint(pointFromEvent(e));
        }}
        onPointerMove={(e) => {
          if (!drawing) return;
          appendPoint(pointFromEvent(e));
        }}
        onPointerUp={() => {
          if (!drawing) return;
          setDrawing(false);
          endStroke();
        }}
      />
    </div>
  );
}
