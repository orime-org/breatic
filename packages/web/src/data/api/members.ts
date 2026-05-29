import { apiDelete, apiGet, apiPatch, apiPost } from '@web/data/api/request';

export type MemberRole = 'owner' | 'edit' | 'view';

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
  invite(projectId: string, body: { email: string; role: MemberRole }) {
    return apiPost<{ invite: { url: string; expiresAt: string } }>(
      `/projects/${projectId}/members/invite`,
      body,
    );
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
