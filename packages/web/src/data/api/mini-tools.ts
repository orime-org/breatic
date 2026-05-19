import { apiPost } from './request';
import type { CanvasTask } from './canvas';

interface BaseToolRequest {
  projectId: string;
  spaceId: string;
  sourceNodeId: string;
  toolId: string;
  params: Record<string, unknown>;
}

export const miniToolsApi = {
  image(body: BaseToolRequest) {
    return apiPost<CanvasTask>('/mini-tools/image', body);
  },
  audio(body: BaseToolRequest) {
    return apiPost<CanvasTask>('/mini-tools/audio', body);
  },
  video(body: BaseToolRequest) {
    return apiPost<CanvasTask>('/mini-tools/video', body);
  },
};
