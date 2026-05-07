import type { LocalCanvasNodeData } from '@/new/project/types';

/**
 * Node `data` fields used when resolving upstream previews for the local generator toolbar.
 * Keeps `new/project` free of `apps/project` canvas type imports.
 */
export type LocalUpstreamSourceData = Partial<LocalCanvasNodeData> & {
  activeHistoryId?: string;
  history?: Array<{ id: string; url?: string }>;
};
