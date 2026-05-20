import type { SpaceType } from '@/spaces';
import { apiDelete, apiPost } from './request';

export interface SpaceSummary {
  id: string;
  name: string;
  type: SpaceType;
}

export const spacesApi = {
  create(projectId: string, body: { name: string; type: SpaceType }) {
    return apiPost<SpaceSummary>(`/projects/${projectId}/spaces`, body);
  },
  delete(projectId: string, spaceId: string) {
    return apiDelete(`/projects/${projectId}/spaces/${spaceId}`);
  },
};
