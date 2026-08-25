// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * View-model types for the studio container (`/studio/{slug}`, spec §2.2):
 * the studio detail, its projects / collections / members, and the credit
 * wallet shown across the 5 tabs. These mirror the DD §5 data model but are
 * shaped for rendering; Phase 2 maps the real API onto them.
 */

import type {
  ItemRole,
  ItemVisibility,
  StudioRole,
  StudioDetail,
} from '@web/pages/studio/shared/studio-types';

// `StudioDetail` is the shared API contract (`GET /studio/:slug`): the studio
// shell + the viewer's role (`myStudioRole`, `null` = non-member). Re-exported so
// the header / settings tab keep importing it from the container module.
export type { StudioDetail };

/** A project card in the studio container's Projects tab (spec §3.3). */
export interface ContainerProject {
  /** Stable UUID primary key (URL design: project uses UUID). */
  id: string;
  /** Hand-written english url slug (not unique; uuid disambiguates). */
  slug: string;
  name: string;
  thumbnailUrl: string | null;
  visibility: ItemVisibility;
  /** The viewer's role on this project, or `null` for studio baseline-only access (DD §5.3). Owner is derived as `myRole === 'owner'`; no redundant `isOwner` field. */
  myRole: ItemRole | null;
  /**
   * ISO-8601 creation timestamp, shown as the card's "created {time}" label.
   * The studio container is a catalog — it shows a stable creation time, NOT a
   * "last modified" time (canvas edits live in Yjs and never touch the project
   * row, so "modified" would be misleading). Recent-landing handles recency.
   */
  createdAt: string;
}

/** The dominant media kind of a collection, shown as a tag (spec §3.4). */
export type CollectionKind = 'image' | 'video' | 'audio';

/** A collection card in the Collections tab (spec §3.4) — a project-peer asset set. */
export interface ContainerCollection {
  /** Stable UUID primary key (URL design: collection uses UUID). */
  id: string;
  slug: string;
  name: string;
  /** 3–9 asset thumbnails composing the 4-grid preview (spec §3.4). */
  previewThumbnails: readonly string[];
  /** Total asset count, shown as "N assets". */
  assetCount: number;
  kind: CollectionKind;
  visibility: ItemVisibility;
  /** The viewer's role on this collection, or `null` for studio baseline-only access (DD §5.3). Owner is derived as `myRole === 'owner'`; no redundant `isOwner` field. */
  myRole: ItemRole | null;
}

/** A studio member in the Members tab (team studios only, spec §3.7). */
export interface StudioMember {
  id: string;
  name: string;
  email: string;
  avatarUrl: string | null;
  studioRole: StudioRole;
  /** ISO-8601 join timestamp. */
  joinedAt: string;
}

/** The full container view of one studio (stubbed in slice 3, real API in Phase 2). */
export interface StudioContainerView {
  studio: StudioDetail;
  projects: readonly ContainerProject[];
  collections: readonly ContainerCollection[];
  members: readonly StudioMember[];
}
