import type { MediaItem, TimelineClip } from '@/apps/videoEditor/types';

/** Minimal single-frame export so the video editor route can build without the full compositor. */
export async function exportFrameAsPNG(
  _clips: TimelineClip[],
  _mediaItems: MediaItem[],
  _currentTime: number,
  _resolution: string,
  setExportProgress: (n: number) => void,
  getBaseCanvasSize: (ratio: string) => { width: number; height: number },
  _imageFormat: string,
  canvasRatio: string,
  signal?: AbortSignal
): Promise<Blob> {
  if (signal?.aborted) {
    throw new DOMException('Export was cancelled', 'AbortError');
  }
  setExportProgress(10);
  const { width, height } = getBaseCanvasSize(canvasRatio);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(2, Math.min(width, 1920));
  canvas.height = Math.max(2, Math.min(height, 1080));
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Canvas 2D unavailable');
  }
  ctx.fillStyle = '#111827';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#e5e7eb';
  ctx.font = '24px sans-serif';
  ctx.fillText('Preview export (stub)', 24, 48);
  setExportProgress(90);
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png');
  });
  setExportProgress(100);
  return blob;
}
