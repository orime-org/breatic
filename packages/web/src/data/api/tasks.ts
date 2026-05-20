import { apiGet } from '@/data/api/request';
import type { CanvasTask } from '@/data/api/canvas';

export const tasksApi = {
  list(params: { page?: number; limit?: number } = {}) {
    return apiGet<{ tasks: CanvasTask[] }>('/tasks', { params });
  },
  get(id: string) {
    return apiGet<CanvasTask>(`/tasks/${id}`);
  },
};
