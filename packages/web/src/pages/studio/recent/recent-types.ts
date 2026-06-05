// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/** Whether a recent item is a project or an asset group (collection). */
export type RecentItemKind = 'project' | 'collection';

/** The caller's role on a recent item (studio redesign role names). */
export type RecentItemRole = 'owner' | 'editor' | 'viewer';

/**
 * A project or asset group the user recently opened, aggregated across all
 * studios for the cross-studio "Recent" landing (`/studio/recent`). Because
 * the landing spans studios, each item carries its source studio so the card
 * can label provenance (spec §2.1).
 */
export interface RecentItem {
  /** Stable UUID primary key (URL design: project/collection use UUID). */
  id: string;
  kind: RecentItemKind;
  /** Hand-written english url slug (not unique; uuid disambiguates). */
  slug: string;
  /** Display name (may be non-latin; may repeat). */
  name: string;
  thumbnailUrl: string | null;
  /** ISO-8601 timestamp this user last opened the item (per-user, spec §2.1). */
  lastOpenedAt: string;
  studioId: string;
  /** Source studio display name, shown as the card provenance label. */
  studioName: string;
  myRole: RecentItemRole;
}

/** A studio shown in the top-bar switcher. */
export interface StudioSummary {
  id: string;
  /** Globally-unique studio slug (URL design: studio slug is the locator). */
  slug: string;
  name: string;
  type: 'personal' | 'team';
  /** Member count for team studios; `null` for personal (single-member). */
  memberCount: number | null;
}
