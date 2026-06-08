// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

//
// Empty container-view skeleton — the studio container's per-tab data lands
// with each tab's own slice. Until those backends exist, the tabs render EMPTY
// (an honest empty state), NEVER faked data.
//
// What's already real (no skeleton needed):
//   - studio detail  → `GET /studio/:slug`            (slice 1, overrides `.studio` below)
//   - projects tab   → `GET /studio/:slug/projects`   (slice 2, replaces `.projects`)
//
// Still empty until their slices wire real APIs:
//   - collections → slice 5   ·   members → slice 3   ·   wallet/credits → slice 4
//
// (Historic: this module previously hand-faked one studio's view for the
// frontend-on-stub phase; the fake fixtures were removed 2026-06-08 once the
// real create/list flows landed, so the UI never shows invented data.)
//

import type { StudioContainerView } from '@web/pages/studio/container/container-types';

/**
 * The empty container view used before each tab's backend lands. `studio` is a
 * placeholder (StudioContainerPage overrides it with the real `GET /studio/:slug`);
 * `projects` is unused (the real projects API supplies them); `collections` /
 * `members` / `wallet` stay empty until slices 5 / 3 / 4 wire their real APIs —
 * each tab then shows its empty state rather than fabricated rows.
 * @returns an empty studio container view.
 */
export function getEmptyContainerView(): StudioContainerView {
  return {
    studio: {
      id: '',
      slug: '',
      name: '',
      type: 'team',
      memberCount: 0,
      myStudioRole: null,
    },
    projects: [],
    collections: [],
    members: [],
    wallet: {
      balanceCached: 0,
      paidLots: [],
      giftLots: [],
      ledger: [],
    },
  };
}
