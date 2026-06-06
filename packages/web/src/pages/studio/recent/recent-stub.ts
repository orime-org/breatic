// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

//
// ⚠️ STUB DATA — Studio redesign slice 2 (frontend-on-stub).
//
// The cross-studio "Recent" backend (`GET /studio/recent`) does not exist yet.
// Per the implementation plan (Phase 1.1 = frontend visuals first, against a
// stub; Phase 2 = wire the real backend), this module hand-fakes the landing
// data so the UI can be built and visually verified before the API lands.
//
// REPLACE with a real `data/api/studio.ts` client (React Query) in Phase 2.
// Do NOT treat this as the live data source.
//

import type {
  RecentItem,
  StudioSummary,
} from '@web/pages/studio/recent/recent-types';

/** STUB — studios shown in the top-bar switcher (personal + teams). */
export const STUB_STUDIOS: readonly StudioSummary[] = [
  { id: 's-personal', slug: 'alex', name: 'Alex', type: 'personal', memberCount: 1 },
  { id: 's-acme', slug: 'acme-studio', name: 'Acme Studio', type: 'team', memberCount: 6 },
  { id: 's-nova', slug: 'nova-lab', name: 'Nova Lab', type: 'team', memberCount: 3 },
];

/** STUB — how many guest (shared-with-me) projects the viewer has (switcher count). */
export const STUB_GUEST_PROJECT_COUNT = 2;

/** STUB — recent projects across all studios (newest-opened first). */
export const STUB_RECENT_PROJECTS: readonly RecentItem[] = [
  {
    id: '8f2a1c40-0001-4a10-9c01-000000000001',
    kind: 'project',
    slug: 'cyberpunk-alley',
    name: 'Cyberpunk Alley',
    thumbnailUrl: null,
    lastOpenedAt: '2026-06-05T05:40:00.000Z',
    studioId: 's-acme',
    studioName: 'Acme Studio',
    myRole: 'owner',
  },
  {
    id: '8f2a1c40-0002-4a10-9c01-000000000002',
    kind: 'project',
    slug: 'album-cover-draft',
    name: 'Album Cover Draft',
    thumbnailUrl: null,
    lastOpenedAt: '2026-06-04T18:12:00.000Z',
    studioId: 's-personal',
    studioName: 'Alex',
    myRole: 'owner',
  },
  {
    id: '8f2a1c40-0003-4a10-9c01-000000000003',
    kind: 'project',
    slug: 'brand-launch-keyframes',
    name: 'Brand Launch Keyframes',
    thumbnailUrl: null,
    lastOpenedAt: '2026-06-03T09:30:00.000Z',
    studioId: 's-nova',
    studioName: 'Nova Lab',
    myRole: 'editor',
  },
];

/** STUB — recent collections (collections) across all studios. */
export const STUB_RECENT_COLLECTIONS: readonly RecentItem[] = [
  {
    id: '8f2a1c40-1001-4a10-9c01-000000000011',
    kind: 'collection',
    slug: 'reference-moodboard',
    name: 'Reference Moodboard',
    thumbnailUrl: null,
    lastOpenedAt: '2026-06-05T04:05:00.000Z',
    studioId: 's-acme',
    studioName: 'Acme Studio',
    myRole: 'editor',
  },
  {
    id: '8f2a1c40-1002-4a10-9c01-000000000012',
    kind: 'collection',
    slug: 'sound-fx-library',
    name: 'Sound FX Library',
    thumbnailUrl: null,
    lastOpenedAt: '2026-06-02T14:48:00.000Z',
    studioId: 's-personal',
    studioName: 'Alex',
    myRole: 'viewer',
  },
];
