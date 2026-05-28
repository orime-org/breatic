import { apiGet, apiPatch, apiPost } from '@/data/api/request';

export type AccessRequestStatus = 'pending' | 'approved' | 'rejected';
export type RequestableRole = 'view' | 'edit';

export interface AccessRequest {
  id: string;
  projectId: string;
  requesterUserId: string;
  requestedRole: string;
  message: string | null;
  status: AccessRequestStatus;
  reviewedByUserId: string | null;
  reviewedAt: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface CreateAccessRequestBody {
  requested_role: RequestableRole;
  message?: string | null;
}

export interface DecideAccessRequestBody {
  decision: 'approved' | 'rejected';
}

export const accessRequestsApi = {
  /**
   * Submit a new access request (any authenticated caller). The
   * server refuses if the caller is already an active member of
   * the project (409 Conflict) or already has a pending request
   * (partial UNIQUE constraint).
   */
  create(projectId: string, body: CreateAccessRequestBody) {
    return apiPost<{ data: AccessRequest }, CreateAccessRequestBody>(
      `/projects/${projectId}/access-requests`,
      body,
    );
  },

  /**
   * List pending requests on a project. Owner-only (server enforces
   * via requireRole('owner') — non-owners get 403).
   */
  listPendingByProject(projectId: string) {
    return apiGet<{ data: AccessRequest[] }>(
      `/projects/${projectId}/access-requests`,
    );
  },

  /**
   * Approve or reject a pending request. Owner-only. Approving
   * atomically transitions status + inserts the requester as a
   * project member at the role they asked for.
   */
  decide(projectId: string, requestId: string, body: DecideAccessRequestBody) {
    return apiPatch<{ data: AccessRequest }, DecideAccessRequestBody>(
      `/projects/${projectId}/access-requests/${requestId}`,
      body,
    );
  },

  /**
   * List the caller's own access requests across all projects
   * (their personal status page). Self-scoped — no role gate.
   */
  listMine() {
    return apiGet<{ data: AccessRequest[] }>(`/users/me/access-requests`);
  },
};
