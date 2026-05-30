import { apiGet, apiPatch, apiPost } from '@web/data/api/request';

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

/**
 * `listPendingByProject` returns this richer shape — the server
 * joins users so the BellMenu can show real display names + emails
 * without a second N+1 lookup.
 */
export interface AccessRequestWithRequester extends AccessRequest {
  requester: {
    id: string;
    username: string | null;
    email: string;
  };
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
   * via requireRole('owner') — non-owners get 403). Server joins
   * users so each row carries the requester's username + email.
   */
  listPendingByProject(projectId: string) {
    return apiGet<{ data: AccessRequestWithRequester[] }>(
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
    return apiGet<{ data: AccessRequest[] }>('/users/me/access-requests');
  },
};
