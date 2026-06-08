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
  ProjectSummary,
  StudioDetail,
  StudioMemberSummary,
  StudioSummary,
} from '@breatic/shared';

/** A studio role an admin may grant by invite or change-role (never admin). */
export type GrantableStudioRole = 'creator' | 'member';

/** Body for `POST /studio/:slug/members` — a registered email + granted role. */
export interface InviteMemberBody {
  email: string;
  role: GrantableStudioRole;
}

/** Body for `PATCH /studio/:slug/members/:userId` — creator ↔ member only. */
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
   * `GET /api/v1/studio/:slug` — one studio's public-facing shell, with the
   * viewer's role (`admin` / `member` / `null` = guest). Rejects with a 404
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
   * `GET /api/v1/studio/:slug/members` — the studio's active members for the
   * Members tab (display name / email / role / join date). A personal studio
   * returns exactly its owner; a team studio returns all members.
   * @param slug the studio's URL handle.
   * @returns the member summaries.
   */
  listMembers(slug: string): Promise<StudioMemberSummary[]> {
    return apiGet<StudioMemberSummary[]>(`/studio/${slug}/members`);
  },
  /**
   * `POST /api/v1/studio/:slug/members` — invite a registered user (by email)
   * into the studio with a `creator` / `member` role. Admin-only; takes effect
   * immediately. Rejects with a typed `ApiException`: `404` unregistered email,
   * `409` already a member, `403` personal studio / caller not admin, `422`
   * invalid body.
   * @param slug the studio's URL handle.
   * @param body the invitee's email + the granted role.
   * @returns once the invite has been recorded.
   */
  inviteMember(slug: string, body: InviteMemberBody): Promise<{ ok: true }> {
    return apiPost<{ ok: true }, InviteMemberBody>(
      `/studio/${slug}/members`,
      body,
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
   * (creator ↔ member). Admin-only; admin grant/demote goes through
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
};
