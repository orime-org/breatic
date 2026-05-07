import type { HistoryItem } from '@breatic/shared';

export type VideoEditorToolKey =
  | 'quick-edit'
  | 'cut'
  | 'speed'
  | 'upscale'
  | 'interpolate'
  | 'erase'
  | 'extend'
  | 'animate'
  | 'adjust'
  | 'stabilization'
  | 'crop'
  | 'hdr-conversion'
  | 'cutout'
  | 'scene-extension'
  | 'audio-denoise';

export type VideoNodeData = {
  name?: string;
  history?: HistoryItem[];
  activeHistoryId?: string;
};
