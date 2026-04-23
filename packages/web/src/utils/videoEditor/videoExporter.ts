import type { MediaItem, TimelineClip } from '@/apps/videoEditor/types';

export type VideoExportOptions = {
  resolution: string;
  frameRate: number;
  bitrate: string;
  bitrateMode: string;
  codec: string;
  audioSampleRate: number;
  audioQuality: string;
  format: string;
};

/** Placeholder blob so export UI completes in local-only mode (replace with FFmpeg pipeline later). */
export async function exportAsMP4(
  _clips: TimelineClip[],
  _mediaItems: MediaItem[],
  _canvasRatio: string,
  setExportProgress: (n: number) => void,
  _options: VideoExportOptions,
  signal?: AbortSignal
): Promise<Blob> {
  if (signal?.aborted) {
    throw new DOMException('Export was cancelled', 'AbortError');
  }
  setExportProgress(30);
  const text = new TextEncoder().encode(
    'Video export is not bundled in this dev build. Use download after implementing FFmpeg export.'
  );
  setExportProgress(100);
  return new Blob([text], { type: 'text/plain' });
}
