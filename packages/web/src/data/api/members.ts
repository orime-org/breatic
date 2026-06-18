// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { apiDelete, apiGet, apiPatch } from '@web/data/api/request';

export type MemberRole = 'owner' | 'editor' | 'viewer';

export interface Member {
  id: string;
  userId: string;
  name: string;
  email: string;
  role: MemberRole;
  avatarUrl?: string;
}

export const membersApi = {
  list(projectId: string) {
    return apiGet<{ members: Member[] }>(`/projects/${projectId}/members`);
  },
  setRole(projectId: string, memberId: string, role: MemberRole) {
    return apiPatch<Member>(`/projects/${projectId}/members/${memberId}`, {
      role,
    });
  },
  remove(projectId: string, memberId: string) {
    return apiDelete(`/projects/${projectId}/members/${memberId}`);
  },
};
