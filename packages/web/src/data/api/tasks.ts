import { apiGet } from './request';
import type { CanvasTask } from './canvas';

export const tasksApi = {
  list(params: { page?: number; limit?: number } = {}) {
    return apiGet<{ tasks: CanvasTask[] }>(`/tasks`, { params });
  },
  get(id: string) {
    return apiGet<CanvasTask>(`/tasks/${id}`);
  },
};
