import { apiGet, apiPost } from '@/data/api/request';

export interface CanvasTask {
  id: string;
  projectId: string;
  spaceId: string;
  nodeId: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  createdAt: string;
  finishedAt?: string;
  resultUrl?: string;
  errorMessage?: string;
}

export const canvasApi = {
  createTask(body: {
    projectId: string;
    spaceId: string;
    nodeId: string;
    type: 'image' | 'audio' | 'video' | 'tts' | '3d';
    params: Record<string, unknown>;
  }) {
    return apiPost<CanvasTask>('/canvas/tasks', body);
  },
  understand(body: {
    projectId: string;
    spaceId: string;
    nodeId: string;
    sourceUrl: string;
    /** asr | description | etc. */
    kind: string;
  }) {
    return apiPost<CanvasTask>('/canvas/understand', body);
  },
  listTasks(projectId: string, params: { page?: number; limit?: number } = {}) {
    return apiGet<{ tasks: CanvasTask[] }>('/canvas/tasks', {
      params: { projectId, ...params },
    });
  },
};
