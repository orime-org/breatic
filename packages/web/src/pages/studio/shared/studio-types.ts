// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Shared studio-domain vocabulary used across the studio container, the
 * top-bar switcher, and the badge system.
 *
 * The API-contract types (`StudioType` / `StudioRole` / `StudioSummary` /
 * `StudioDetail`) are re-exported from `@breatic/shared` so the server and
 * the web speak one contract (`GET /studios` / `GET /studio/:slug`). The
 * item-level role / visibility types below are web-only UI vocabulary.
 */

export type {
  StudioType,
  StudioRole,
  StudioSummary,
  StudioDetail,
} from '@breatic/shared';

/** Project / collection-level role (DD §5.2). */
export type ItemRole = 'owner' | 'editor' | 'viewer';

/**
 * Project / collection visibility (DD §5.3): `studio` = baseline-visible to all
 * studio members, `private` = only invited people (Admin can still enter).
 */
export type ItemVisibility = 'studio' | 'private';
