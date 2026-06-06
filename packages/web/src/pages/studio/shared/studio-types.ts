// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Shared studio-domain types used across the studio container, the top-bar
 * switcher, and the badge system. Kept separate from `recent/recent-types`
 * (slice 2) so the container, switcher, and cards share one canonical
 * vocabulary for roles / visibility / studio identity.
 */

/** A studio is either the auto-created personal one or a team studio (DD §5.1). */
export type StudioType = 'personal' | 'team';

/** Studio-level role: single Admin (creator) + Members (DD §5.2). */
export type StudioRole = 'admin' | 'member';

/** Project / collection-level role (DD §5.2). */
export type ItemRole = 'owner' | 'editor' | 'viewer';

/**
 * Project / collection visibility (DD §5.3): `studio` = baseline-visible to all
 * studio members, `private` = only invited people (Admin can still enter).
 */
export type ItemVisibility = 'studio' | 'private';

/** A studio as shown in the top-bar switcher panel (spec §3.2). */
export interface StudioSummary {
  id: string;
  /** Globally-unique studio slug — the URL locator (no id; URL design §5.7). */
  slug: string;
  /** Display name (may be non-latin; may repeat). */
  name: string;
  type: StudioType;
  /** Member count for team studios; `null` for personal (single-member). */
  memberCount: number | null;
}
