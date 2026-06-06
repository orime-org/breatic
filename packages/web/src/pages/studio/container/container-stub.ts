// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

//
// ⚠️ STUB DATA — Studio redesign slice 3 (frontend-on-stub).
//
// The studio container backend (`GET /studio/{slug}` and its tab data) does
// not exist yet. Per the implementation plan (Phase 1.1 = frontend visuals
// first, against a stub; Phase 2 = wire the real backend), this module
// hand-fakes one studio's container view so the 5 tabs can be built and
// visually verified before the API lands.
//
// The fixtures deliberately span the branches the spec §4 invariants exercise:
// private + studio-visible projects, owner/editor/viewer roles, a team studio
// (Members tab + paid-only wallet) and a personal studio (no Members tab +
// gift lots incl. a near-expiry one).
//
// REPLACE with a real `data/api/studio.ts` client (React Query) in Phase 2.
// Do NOT treat this as the live data source.
//

import type {
  StudioContainerView,
} from '@web/pages/studio/container/container-types';

/** STUB — a team studio: Members tab present, paid-only wallet (no gift). */
const STUB_TEAM_STUDIO: StudioContainerView = {
  studio: {
    id: 's-acme',
    slug: 'acme-studio',
    name: 'Acme Studio',
    type: 'team',
    memberCount: 4,
    myStudioRole: 'admin',
  },
  projects: [
    {
      id: '8f2a1c40-0001-4a10-9c01-000000000001',
      slug: 'cyberpunk-alley',
      name: 'Cyberpunk Alley',
      thumbnailUrl: null,
      visibility: 'studio',
      myRole: 'owner',
      isOwner: true,
    },
    {
      id: '8f2a1c40-0002-4a10-9c01-000000000002',
      slug: 'brand-launch-keyframes',
      name: 'Brand Launch Keyframes',
      thumbnailUrl: null,
      visibility: 'studio',
      myRole: 'editor',
      isOwner: false,
    },
    {
      id: '8f2a1c40-0003-4a10-9c01-000000000003',
      slug: 'q3-campaign-secret',
      name: 'Q3 Campaign (Secret)',
      thumbnailUrl: null,
      visibility: 'private',
      myRole: 'owner',
      isOwner: true,
    },
  ],
  collections: [
    {
      id: '8f2a1c40-1001-4a10-9c01-000000000011',
      slug: 'reference-moodboard',
      name: 'Reference Moodboard',
      previewThumbnails: [],
      assetCount: 24,
      kind: 'image',
      visibility: 'studio',
      myRole: 'editor',
      isOwner: false,
    },
    {
      id: '8f2a1c40-1002-4a10-9c01-000000000012',
      slug: 'launch-trailer-clips',
      name: 'Launch Trailer Clips',
      previewThumbnails: [],
      assetCount: 9,
      kind: 'video',
      visibility: 'studio',
      myRole: 'owner',
      isOwner: true,
    },
  ],
  members: [
    {
      id: 'u-alex',
      name: 'Alex',
      email: 'alex@acme.example',
      avatarUrl: null,
      studioRole: 'admin',
      joinedAt: '2026-04-01T08:00:00.000Z',
    },
    {
      id: 'u-mira',
      name: 'Mira',
      email: 'mira@acme.example',
      avatarUrl: null,
      studioRole: 'member',
      joinedAt: '2026-04-12T08:00:00.000Z',
    },
    {
      id: 'u-jon',
      name: 'Jon',
      email: 'jon@acme.example',
      avatarUrl: null,
      studioRole: 'member',
      joinedAt: '2026-05-02T08:00:00.000Z',
    },
    {
      id: 'u-lee',
      name: 'Lee',
      email: 'lee@acme.example',
      avatarUrl: null,
      studioRole: 'member',
      joinedAt: '2026-05-20T08:00:00.000Z',
    },
  ],
  wallet: {
    balanceCached: 8000,
    paidLots: [
      {
        id: 'lot-paid-1',
        source: 'paid',
        amountInitial: 10000,
        amountRemaining: 8000,
        isRefundable: true,
        expiresAt: null,
      },
    ],
    giftLots: [],
    ledger: [
      {
        id: 'lg-1',
        type: 'spend',
        amount: -120,
        description: 'Cyberpunk Alley',
        createdAt: '2026-06-05T05:40:00.000Z',
      },
      {
        id: 'lg-2',
        type: 'topup',
        amount: 10000,
        description: 'Credit pack',
        createdAt: '2026-06-01T10:00:00.000Z',
      },
    ],
  },
};

/** STUB — a personal studio: no Members tab, gift lots incl. a near-expiry one. */
const STUB_PERSONAL_STUDIO: StudioContainerView = {
  studio: {
    id: 's-personal',
    slug: 'alex',
    name: 'Alex',
    type: 'personal',
    memberCount: 1,
    myStudioRole: 'admin',
  },
  projects: [
    {
      id: '8f2a1c40-0004-4a10-9c01-000000000004',
      slug: 'album-cover-draft',
      name: 'Album Cover Draft',
      thumbnailUrl: null,
      visibility: 'studio',
      myRole: 'owner',
      isOwner: true,
    },
    {
      id: '8f2a1c40-0005-4a10-9c01-000000000005',
      slug: 'weekend-sketches',
      name: 'Weekend Sketches',
      thumbnailUrl: null,
      visibility: 'private',
      myRole: 'owner',
      isOwner: true,
    },
  ],
  collections: [
    {
      id: '8f2a1c40-1003-4a10-9c01-000000000013',
      slug: 'sound-fx-library',
      name: 'Sound FX Library',
      previewThumbnails: [],
      assetCount: 37,
      kind: 'audio',
      visibility: 'studio',
      myRole: 'owner',
      isOwner: true,
    },
  ],
  members: [],
  wallet: {
    balanceCached: 5200,
    paidLots: [
      {
        id: 'lot-paid-2',
        source: 'paid',
        amountInitial: 3000,
        amountRemaining: 2000,
        isRefundable: true,
        expiresAt: null,
      },
    ],
    giftLots: [
      {
        id: 'lot-gift-1',
        source: 'promo',
        amountInitial: 2000,
        amountRemaining: 1200,
        isRefundable: false,
        expiresAt: '2026-06-11T00:00:00.000Z',
      },
      {
        id: 'lot-gift-2',
        source: 'subscription',
        amountInitial: 2000,
        amountRemaining: 2000,
        isRefundable: false,
        expiresAt: '2026-07-20T00:00:00.000Z',
      },
    ],
    ledger: [
      {
        id: 'lg-3',
        type: 'grant',
        amount: 2000,
        description: 'Welcome bonus',
        createdAt: '2026-05-15T09:00:00.000Z',
      },
    ],
  },
};

const STUB_BY_SLUG: Readonly<Record<string, StudioContainerView>> = {
  'acme-studio': STUB_TEAM_STUDIO,
  alex: STUB_PERSONAL_STUDIO,
};

/**
 * STUB — resolve a studio container view by slug. Unknown slugs fall back to
 * the team studio so any `/studio/{slug}` route renders during slice 3
 * (Phase 2 replaces this with a real slug → studio lookup + 404 handling).
 * @param slug the studio slug from the `/studio/{slug}` route.
 * @returns the stubbed container view for that studio.
 */
export function getStubStudioView(slug: string): StudioContainerView {
  return STUB_BY_SLUG[slug] ?? STUB_TEAM_STUDIO;
}
