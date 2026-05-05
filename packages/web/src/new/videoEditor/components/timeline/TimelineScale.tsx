import React, { useRef, useEffect, useMemo, memo } from 'react';
import { useVideoEditorStore } from '@/hooks/useVideoEditorStore';

interface TimelineScaleProps {
  /* * tick (>0)， 5 5 sec tick */
  scale: number;
  /* * tick （>0 ）， 5 tick 5 tick */
  scaleSplitCount: number;
  /* * tick displaywidth（>0, ：px） */
  scaleWidth: number;
  /* * tickstartoffsetleft offset（>=0, ：px） */
  startLeft: number;
  /* * containerwidth */ width: number; /** containerheight */ height?: number; /** display （ifnoasset ， usecontainercorresponding ） */
  displayDuration?: number;
}

function formatTime(seconds: number): string {
  if (seconds === 0) return '0';

  if (seconds >= 60) {
    const minutes = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return secs === 0
      ? `${minutes}:00`
      : `${minutes}:${secs.toString().padStart(2, '0')}`;
  }

  return `${seconds}s`;
}

function drawScale(
  ctx: CanvasRenderingContext2D,
  options: {
    scale: number;
    scaleSplitCount: number;
    scaleWidth: number;
    startLeft: number;
    duration: number;
    width: number;
    height: number;
  }
) {
  const { scale, scaleSplitCount, scaleWidth, startLeft, duration, height } = options;

  // calculate time
  const subScaleTime = scale / scaleSplitCount;
  // calculate width
  const subScaleWidth = scaleWidth / scaleSplitCount;

  // tickstyle
  const majorTextColor = '#9ca3af';
  const majorTextSize = 11;

  // tickstyle
  const minorTickHeight = 8;
  const minorTickColor = '#d1d5db';
  const minorTickBottomOffset = 12; // ticklineoffsetbottom offset

  // setfont
  ctx.font = `${majorTextSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // calculateneed to tick
  const totalSubScales = Math.ceil(duration / subScaleTime);

  for (let i = 0; i <= totalSubScales; i++) {
    const currentTime = i * subScaleTime;
    if (currentTime > duration) break;

    const x = startLeft + i * subScaleWidth;
    const isMajorTick = i % scaleSplitCount === 0;

    if (isMajorTick) {
      // tick
      ctx.fillStyle = majorTextColor;
      const label = formatTime(currentTime);
      ctx.fillText(label, x, height / 2);
    } else {
      // tickline（ bottom up， ）
      ctx.strokeStyle = minorTickColor;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, height - minorTickBottomOffset - minorTickHeight);
      ctx.lineTo(x, height - minorTickBottomOffset);
      ctx.stroke();
    }
  }
}

const TimelineScale: React.FC<TimelineScaleProps> = ({
  scale,
  scaleSplitCount,
  scaleWidth,
  startLeft,
  width,
  height = 32,
  displayDuration: propDisplayDuration,
}) => {
  // store get clips calculate duration
  const { clips } = useVideoEditorStore();
  // use displayDuration clips ，ensureat leastdisplaycontainerwidthcorresponding
  const duration = useMemo(() => {
    const clipsDuration = clips.length === 0 ? 0 : Math.max(...clips.map((c) => c.end));
    return Math.max(clipsDuration, propDisplayDuration || 0, 5); // at leastdisplay5sec
  }, [clips, propDisplayDuration]);

  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // set canvas actual （ ）
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);

    // canvas
    ctx.clearRect(0, 0, width, height);

    // tick
    drawScale(ctx, {
      scale,
      scaleSplitCount,
      scaleWidth,
      startLeft,
      duration,
      width,
      height,
    });
  }, [scale, scaleSplitCount, scaleWidth, startLeft, duration, width, height]);

  return (
    <canvas
      ref={canvasRef}
      className='block'
      style={{ width: `${width}px`, height: `${height}px` }}
    />
  );
};

export default memo(TimelineScale);

