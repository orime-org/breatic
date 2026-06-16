// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type { RecentFeedItem } from '@web/data/api/studios';
import type { RecentItem } from '@web/pages/studio/recent/recent-types';

/**
 * Map a `GET /studios/recent` wire row to the Recent landing's view model.
 *
 * The wire contract (`RecentFeedItem`, derived from shared) is project-only in
 * V1 — collections are deferred — so `kind` is always `'project'` and the card
 * URL is `/project/{slug}-{id}`. A wire `myRole` of `null` (a studio-visible
 * project admitted via open baseline with no membership row) maps to `viewer`,
 * the effective access level. Keeps the wire→view derivation in one place (the
 * same split as the canvas `node-view`), so `RecentCard` consumes only the view
 * shape and never the raw wire row.
 * @param item - one recent-feed row from the server.
 * @returns the view-model recent item for `RecentCard`.
 */
export function toRecentItemView(item: RecentFeedItem): RecentItem {
  return {
    id: item.projectId,
    kind: 'project',
    slug: item.slug,
    name: item.name,
    thumbnailUrl: item.thumbnailUrl,
    lastOpenedAt: item.lastOpenedAt,
    studioId: item.studioId,
    studioName: item.studioName,
    myRole: item.myRole ?? 'viewer',
  };
}
