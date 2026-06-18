// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { apiDelete, apiGet, apiPatch } from '@web/data/api/request';

export type MemberRole = 'owner' | 'editor' | 'viewer';

/**
 * The role relation row returned by `GET /projects/:id/members` (v10 §7.2.6).
 * This endpoint carries the membership role ONLY — no name/email. Profiles
 * are fetched separately via `usersApi.getByIds` and merged into `Member`.
 */
export interface ProjectMembership {
  userId: string;
  role: MemberRole;
}

/**
 * The merged member shape MembersStack consumes: the role relation joined
 * with the user profile (name / email / avatar). Produced client-side by
 * `useProjectMembers`, not returned by any single endpoint.
 */
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
    return apiGet<ProjectMembership[]>(`/projects/${projectId}/members`);
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
