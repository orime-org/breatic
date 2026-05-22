import type { SpaceType } from '@/spaces';
import { apiDelete, apiPost } from '@/data/api/request';

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
  /**
   * Lock / unlock a Space. Lock is a UX guard ("don't accidentally
   * delete this Space"), not a security boundary — the server simply
   * stamps the meta doc via `publishSpaceLocked`, which the collab
   * service then mirrors into `meta.spaces[id].locked` so all clients
   * see the indicator.
   */
  setLocked(projectId: string, spaceId: string, locked: boolean) {
    if (locked) {
      return apiPost(`/projects/${projectId}/spaces/${spaceId}/lock`, {});
    }
    return apiDelete(`/projects/${projectId}/spaces/${spaceId}/lock`);
  },
};
