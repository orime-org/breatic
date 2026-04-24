import React, { useRef, useEffect, useMemo, memo } from 'react';
import { useVideoEditorStore } from '@/hooks/useVideoEditorStore';

interface TimelineScaleProps {
  /** 单个刻度标记范畴(>0)，例如 5 表示每 5 秒一个主刻度 */
  scale: number;
  /** 单个刻度细分单元数（>0整数），例如 5 表示主刻度之间有 5 个次刻度 */
  scaleSplitCount: number;
  /** 单个刻度的显示宽度（>0, 单位：px） */
  scaleWidth: number;
  /** 刻度开始距离左侧的距离（>=0, 单位：px） */
  startLeft: number;
  /** 容器宽度 */
  width: number;
  /** 容器高度 */
  height?: number;
  /** 显示的时长（如果没有素材时，应该使用容器对应的时长） */
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

  // 计算每个细分单元的时间间隔
  const subScaleTime = scale / scaleSplitCount;
  // 计算每个细分单元的像素宽度
  const subScaleWidth = scaleWidth / scaleSplitCount;

  // 主刻度样式
  const majorTextColor = '#9ca3af';
  const majorTextSize = 11;

  // 次刻度样式
  const minorTickHeight = 8;
  const minorTickColor = '#d1d5db';
  const minorTickBottomOffset = 12; // 次刻度线距离底部的偏移

  // 设置字体
  ctx.font = `${majorTextSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // 计算需要绘制的刻度数量
  const totalSubScales = Math.ceil(duration / subScaleTime);

  for (let i = 0; i <= totalSubScales; i++) {
    const currentTime = i * subScaleTime;
    if (currentTime > duration) break;

    const x = startLeft + i * subScaleWidth;
    const isMajorTick = i % scaleSplitCount === 0;

    if (isMajorTick) {
      // 绘制主刻度标签
      ctx.fillStyle = majorTextColor;
      const label = formatTime(currentTime);
      ctx.fillText(label, x, height / 2);
    } else {
      // 绘制次刻度线（从底部往上，留一点间距）
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
  // 从 store 获取 clips 并计算 duration
  const { clips } = useVideoEditorStore();
  // 使用传入的 displayDuration 或 clips 的时长，确保至少显示容器宽度对应的时长
  const duration = useMemo(() => {
    const clipsDuration = clips.length === 0 ? 0 : Math.max(...clips.map((c) => c.end));
    return Math.max(clipsDuration, propDisplayDuration || 0, 5); // 至少显示5秒
  }, [clips, propDisplayDuration]);

  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // 设置 canvas 实际尺寸（考虑设备像素比）
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);

    // 清空画布
    ctx.clearRect(0, 0, width, height);

    // 绘制刻度
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

