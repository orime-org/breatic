// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Studio REST client — the container shell (slice 1) + member management
 * (slice 3).
 *
 * Plain async functions (the data layer stays React-free; the `useQuery` /
 * `useMutation` bindings live in the pages that consume these). Every endpoint
 * requires auth (the httpOnly session cookie rides along via `withCredentials`).
 */

import { apiDelete, apiGet, apiPatch, apiPost } from '@web/data/api/request';
import type {
  InvitationLandingView,
  ProjectSummary,
  RecentItem,
  Studio,
  StudioDetail,
  StudioMembersView,
  StudioSummary,
} from '@breatic/shared';

/**
 * One row of the `GET /api/v1/studios/recent` feed, as it arrives over the
 * wire: the shared {@link RecentItem} with `lastOpenedAt` as the JSON ISO
 * string (the shared type carries a `Date` for the server's in-memory entity;
 * JSON serializes it to a string). Derived from the shared contract so a field
 * change there flows here automatically — only the date representation differs.
 */
export type RecentFeedItem = Omit<RecentItem, 'lastOpenedAt'> & {
  lastOpenedAt: string;
};

/** Body for `POST /api/v1/studios` — display name + globally-unique slug. */
export interface CreateStudioBody {
  name: string;
  slug: string;
}

/** Response of `GET /api/v1/studios/slug-available`. */
export interface SlugAvailability {
  available: boolean;
  reason?: 'format' | 'length' | 'taken';
}

/** A studio role an admin may grant by invite or change-role (never admin). */
export type GrantableStudioRole = 'maintainer' | 'guest';

/** Body for `POST /studio/:slug/members` — a registered email + granted role. */
export interface InviteMemberBody {
  email: string;
  role: GrantableStudioRole;
}

/** Body for `PATCH /studio/:slug/members/:userId` — maintainer ↔ guest only. */
export interface ChangeMemberRoleBody {
  role: GrantableStudioRole;
}

/** Body for `POST /studio/:slug/transfer-admin` — the proposed new admin. */
export interface TransferAdminBody {
  toUserId: string;
}

export const studiosApi = {
  /**
   * `GET /api/v1/studios` — the current user's studios (switcher list),
   * personal-first.
   * @returns the user's studios as summaries.
   */
  listUserStudios(): Promise<StudioSummary[]> {
    return apiGet<StudioSummary[]>('/studios');
  },
  /**
   * `GET /api/v1/studios/recent` — the cross-studio "Recent" landing feed: the
   * projects the current user has opened, newest-first by their OWN last-open
   * time, filtered server-side to the ones they can still access. Backs the
   * `/studio` default landing.
   * @returns the viewer's accessible recent projects (empty when none opened).
   */
  getRecent(): Promise<RecentFeedItem[]> {
    return apiGet<RecentFeedItem[]>('/studios/recent');
  },
  /**
   * `POST /api/v1/studios` — create a team studio (display name + globally
   * unique slug). The creator becomes its admin. Rejects with a typed
   * `ApiException`: `409` slug taken or per-user limit reached, `422` invalid
   * body, `429` rate limited.
   * @param body the display name + slug.
   * @returns the freshly created team studio.
   */
  createStudio(body: CreateStudioBody): Promise<Studio> {
    return apiPost<Studio, CreateStudioBody>('/studios', body);
  },
  /**
   * `GET /api/v1/studios/slug-available?slug=` — live slug availability for the
   * create dialog's debounced indicator (and the onboarding slug page). A UX
   * helper; the authoritative uniqueness guard is the insert-time unique index,
   * so an "available" slug can still lose a race and surface as `409` on submit.
   * @param slug the candidate slug.
   * @param signal an `AbortSignal` so React Query can cancel a superseded check.
   * @returns whether the slug is available, with a reason when not.
   */
  checkSlugAvailable(slug: string, signal?: AbortSignal): Promise<SlugAvailability> {
    return apiGet<SlugAvailability>('/studios/slug-available', {
      params: { slug },
      signal,
    });
  },
  /**
   * `GET /api/v1/studio/:slug` — one studio's public-facing shell, with the
   * viewer's role (`admin` / `maintainer` / `guest` / `null` = non-member).
   * Rejects with a 404
   * `ApiException` when no active studio has that slug.
   * @param slug the studio's URL handle.
   * @returns the studio detail.
   */
  get(slug: string): Promise<StudioDetail> {
    return apiGet<StudioDetail>(`/studio/${slug}`);
  },
  /**
   * `GET /api/v1/studio/:slug/projects` — the studio's projects the viewer may
   * see (slice 2 open-baseline visibility, server-side filtered): a member
   * sees studio-visible projects + their own-role private ones, an admin sees
   * all, a guest gets an empty list. Each row carries the viewer's `myRole`
   * (`null` for a studio-visible project not yet entered).
   * @param slug the studio's URL handle.
   * @returns the visible project summaries.
   */
  listProjects(slug: string): Promise<ProjectSummary[]> {
    return apiGet<ProjectSummary[]>(`/studio/${slug}/projects`);
  },
  /**
   * `GET /api/v1/studio/:slug/members` — the Members tab view: active members
   * plus, for an admin viewer, the in-flight pending invitations (non-admins get
   * an empty `pendingInvitations`).
   * @param slug the studio's URL handle.
   * @returns the members + pending-invitations view.
   */
  listMembers(slug: string): Promise<StudioMembersView> {
    return apiGet<StudioMembersView>(`/studio/${slug}/members`);
  },
  /**
   * `POST /api/v1/studio/:slug/members` — invite a registered user (by email)
   * with a `maintainer` / `guest` role. Admin-only; creates a PENDING invite + an
   * actionable bell notification (and best-effort an email link). The invitee
   * becomes a member only on confirm. Rejects: `404` unregistered email, `409`
   * already a member / already invited, `403` personal / not admin, `422` body.
   * @param slug the studio's URL handle.
   * @param body the invitee's email + the granted role.
   * @returns once the invite has been created.
   */
  inviteMember(slug: string, body: InviteMemberBody): Promise<{ ok: true }> {
    return apiPost<{ ok: true }, InviteMemberBody>(
      `/studio/${slug}/members`,
      body,
    );
  },
  /**
   * `DELETE /api/v1/studio/:slug/invitations/:invitationId` — the admin revokes
   * a pending invite. Admin-only.
   * @param slug the studio's URL handle.
   * @param invitationId the pending invitation to revoke.
   * @returns once the invite has been revoked.
   */
  revokeInvitation(slug: string, invitationId: string): Promise<{ ok: true }> {
    return apiDelete<{ ok: true }>(
      `/studio/${slug}/invitations/${invitationId}`,
    );
  },
  /**
   * `DELETE /api/v1/studio/:slug/members/:userId` — remove (kick) a member.
   * Admin-only; clears their access across all the studio's projects and
   * transfers their owned projects to the acting admin. Rejects with `403`
   * personal / not admin, `404` not a member, `409` the sole admin.
   * @param slug the studio's URL handle.
   * @param userId the member to remove.
   * @returns once the member has been removed.
   */
  removeMember(slug: string, userId: string): Promise<{ ok: true }> {
    return apiDelete<{ ok: true }>(`/studio/${slug}/members/${userId}`);
  },
  /**
   * `PATCH /api/v1/studio/:slug/members/:userId` — change a member's role
   * (maintainer ↔ guest). Admin-only; admin grant/demote goes through
   * transfer-admin, not here. Rejects with `403`, `404`, or `409` (target is
   * the admin).
   * @param slug the studio's URL handle.
   * @param userId the member whose role changes.
   * @param body the new role.
   * @returns once the role has been updated.
   */
  updateMemberRole(
    slug: string,
    userId: string,
    body: ChangeMemberRoleBody,
  ): Promise<{ ok: true }> {
    return apiPatch<{ ok: true }, ChangeMemberRoleBody>(
      `/studio/${slug}/members/${userId}`,
      body,
    );
  },
  /**
   * `POST /api/v1/studio/:slug/transfer-admin` — ask an existing member to take
   * over as admin (step 1 of the two-step handshake). Admin-only; drops an
   * actionable notification in the recipient's inbox. No role change yet — that
   * lands when the recipient confirms via the notification action endpoint.
   * Rejects with `403`, `404` recipient not a member, `422` recipient is the
   * acting admin.
   * @param slug the studio's URL handle.
   * @param body the member proposed as the new admin.
   * @returns once the transfer request has been sent.
   */
  requestTransfer(slug: string, body: TransferAdminBody): Promise<{ ok: true }> {
    return apiPost<{ ok: true }, TransferAdminBody>(
      `/studio/${slug}/transfer-admin`,
      body,
    );
  },
  /**
   * `GET /api/v1/studio-invitations/:token` — the landing-page view for an email
   * invite link (studio + inviter names, role, `expired`, `isInvitee`).
   * Auth-only. Rejects with `404` when the token / invite is gone.
   * @param token the one-time token from the invite link.
   * @returns the invitation landing view.
   */
  getInvitation(token: string): Promise<InvitationLandingView> {
    return apiGet<InvitationLandingView>(`/studio-invitations/${token}`);
  },
  /**
   * `POST /api/v1/studio-invitations/respond` — confirm or decline an invite
   * from the email link; consumes the one-time token. Returns the studio slug
   * for the post-confirm redirect.
   * @param token the one-time token from the invite link.
   * @param action `confirm` to accept (and join), `decline` to refuse.
   * @returns the studio slug to redirect to on confirm.
   */
  respondInvitation(
    token: string,
    action: 'confirm' | 'decline',
  ): Promise<{ studioSlug: string }> {
    return apiPost<
      { studioSlug: string },
      { token: string; action: 'confirm' | 'decline' }
    >('/studio-invitations/respond', { token, action });
  },
};
