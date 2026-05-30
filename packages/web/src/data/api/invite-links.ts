import { apiDelete, apiGet, apiPost } from '@web/data/api/request';

/** Roles an invite link can grant — every role except owner. */
export type RequestableRole = 'view' | 'edit';

/** Discriminator for the two share-link modes — see § 3 of the spec. */
export type InviteLinkKind = 'email' | 'link';

export interface InviteLink {
  id: string;
  projectId: string;
  createdByUserId: string;
  token: string;
  role: string;
  /**
   * Mode discriminator. UI branches on this, NOT on `boundEmail`
   * nullness — server DB CHECK keeps them paired, but `kind` is the
   * single source of truth so logic stays clear.
   */
  kind: InviteLinkKind;
  /**
   * Recipient email. Non-null iff `kind === 'email'`.
   */
  boundEmail: string | null;
  consumedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

/**
 * Create body — discriminated by `kind`:
 *   - kind='email': must include `invitee_email`. Server sends mail
 *     + creates a single-use, 7-day-TTL link bound to that address.
 *   - kind='link':  no `invitee_email`. Server creates a multi-use
 *     link with no expiry and returns the URL for manual copy/share.
 */
export type CreateInviteLinkBody =
  | { kind: 'email'; role: RequestableRole; invitee_email: string }
  | { kind: 'link'; role: RequestableRole };

export const inviteLinksApi = {
  /**
   * Create a new invite link. Owner-only.
   *
   * Two flows funnel through the same endpoint, distinguished by
   * the `kind` discriminator:
   *   - { kind: 'email', invitee_email } → single-use, server sends mail
   *   - { kind: 'link' }                 → multi-use, caller gets URL back
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
