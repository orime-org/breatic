import type { MediaItem, TimelineClip } from '@/apps/videoEditor/types';

export type AudioExportOptions = {
  format: string;
  bitrate: string;
  sampleRate: number;
};

/** Placeholder audio export for local dev. */
export async function exportAudio(
  _clips: TimelineClip[],
  _mediaItems: MediaItem[],
  setExportProgress: (n: number) => void,
  _options: AudioExportOptions,
  signal?: AbortSignal
): Promise<Blob> {
  if (signal?.aborted) {
    throw new DOMException('Export was cancelled', 'AbortError');
  }
  setExportProgress(50);
  setExportProgress(100);
  return new Blob([], { type: 'audio/wav' });
}
