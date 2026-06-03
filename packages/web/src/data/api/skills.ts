// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { apiDelete, apiGet, apiPost } from '@web/data/api/request';

export interface Skill {
  id: string;
  name: string;
  description: string;
  scope: ('agent' | 'canvas')[];
  category: string;
  isOwn?: boolean;
  isPublished?: boolean;
}

export const skillsApi = {
  list() {
    return apiGet<{ skills: Skill[] }>('/skills');
  },
  listMine() {
    return apiGet<{ skills: Skill[] }>('/skills/mine');
  },
  get(id: string) {
    return apiGet<Skill>(`/skills/${id}`);
  },
  publish(id: string) {
    return apiPost<Skill>(`/skills/mine/${id}/publish`);
  },
  delete(id: string) {
    return apiDelete(`/skills/mine/${id}`);
  },
};
