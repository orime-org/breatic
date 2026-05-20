import type { ProjectRole } from '@/stores';
import { apiDelete, apiGet, apiPatch, apiPost } from '@/data/api/request';
import type { PageMeta, Pagination } from '@/data/api/types';

export interface ProjectSummary {
  id: string;
  name: string;
  role: ProjectRole;
  thumbnailUrl?: string;
  updatedAt: string;
}

export interface ProjectDetail extends ProjectSummary {
  description?: string;
  membersCount: number;
}

interface ProjectsList {
  projects: ProjectSummary[];
  meta: PageMeta;
}

export const projectsApi = {
  list(params: Pagination = {}) {
    return apiGet<ProjectsList>('/projects', { params });
  },
  get(id: string) {
    return apiGet<ProjectDetail>(`/projects/${id}`);
  },
  create(body: { name: string; templateId?: string }) {
    return apiPost<ProjectDetail>('/projects', body);
  },
  rename(id: string, name: string) {
    return apiPatch<ProjectDetail>(`/projects/${id}`, { name });
  },
  delete(id: string) {
    return apiDelete(`/projects/${id}`);
  },
};
