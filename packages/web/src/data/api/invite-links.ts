import { apiDelete, apiGet, apiPost } from '@/data/api/request';

import type { RequestableRole } from '@/data/api/access-requests';

export interface InviteLink {
  id: string;
  projectId: string;
  createdByUserId: string;
  token: string;
  role: string;
  /**
   * If set, this link is bound to a specific email address and is
   * single-use (post-2026-05-28 spec § 3). NULL = Generate link
   * (multi-use, no expiry).
   */
  boundEmail: string | null;
  consumedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface CreateInviteLinkBody {
  role: RequestableRole;
  /**
   * If present, the server creates an email-invite (single-use,
   * bound to this email, 7-day TTL) and dispatches the mail. If
   * omitted, the server creates a Generate link (multi-use, no
   * expiry) and returns the URL for manual copy.
   */
  invitee_email?: string;
}

export const inviteLinksApi = {
  /**
   * Create a new invite link. Owner-only.
   *
   * Two flows funnel through the same endpoint:
   *   - email invite : include `invitee_email` → server sends mail
   *   - copy link    : omit `invitee_email` → caller gets URL back
   *
   * Server generates the token (32-byte base64url) — caller never
   * decides their own.
   */
  create(projectId: string, body: CreateInviteLinkBody) {
    return apiPost<{ data: InviteLink }, CreateInviteLinkBody>(
      `/projects/${projectId}/invite-links`,
      body,
    );
  },

  /**
   * List active (non-revoked) invite links for a project.
   * Owner-only.
   */
  listByProject(projectId: string) {
    return apiGet<{ data: InviteLink[] }>(
      `/projects/${projectId}/invite-links`,
    );
  },

  /**
   * Revoke (soft-delete) an invite link. Owner-only.
   */
  revoke(projectId: string, linkId: string) {
    return apiDelete<{ data: { ok: true } }>(
      `/projects/${projectId}/invite-links/${linkId}`,
    );
  },

  /**
   * Consume an invite link by token. Any authenticated user can
   * call. Server enforces single-use vs permanent semantics:
   *   - single-use: first consume marks consumed_at, subsequent
   *     visits get 403 Forbidden
   *   - permanent : idempotent; multiple consumes all succeed
   * Returns the resolved link so the client knows the project +
   * role to enroll the caller at.
   */
  consume(token: string) {
    return apiPost<{ data: InviteLink }, Record<string, never>>(
      `/invite-links/${token}/consume`,
      {},
    );
  },
};
